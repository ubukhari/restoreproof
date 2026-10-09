/**
 * The drill: back the database up with `pg_dump`, restore the backup into a throwaway Postgres of
 * the same major version, and compare the two (src/compare.ts). Or, with a file, restore a backup
 * someone already has and report what came back.
 *
 * The source is only read: one probe, one `pg_dump`, one READ ONLY transaction of catalog queries
 * and counts. The copy lives in a temporary directory and is gone when the drill returns.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCluster, type Cluster } from "./cluster.js";
import { compare, type Comparison, type Finding, type Previous } from "./compare.js";
import { fail, type CliError } from "./errors.js";
import { parseFacts, parseProbe, sum, type Facts, type Probe } from "./facts.js";
import { findAnyPsql, findNewestPgBin, findPgBin, pgEnv, run, tail, type PgBin } from "./pg.js";
import { NEVER_IN_COPY, listFrom, scopeFor, type Scope } from "./scope.js";
import { PROBE_SQL, PSQL_ARGS, factsSql, ident, literal } from "./sql.js";
import { dumpedFrom, filterToc, parseToc } from "./toc.js";
import {
  checkConnection,
  explainConnectError,
  parseDatabaseUrl,
  providerOf,
  type Connection,
  type Provider,
} from "./url.js";
import { VERSION } from "./version.js";

export type Env = Record<string, string | undefined>;

/** The variables a database URL is read from, in order, when none is named. */
export const URL_VARIABLES = ["RESTOREPROOF_DATABASE_URL", "DATABASE_URL"] as const;

export interface Source {
  conn: Connection;
  provider: Provider;
  probe: Probe;
  /** the variable the URL came from: its name, never its value */
  variable: string;
}

/** Read the URL from the environment (never an argument), parse it and refuse known traps. */
export function sourceUrl(env: Env, urlEnv?: string): { conn: Connection; variable: string } {
  const names = urlEnv ? [urlEnv] : [...URL_VARIABLES];
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) {
      const conn = parseDatabaseUrl(value);
      checkConnection(conn);
      return { conn, variable: name };
    }
  }
  throw fail(
    "NO_DATABASE_URL",
    urlEnv ? `${urlEnv} is not set` : `neither ${URL_VARIABLES.join(" nor ")} is set`,
    urlEnv
      ? `Set ${urlEnv} to the database's connection string in this shell (it is read from the environment, never from an argument).`
      : "Set RESTOREPROOF_DATABASE_URL to the database's connection string in this shell, e.g. `read -s RESTOREPROOF_DATABASE_URL && export RESTOREPROOF_DATABASE_URL`, so it stays out of your shell history.",
  );
}

/** Connect once and read what the drill needs: version, schemas, extensions, roles, RLS. */
export async function probeSource(
  env: Env,
  urlEnv: string | undefined,
  providerSetting: string | undefined,
): Promise<Source> {
  const { conn, variable } = sourceUrl(env, urlEnv);
  const provider = resolveProvider(providerSetting, conn.host);
  const psql = await findAnyPsql(env);
  const r = await run(psql, PSQL_ARGS, {
    env: pgEnv(env, conn.env),
    input: PROBE_SQL,
    timeoutMs: 120_000,
  });
  if (r.code !== 0) throw connectError(conn, r.stderr, env);
  return { conn, provider, probe: parseProbe(r.stdout), variable };
}

export function resolveProvider(setting: string | undefined, host: string): Provider {
  const s = (setting ?? "auto").trim().toLowerCase();
  if (s === "" || s === "auto") return providerOf(host);
  if (s === "supabase" || s === "neon" || s === "postgres") return s;
  throw fail(
    "BAD_PROVIDER",
    `RESTOREPROOF_PROVIDER is "${setting}"`,
    "Use auto, supabase, neon or postgres.",
  );
}

function connectError(conn: Connection, stderr: string, env: Env): CliError {
  return (
    explainConnectError(conn, stderr, env["GITHUB_ACTIONS"] === "true") ??
    fail(
      "SOURCE_CONNECT_FAILED",
      `could not read the database:\n${tail(stderr)}`,
      "Check that the URL's host is reachable from here and that its user can connect; the provider's dashboard shows the current connection string.",
      true,
    )
  );
}

export interface DrillOptions {
  env: Env;
  /** the variable holding the URL; default RESTOREPROOF_DATABASE_URL, then DATABASE_URL */
  urlEnv?: string;
  /** auto, supabase, neon or postgres */
  provider?: string;
  /** where the backup is written */
  outDir: string;
  maxRowDrift: number;
  maxShrink: number;
  previous?: Previous | null;
  excludeSchemas?: string[];
  skipExtensions?: string[];
  /** allow a newer major than the source's for the copy (a laptop); the workflow wants the same */
  allowNewerMajor: boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface DrillResult {
  tool: "restoreproof";
  version: string;
  at: string;
  mode: "live" | "file";
  ok: boolean;
  provider: Provider | null;
  /** the variable the URL came from */
  variable: string | null;
  source: {
    version: string;
    major: number;
    /** pg_database_size */
    bytes: number;
    schemas: string[];
    excludedSchemas: string[];
    excludedTableData: string[];
  } | null;
  backup: { file: string; bytes: number; seconds: number; tool: string } | null;
  restore: {
    ok: boolean;
    seconds: number;
    into: string;
    error: string | null;
    skippedExtensions: string[];
  };
  comparison: Comparison | null;
  /** tables and rows that came back, for a file restore (no source to compare with) */
  restored: {
    tables: number;
    rows: number;
    empty: string[];
    rowsByTable: Record<string, number>;
  } | null;
  findings: Finding[];
  previous: Previous | null;
}

const elapsed = (t0: number) => Math.round((Date.now() - t0) / 100) / 10;

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** pg_dump's pattern for an exact name: double-quoted, inner quotes doubled. */
const exact = (name: string) => `"${name.replace(/"/g, '""')}"`;
const exactTable = (qualifiedName: string) => {
  const dot = qualifiedName.indexOf(".");
  return `${exact(qualifiedName.slice(0, dot))}.${exact(qualifiedName.slice(dot + 1))}`;
};

/** The pg_dump arguments: custom format, no owners or grants, the scope's exclusions. */
export function dumpArgs(file: string, scope: Scope): string[] {
  return [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--no-subscriptions",
    "--lock-wait-timeout=120000",
    `--file=${file}`,
    ...scope.excludedSchemas.map((s) => `--exclude-schema=${exact(s)}`),
    ...scope.excludedTableData.map((t) => `--exclude-table-data=${exactTable(t)}`),
  ];
}

function dumpError(stderr: string, major: number): CliError {
  if (/server version mismatch|aborting because of server version/i.test(stderr))
    return fail(
      "PG_VERSION_SKEW",
      `pg_dump is older than the server:\n${tail(stderr, 3)}`,
      `Use pg_dump ${major} or newer.`,
    );
  if (/row-level security|row level security/i.test(stderr))
    return fail(
      "RLS_BLOCKS_DUMP",
      `row-level security hides rows from this role, so pg_dump stopped:\n${tail(stderr, 3)}`,
      "Back up as the tables' owner or a role with BYPASSRLS (on Supabase, the postgres user of the connection string the dashboard shows).",
    );
  if (/permission denied/i.test(stderr))
    return fail(
      "DUMP_PERMISSION_DENIED",
      `the role cannot read everything in the backup:\n${tail(stderr, 3)}`,
      "Back up as a role that can read every table, or leave the schema out with RESTOREPROOF_EXCLUDE_SCHEMAS.",
    );
  return fail(
    "DUMP_FAILED",
    `pg_dump failed:\n${tail(stderr)}`,
    "Read pg_dump's message above; run it again if the network dropped.",
    true,
  );
}

/** Make the database the backup restores into, and every role the backup names. */
async function prepareCopy(
  bin: PgBin,
  cluster: Cluster,
  roles: readonly string[],
  env: Env,
): Promise<Record<string, string>> {
  const admin = pgEnv(env, cluster.env);
  const sql = [
    "DROP DATABASE IF EXISTS restoretest;",
    "CREATE DATABASE restoretest;",
    ...roles.map(
      (r) =>
        `DO $rp$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(r)}) THEN CREATE ROLE ${ident(r)} NOLOGIN; END IF; END$rp$;`,
    ),
  ].join("\n");
  const r = await run(bin.path("psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    env: admin,
    input: sql,
    timeoutMs: 120_000,
  });
  if (r.code !== 0)
    throw fail(
      "COPY_PREPARE_FAILED",
      `could not prepare the throwaway copy:\n${tail(r.stderr)}`,
      "Run it again.",
      true,
    );
  return { ...cluster.env, PGDATABASE: "restoretest" };
}

async function availableExtensions(bin: PgBin, cluster: Cluster, env: Env): Promise<Set<string>> {
  const r = await run(bin.path("psql"), PSQL_ARGS, {
    env: pgEnv(env, cluster.env),
    input: "SELECT 'ext', name, '' FROM pg_available_extensions;",
    timeoutMs: 60_000,
  });
  return new Set(
    r.stdout
      .split("\0")
      .map((row) => row.split("\x1f")[1])
      .filter((n): n is string => !!n),
  );
}

const MISSING_ROLE = /role "([^"]+)" does not exist/;

interface RestoreOutcome {
  ok: boolean;
  seconds: number;
  error: string | null;
  skippedExtensions: string[];
  skippedForeign: number;
  target: Record<string, string>;
}

/**
 * Restore `file` into a fresh database of the copy. A role the backup names that the copy lacks is
 * created and the restore starts again, so a role is never the reason a backup "does not restore".
 */
async function restoreInto(
  bin: PgBin,
  cluster: Cluster,
  file: string,
  kind: "archive" | "sql",
  roles: string[],
  skip: (name: string) => boolean,
  env: Env,
): Promise<RestoreOutcome> {
  const known = [...roles];
  let skippedExtensions: string[] = [];
  let skippedForeign = 0;
  let listFile: string | null = null;
  if (kind === "archive") {
    const toc = await run(bin.path("pg_restore"), ["-l", file], {
      env: pgEnv(env, {}),
      timeoutMs: 300_000,
    });
    if (toc.code !== 0)
      return {
        ok: false,
        seconds: 0,
        error: tail(toc.stderr),
        skippedExtensions,
        skippedForeign,
        target: cluster.env,
      };
    const filtered = filterToc(toc.stdout, skip);
    skippedExtensions = filtered.skippedExtensions;
    skippedForeign = filtered.skippedForeign;
    listFile = path.join(cluster.dir, "restore.list");
    writeFileSync(listFile, filtered.list);
  }
  const t0 = Date.now();
  for (let attempt = 0; attempt < 25; attempt++) {
    const target = await prepareCopy(bin, cluster, known, env);
    const r =
      kind === "archive"
        ? await run(
            bin.path("pg_restore"),
            [
              "--no-owner",
              "--no-privileges",
              "--exit-on-error",
              `--use-list=${listFile!}`,
              "-d",
              "restoretest",
              file,
            ],
            { env: pgEnv(env, target), timeoutMs: 6 * 3600_000 },
          )
        : await run(bin.path("psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file], {
            env: pgEnv(env, target),
            timeoutMs: 6 * 3600_000,
          });
    if (r.code === 0)
      return {
        ok: true,
        seconds: elapsed(t0),
        error: null,
        skippedExtensions,
        skippedForeign,
        target,
      };
    const role = MISSING_ROLE.exec(r.stderr)?.[1];
    if (role && !known.includes(role)) {
      known.push(role);
      continue;
    }
    return {
      ok: false,
      seconds: elapsed(t0),
      error: tail(r.stderr, 8),
      skippedExtensions,
      skippedForeign,
      target,
    };
  }
  return {
    ok: false,
    seconds: elapsed(t0),
    error: "gave up after creating 25 missing roles",
    skippedExtensions,
    skippedForeign,
    target: cluster.env,
  };
}

async function readFacts(
  bin: PgBin,
  conn: Record<string, string>,
  schemas: string[],
  readOnly: boolean,
  env: Env,
): Promise<Facts> {
  const r = await run(bin.path("psql"), PSQL_ARGS, {
    env: pgEnv(env, conn),
    input: factsSql(schemas, { readOnly }),
    timeoutMs: 6 * 3600_000,
  });
  if (r.code !== 0)
    throw fail(
      "FACTS_FAILED",
      `could not read the catalog and counts:\n${tail(r.stderr)}`,
      "Run it again; if it persists, report it with the message above.",
      true,
    );
  return parseFacts(r.stdout);
}

function whyNotInCopy(name: string, available: Set<string>, extra: readonly string[]): string {
  if ((NEVER_IN_COPY as readonly string[]).includes(name))
    return "restoreproof never creates it in a throwaway copy, because it schedules work, makes requests or needs a server key";
  if (extra.includes(name)) return "RESTOREPROOF_SKIP_EXTENSIONS names it";
  if (!available.has(name))
    return "it is not installed where the copy runs; anything that needs it fails the restore and is named";
  return "skipped";
}

/** The whole drill on a live database. */
export async function drillLive(opts: DrillOptions): Promise<DrillResult> {
  const env = opts.env;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const at = now();
  const src = await probeSource(env, opts.urlEnv, opts.provider);
  const { probe, provider } = src;
  log(`source: PostgreSQL ${probe.version} (${provider}), read through ${src.variable}`);

  const scope = scopeFor(provider, probe.schemas, opts.excludeSchemas ?? []);
  const blocked = probe.rlsBlocked.filter((b) => scope.schemas.includes(b.schema));
  if (blocked.length)
    throw fail(
      "RLS_BLOCKS_DUMP",
      `row-level security would hide rows of ${blocked.length} table(s) from this role, so pg_dump would stop`,
      "Back up as the tables' owner or a role with BYPASSRLS (on Supabase, the postgres user of the connection string the dashboard shows).",
    );
  const bin = await findPgBin(probe.major, env, opts.allowNewerMajor);
  log(`tools: PostgreSQL ${bin.version} from ${bin.dir}`);

  mkdirSync(opts.outDir, { recursive: true });
  const file = path.join(opts.outDir, `restoreproof-${stamp(at)}.dump`);
  const t0 = Date.now();
  const dump = await run(bin.path("pg_dump"), dumpArgs(file, scope), {
    env: pgEnv(env, src.conn.env),
    timeoutMs: 6 * 3600_000,
  });
  if (dump.code !== 0) {
    rmSync(file, { force: true });
    throw dumpError(dump.stderr, probe.major);
  }
  const backup = {
    file,
    bytes: statSync(file).size,
    seconds: elapsed(t0),
    tool: `pg_dump ${bin.version}`,
  };
  log(`backup: ${backup.bytes} bytes in ${backup.seconds}s`);

  const sourceFacts = await readFacts(bin, src.conn.env, scope.schemas, true, env);
  log(
    `source facts: ${Object.keys(sourceFacts.rows).length} tables, ${sum(Object.values(sourceFacts.rows))} rows`,
  );

  const extra = opts.skipExtensions ?? [];
  const cluster = await startCluster({ bin, baseEnv: env });
  try {
    const available = await availableExtensions(bin, cluster, env);
    const skip = (name: string) =>
      (NEVER_IN_COPY as readonly string[]).includes(name) ||
      extra.includes(name) ||
      !available.has(name);
    const restore = await restoreInto(bin, cluster, file, "archive", probe.rolesUsed, skip, env);
    log(`restore: ${restore.ok ? "ok" : "failed"} in ${restore.seconds}s`);
    const into = `PostgreSQL ${bin.version}, a throwaway cluster on 127.0.0.1 with no other connections`;
    const skipped = restore.skippedExtensions.map((name) => ({
      name,
      why: whyNotInCopy(name, available, extra),
    }));
    const base: DrillResult = {
      tool: "restoreproof",
      version: VERSION,
      at: at.toISOString(),
      mode: "live",
      ok: false,
      provider,
      variable: src.variable,
      source: {
        version: probe.version,
        major: probe.major,
        bytes: probe.size,
        schemas: scope.schemas,
        excludedSchemas: scope.excludedSchemas,
        excludedTableData: scope.excludedTableData,
      },
      backup,
      restore: {
        ok: restore.ok,
        seconds: restore.seconds,
        into,
        error: restore.error,
        skippedExtensions: restore.skippedExtensions,
      },
      comparison: null,
      restored: null,
      findings: [],
      previous: opts.previous ?? null,
    };
    if (!restore.ok) {
      base.findings = [
        {
          level: "fail",
          code: "RESTORE_FAILED",
          message: `the backup did not restore:\n${restore.error ?? ""}`,
          // shown only where the run is public (render.ts), whose job log is public too
          summary:
            "the backup did not restore; pg_restore's message names the database's objects, so a public repository's run leaves it out: run `restoreproof check` where you keep the database URL to read it",
        },
        ...skipped.map((s) => ({
          level: "note" as const,
          code: "EXTENSION_NOT_IN_COPY",
          message: `extension ${s.name} was not created in the copy: ${s.why}`,
          summary: `extension ${s.name} was not created in the copy: ${s.why}`,
        })),
      ];
      return base;
    }
    const copyFacts = await readFacts(bin, restore.target, scope.schemas, false, env);
    // tables whose rows the backup leaves out by design are compared by definition only
    const leftOut = scope.excludedTableData.filter((t) => t in sourceFacts.rows);
    for (const t of leftOut) {
      delete sourceFacts.rows[t];
      delete copyFacts.rows[t];
    }
    const comparison = compare(sourceFacts, copyFacts, {
      maxRowDrift: opts.maxRowDrift,
      maxShrink: opts.maxShrink,
      backupBytes: backup.bytes,
      previous: opts.previous ?? null,
      skippedExtensions: skipped,
      skippedForeign: restore.skippedForeign,
    });
    if (leftOut.length) {
      const note = `the rows of ${leftOut.join(", ")} are left out of the backup by design, as platform data Supabase writes for itself (its own restore guide leaves out the Storage vector tables); their definitions are checked`;
      comparison.findings.push({
        level: "note",
        code: "TABLE_DATA_LEFT_OUT",
        message: note,
        summary: `the rows of ${leftOut.length} Supabase platform table(s) are left out of the backup by design; their definitions are checked`,
      });
    }
    const asked = scope.excludedSchemas.filter((s) => (opts.excludeSchemas ?? []).includes(s));
    const platform = scope.excludedSchemas.filter((s) => !asked.includes(s));
    if (platform.length) {
      const note = `${platform.length} Supabase platform schema(s) left out of the backup, as \`supabase db dump\` does: ${platform.join(", ")}`;
      comparison.findings.push({
        level: "note",
        code: "SCHEMAS_LEFT_OUT",
        message: note,
        summary: note,
      });
    }
    if (asked.length) {
      const note = `RESTOREPROOF_EXCLUDE_SCHEMAS left ${asked.length} schema(s) out of the backup: ${asked.join(", ")}`;
      comparison.findings.push({
        level: "note",
        code: "SCHEMAS_LEFT_OUT",
        message: note,
        summary: `RESTOREPROOF_EXCLUDE_SCHEMAS left ${asked.length} schema(s) out of the backup`,
      });
    }
    return { ...base, ok: comparison.ok, comparison, findings: comparison.findings };
  } finally {
    await cluster.stop();
  }
}

/** What kind of file a backup is: a pg_dump archive (custom, tar or directory) or plain SQL. */
export function backupKind(file: string): "archive" | "sql" {
  const st = statSync(file);
  if (st.isDirectory()) return "archive";
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(512);
    const n = readSync(fd, head, 0, 512, 0);
    if (n >= 5 && head.subarray(0, 5).toString("latin1") === "PGDMP") return "archive";
    if (n >= 262 && head.subarray(257, 262).toString("latin1") === "ustar") return "archive";
    return "sql";
  } finally {
    closeSync(fd);
  }
}

/** "17.6" from a plain dump's "-- Dumped from database version 17.6" line. */
export function sqlDumpedFrom(file: string): string | null {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, 4096, 0);
    const m = /Dumped from database version (\d+(?:\.\d+)?)/.exec(
      head.subarray(0, n).toString("utf8"),
    );
    return m ? m[1]! : null;
  } finally {
    closeSync(fd);
  }
}

export interface FileDrillOptions {
  env: Env;
  file: string;
  skipExtensions?: string[];
  now?: () => Date;
  log?: (line: string) => void;
}

/** Restore a backup someone already has into a throwaway copy, and report what came back. */
export async function drillFile(opts: FileDrillOptions): Promise<DrillResult> {
  const env = opts.env;
  const log = opts.log ?? (() => undefined);
  const at = (opts.now ?? (() => new Date()))();
  if (!existsSync(opts.file))
    throw fail(
      "BACKUP_NOT_FOUND",
      `there is no file or directory at ${opts.file}`,
      "Pass the path of a pg_dump archive or .sql file.",
    );
  const kind = backupKind(opts.file);
  let from: string | null = kind === "sql" ? sqlDumpedFrom(opts.file) : null;
  if (kind === "archive") {
    const newest = await findNewestPgBin(env).catch(() => null);
    if (newest) {
      const toc = await run(newest.path("pg_restore"), ["-l", opts.file], {
        env: pgEnv(env, {}),
        timeoutMs: 300_000,
      });
      if (toc.code === 0) from = dumpedFrom(parseToc(toc.stdout).header);
    }
  }
  const bin = from
    ? await findPgBin(Number(from.split(".")[0]), env, true)
    : await findNewestPgBin(env);
  log(
    `backup: ${kind === "sql" ? "plain SQL" : "pg_dump archive"}${from ? ` from PostgreSQL ${from}` : ""}; restoring with PostgreSQL ${bin.version}`,
  );
  const extra = opts.skipExtensions ?? [];
  const cluster = await startCluster({ bin, baseEnv: env });
  try {
    const available = await availableExtensions(bin, cluster, env);
    const skip = (name: string) =>
      (NEVER_IN_COPY as readonly string[]).includes(name) ||
      extra.includes(name) ||
      !available.has(name);
    const restore = await restoreInto(bin, cluster, opts.file, kind, [], skip, env);
    const into = `PostgreSQL ${bin.version}, a throwaway cluster on 127.0.0.1 with no other connections`;
    const result: DrillResult = {
      tool: "restoreproof",
      version: VERSION,
      at: at.toISOString(),
      mode: "file",
      ok: restore.ok,
      provider: null,
      variable: null,
      source: null,
      backup: {
        file: opts.file,
        bytes: sizeOf(opts.file),
        seconds: 0,
        tool: kind === "sql" ? "plain SQL" : "pg_dump archive",
      },
      restore: {
        ok: restore.ok,
        seconds: restore.seconds,
        into,
        error: restore.error,
        skippedExtensions: restore.skippedExtensions,
      },
      comparison: null,
      restored: null,
      findings: [],
      previous: null,
    };
    if (!restore.ok) {
      result.findings = [
        {
          level: "fail",
          code: "RESTORE_FAILED",
          message: `the backup did not restore:\n${restore.error ?? ""}`,
          summary: "the backup did not restore",
        },
      ];
      return result;
    }
    const schemas = await userSchemas(bin, restore.target, env);
    const facts = await readFacts(bin, restore.target, schemas, false, env);
    const rows = facts.rows;
    const empty = Object.keys(rows)
      .filter((t) => rows[t] === 0)
      .sort();
    result.restored = {
      tables: Object.keys(rows).length,
      rows: sum(Object.values(rows)),
      empty,
      rowsByTable: rows,
    };
    if (Object.keys(rows).length === 0)
      result.findings.push({
        level: "fail",
        code: "NOTHING_RESTORED",
        message: "the backup restored without error but holds no tables",
        summary: "the backup restored without error but holds no tables",
      });
    else if (empty.length)
      result.findings.push({
        level: "note",
        code: "EMPTY_TABLES",
        message: `${empty.length} table(s) restored empty; check that they should be: ${empty.slice(0, 8).join(", ")}${empty.length > 8 ? ` and ${empty.length - 8} more` : ""}`,
        summary: `${empty.length} table(s) restored empty`,
      });
    for (const name of restore.skippedExtensions)
      result.findings.push({
        level: "note",
        code: "EXTENSION_NOT_IN_COPY",
        message: `extension ${name} was not created in the copy: ${whyNotInCopy(name, available, extra)}`,
        summary: `extension ${name} was not created in the copy`,
      });
    result.ok = !result.findings.some((f) => f.level === "fail");
    return result;
  } finally {
    await cluster.stop();
  }
}

function sizeOf(file: string): number {
  const st = statSync(file);
  return st.isDirectory() ? 0 : st.size;
}

async function userSchemas(bin: PgBin, conn: Record<string, string>, env: Env): Promise<string[]> {
  const r = await run(bin.path("psql"), PSQL_ARGS, {
    env: pgEnv(env, conn),
    input: PROBE_SQL,
    timeoutMs: 60_000,
  });
  return parseProbe(r.stdout).schemas;
}

/** A directory for a backup that is deleted after the drill: the OS temp directory. */
export function scratchDir(): string {
  return mkdtempSync(path.join(tmpdir(), "restoreproof-backup-"));
}

export { listFrom };
