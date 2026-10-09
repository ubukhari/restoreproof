/**
 * PostgreSQL's own programs, found on this machine and run with the connection in their
 * environment. `pg_dump` refuses a server newer than itself, and a restore test means most in the
 * same major version as the source, so the drill looks for the source's major first.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";

export const TOOLS = ["pg_dump", "pg_restore", "psql", "initdb", "pg_ctl"] as const;
export type Tool = (typeof TOOLS)[number];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** true when the timeout killed it */
  timedOut: boolean;
}

export interface RunOptions {
  env: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
  cwd?: string;
}

/** The environment a PostgreSQL program gets: ours, minus every PG* variable we did not set. */
export function pgEnv(
  base: Record<string, string | undefined>,
  pg: Record<string, string>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) if (!/^PG/.test(k)) env[k] = v;
  // PGPASSFILE, PGSERVICE and friends from the caller's shell must not redirect the connection
  return { ...env, ...pg, PGCONNECT_TIMEOUT: pg["PGCONNECT_TIMEOUT"] ?? "30" };
}

/** Run a program to completion, collecting its output. Never throws for a non-zero exit. */
export function run(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: opts.env as NodeJS.ProcessEnv,
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Directories that hold PostgreSQL `major`'s programs on the systems people use. */
export function candidateDirs(major: number, env: Record<string, string | undefined>): string[] {
  const dirs = [
    `/usr/lib/postgresql/${major}/bin`,
    `/opt/homebrew/opt/postgresql@${major}/bin`,
    `/usr/local/opt/postgresql@${major}/bin`,
    `/Applications/Postgres.app/Contents/Versions/${major}/bin`,
    `/usr/pgsql-${major}/bin`,
  ];
  const fromPath = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  return [...dirs, ...fromPath];
}

/** The majors installed under /usr/lib/postgresql or Homebrew, newest first. */
export function installedMajors(): number[] {
  const found = new Set<number>();
  for (const root of ["/usr/lib/postgresql", "/opt/homebrew/opt", "/usr/local/opt"]) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      const m = /^(?:postgresql@)?(\d{2})$/.exec(n);
      if (m) found.add(Number(m[1]));
    }
  }
  return [...found].sort((a, b) => b - a);
}

export interface PgBin {
  dir: string;
  major: number;
  /** e.g. "17.6" */
  version: string;
  path(tool: Tool): string;
}

/** `pg_dump (PostgreSQL) 17.6 (Homebrew)` → 17.6; `16beta1` → 16. */
export function parseToolVersion(text: string): { major: number; version: string } | null {
  const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), version: m[2] === undefined ? m[1]! : `${m[1]}.${m[2]}` };
}

async function versionIn(dir: string, env: Record<string, string | undefined>) {
  const file = path.join(dir, "pg_dump");
  if (!TOOLS.every((t) => executable(path.join(dir, t)))) return null;
  try {
    const r = await run(file, ["--version"], { env, timeoutMs: 10_000 });
    return r.code === 0 ? parseToolVersion(r.stdout) : null;
  } catch {
    return null;
  }
}

function bin(dir: string, v: { major: number; version: string }): PgBin {
  return { dir, ...v, path: (tool) => path.join(dir, tool) };
}

/**
 * PostgreSQL's programs of exactly `major` (or, with `orNewer`, the nearest newer major found),
 * from RESTOREPROOF_PG_BIN or the usual places. Throws PG_BIN_NOT_FOUND or PG_VERSION_SKEW.
 */
export async function findPgBin(
  major: number,
  env: Record<string, string | undefined>,
  orNewer = false,
): Promise<PgBin> {
  const pinned = env["RESTOREPROOF_PG_BIN"];
  if (pinned) {
    const v = await versionIn(pinned, env);
    if (!v)
      throw fail(
        "PG_BIN_NOT_FOUND",
        `RESTOREPROOF_PG_BIN has no runnable ${TOOLS.join(", ")}`,
        "Point it at the bin directory of a PostgreSQL install, e.g. /usr/lib/postgresql/17/bin or /opt/homebrew/opt/postgresql@17/bin.",
      );
    if (v.major < major)
      throw fail(
        "PG_VERSION_SKEW",
        `the database runs PostgreSQL ${major}, and RESTOREPROOF_PG_BIN holds ${v.version}; pg_dump refuses a server newer than itself`,
        installHint(major),
      );
    if (v.major > major && !orNewer)
      throw fail(
        "PG_VERSION_SKEW",
        `the database runs PostgreSQL ${major}, and RESTOREPROOF_PG_BIN holds ${v.version}; the restore test uses the source's own major`,
        installHint(major),
      );
    return bin(pinned, v);
  }
  const majors = orNewer
    ? [
        major,
        ...installedMajors()
          .filter((m) => m > major)
          .reverse(),
      ]
    : [major];
  for (const want of majors)
    for (const dir of candidateDirs(want, env)) {
      const v = await versionIn(dir, env);
      if (v && v.major === want) return bin(dir, v);
    }
  throw fail(
    "PG_BIN_NOT_FOUND",
    `no PostgreSQL ${major} programs (${TOOLS.join(", ")}) were found on this machine; the database runs ${major}`,
    installHint(major),
  );
}

/** The newest PostgreSQL programs on this machine (RESTOREPROOF_PG_BIN first): for reading a backup of unknown version. */
export async function findNewestPgBin(env: Record<string, string | undefined>): Promise<PgBin> {
  if (env["RESTOREPROOF_PG_BIN"]) return findPgBin(0, env, true);
  for (const major of installedMajors()) {
    try {
      return await findPgBin(major, env);
    } catch {
      // try the next
    }
  }
  for (const dir of (env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    const v = await versionIn(dir, env);
    if (v) return bin(dir, v);
  }
  throw fail(
    "PG_BIN_NOT_FOUND",
    `no PostgreSQL programs (${TOOLS.join(", ")}) were found on this machine`,
    installHint(17),
  );
}

export function installHint(major: number): string {
  return (
    `Install PostgreSQL ${major}: \`brew install postgresql@${major}\` on macOS, or ` +
    `\`sudo apt-get install postgresql-${major}\` from the PostgreSQL apt repository on Debian and Ubuntu; ` +
    `or point RESTOREPROOF_PG_BIN at its bin directory.`
  );
}

/** Any `psql`, to read the server's version before the right major is known. */
export async function findAnyPsql(env: Record<string, string | undefined>): Promise<string> {
  const dirs = [
    ...(env["RESTOREPROOF_PG_BIN"] ? [env["RESTOREPROOF_PG_BIN"]] : []),
    ...installedMajors().flatMap((m) => candidateDirs(m, {}).slice(0, 5)),
    ...(env["PATH"] ?? "").split(path.delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    const file = path.join(dir, "psql");
    if (executable(file)) return file;
  }
  throw fail(
    "PSQL_NOT_FOUND",
    "no psql was found on this machine, so the server's version cannot be read",
    "Install the PostgreSQL client (`brew install libpq` or `sudo apt-get install postgresql-client`), or point RESTOREPROOF_PG_BIN at a PostgreSQL bin directory.",
  );
}

/** The last few lines of a program's error output, for a report: never the environment. */
export function tail(text: string, lines = 6): string {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}
