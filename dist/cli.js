#!/usr/bin/env node

// src/main.ts
import { readFileSync as readFileSync4, rmSync as rmSync4 } from "fs";
import path7 from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

// src/ci.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync3 } from "fs";
import { tmpdir as tmpdir3 } from "os";
import path4 from "path";

// src/drill.ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync as mkdtempSync2,
  openSync,
  readSync,
  closeSync,
  rmSync as rmSync2,
  statSync,
  writeFileSync as writeFileSync2
} from "fs";
import { tmpdir as tmpdir2 } from "os";
import path3 from "path";

// src/cluster.ts
import { randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import path2 from "path";

// src/errors.ts
var CliError = class extends Error {
  code;
  cause;
  fix;
  retryable;
  /** 2 for a usage mistake, 1 for anything else */
  exitCode;
  constructor(p, exitCode = 1) {
    super(`${p.code}: ${p.cause}`);
    this.name = "CliError";
    this.code = p.code;
    this.cause = p.cause;
    this.fix = p.fix;
    this.retryable = p.retryable;
    this.exitCode = exitCode;
  }
  toJSON() {
    return { code: this.code, cause: this.cause, fix: this.fix, retryable: this.retryable };
  }
};
function usage(cause, fix) {
  return new CliError({ code: "BAD_ARGUMENTS", cause, fix, retryable: false }, 2);
}
function fail(code, cause, fix, retryable = false) {
  return new CliError({ code, cause, fix, retryable });
}

// src/pg.ts
import { spawn } from "child_process";
import { accessSync, constants, readdirSync } from "fs";
import path from "path";
var TOOLS = ["pg_dump", "pg_restore", "psql", "initdb", "pg_ctl"];
function pgEnv(base, pg) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!/^PG/.test(k)) env[k] = v;
  return { ...env, ...pg, PGCONNECT_TIMEOUT: pg["PGCONNECT_TIMEOUT"] ?? "30" };
}
function run(file, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = opts.timeoutMs === void 0 ? void 0 : setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
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
        timedOut
      });
    });
    child.stdin.on("error", () => void 0);
    child.stdin.end(opts.input ?? "");
  });
}
function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function candidateDirs(major, env) {
  const dirs = [
    `/usr/lib/postgresql/${major}/bin`,
    `/opt/homebrew/opt/postgresql@${major}/bin`,
    `/usr/local/opt/postgresql@${major}/bin`,
    `/Applications/Postgres.app/Contents/Versions/${major}/bin`,
    `/usr/pgsql-${major}/bin`
  ];
  const fromPath = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  return [...dirs, ...fromPath];
}
function installedMajors() {
  const found = /* @__PURE__ */ new Set();
  for (const root of ["/usr/lib/postgresql", "/opt/homebrew/opt", "/usr/local/opt"]) {
    let names;
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const n2 of names) {
      const m = /^(?:postgresql@)?(\d{2})$/.exec(n2);
      if (m) found.add(Number(m[1]));
    }
  }
  return [...found].sort((a, b) => b - a);
}
function parseToolVersion(text) {
  const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), version: m[2] === void 0 ? m[1] : `${m[1]}.${m[2]}` };
}
async function versionIn(dir, env) {
  const file = path.join(dir, "pg_dump");
  if (!TOOLS.every((t) => executable(path.join(dir, t)))) return null;
  try {
    const r = await run(file, ["--version"], { env, timeoutMs: 1e4 });
    return r.code === 0 ? parseToolVersion(r.stdout) : null;
  } catch {
    return null;
  }
}
function bin(dir, v) {
  return { dir, ...v, path: (tool) => path.join(dir, tool) };
}
async function findPgBin(major, env, orNewer = false) {
  const pinned = env["RESTOREPROOF_PG_BIN"];
  if (pinned) {
    const v = await versionIn(pinned, env);
    if (!v)
      throw fail(
        "PG_BIN_NOT_FOUND",
        `RESTOREPROOF_PG_BIN has no runnable ${TOOLS.join(", ")}`,
        "Point it at the bin directory of a PostgreSQL install, e.g. /usr/lib/postgresql/17/bin or /opt/homebrew/opt/postgresql@17/bin."
      );
    if (v.major < major)
      throw fail(
        "PG_VERSION_SKEW",
        `the database runs PostgreSQL ${major}, and RESTOREPROOF_PG_BIN holds ${v.version}; pg_dump refuses a server newer than itself`,
        installHint(major)
      );
    if (v.major > major && !orNewer)
      throw fail(
        "PG_VERSION_SKEW",
        `the database runs PostgreSQL ${major}, and RESTOREPROOF_PG_BIN holds ${v.version}; the restore test uses the source's own major`,
        installHint(major)
      );
    return bin(pinned, v);
  }
  const majors = orNewer ? [
    major,
    ...installedMajors().filter((m) => m > major).reverse()
  ] : [major];
  for (const want of majors)
    for (const dir of candidateDirs(want, env)) {
      const v = await versionIn(dir, env);
      if (v && v.major === want) return bin(dir, v);
    }
  throw fail(
    "PG_BIN_NOT_FOUND",
    `no PostgreSQL ${major} programs (${TOOLS.join(", ")}) were found on this machine; the database runs ${major}`,
    installHint(major)
  );
}
async function findNewestPgBin(env) {
  if (env["RESTOREPROOF_PG_BIN"]) return findPgBin(0, env, true);
  for (const major of installedMajors()) {
    try {
      return await findPgBin(major, env);
    } catch {
    }
  }
  for (const dir of (env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
    const v = await versionIn(dir, env);
    if (v) return bin(dir, v);
  }
  throw fail(
    "PG_BIN_NOT_FOUND",
    `no PostgreSQL programs (${TOOLS.join(", ")}) were found on this machine`,
    installHint(17)
  );
}
function installHint(major) {
  return `Install PostgreSQL ${major}: \`brew install postgresql@${major}\` on macOS, or \`sudo apt-get install postgresql-${major}\` from the PostgreSQL apt repository on Debian and Ubuntu; or point RESTOREPROOF_PG_BIN at its bin directory.`;
}
async function findAnyPsql(env) {
  const dirs = [
    ...env["RESTOREPROOF_PG_BIN"] ? [env["RESTOREPROOF_PG_BIN"]] : [],
    ...installedMajors().flatMap((m) => candidateDirs(m, {}).slice(0, 5)),
    ...(env["PATH"] ?? "").split(path.delimiter).filter(Boolean)
  ];
  for (const dir of dirs) {
    const file = path.join(dir, "psql");
    if (executable(file)) return file;
  }
  throw fail(
    "PSQL_NOT_FOUND",
    "no psql was found on this machine, so the server's version cannot be read",
    "Install the PostgreSQL client (`brew install libpq` or `sudo apt-get install postgresql-client`), or point RESTOREPROOF_PG_BIN at a PostgreSQL bin directory."
  );
}
function tail(text, lines = 6) {
  return text.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-lines).join("\n");
}

// src/cluster.ts
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
var live = /* @__PURE__ */ new Set();
var hooked = false;
function hookSignals() {
  if (hooked) return;
  hooked = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(sig, () => {
      void Promise.allSettled([...live].map((c) => c.stop())).then(() => process.exit(130));
    });
}
function serverLog(dir) {
  try {
    return readFileSync(path2.join(dir, "server.log"), "utf8");
  } catch {
    return "";
  }
}
async function startCluster(opts) {
  hookSignals();
  const dir = mkdtempSync(path2.join(opts.parent ?? tmpdir(), "restoreproof-"));
  const data = path2.join(dir, "data");
  const password = randomBytes(24).toString("hex");
  const pwfile = path2.join(dir, "pw");
  writeFileSync(pwfile, password + "\n", { mode: 384 });
  const env = { ...pgEnv(opts.baseEnv, {}), LC_ALL: "C" };
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const init = await run(
    opts.bin.path("initdb"),
    [
      "-D",
      data,
      "-U",
      "restoreproof",
      "--auth=scram-sha-256",
      `--pwfile=${pwfile}`,
      "-E",
      "UTF8",
      "--no-locale",
      "--no-sync"
    ],
    { env, timeoutMs: 12e4 }
  );
  rmSync(pwfile, { force: true });
  if (init.code !== 0) {
    remove();
    throw fail(
      "COPY_INIT_FAILED",
      `initdb could not make the throwaway cluster:
${tail(init.stderr)}`,
      "Check that the temporary directory is writable and has free space.",
      true
    );
  }
  let started = null;
  let lastErr = "";
  for (let attempt = 0; attempt < 3 && !started; attempt++) {
    const port = await freePort();
    const settings = [
      "listen_addresses=127.0.0.1",
      `port=${port}`,
      "unix_socket_directories=''",
      "fsync=off",
      "full_page_writes=off",
      "synchronous_commit=off",
      "max_wal_size=4GB",
      "checkpoint_timeout=30min",
      "max_locks_per_transaction=1024",
      "shared_preload_libraries=''",
      "log_min_messages=warning"
    ];
    const r = await run(
      opts.bin.path("pg_ctl"),
      [
        "-D",
        data,
        "-l",
        path2.join(dir, "server.log"),
        "-w",
        "-t",
        String(opts.waitSeconds ?? 60),
        "-o",
        settings.map((s2) => `-c ${s2}`).join(" "),
        "start"
      ],
      { env, timeoutMs: ((opts.waitSeconds ?? 60) + 15) * 1e3 }
    );
    if (r.code === 0) started = { port };
    else lastErr = tail([r.stderr || r.stdout, serverLog(dir)].join("\n"), 8);
  }
  if (!started) {
    remove();
    throw fail(
      "COPY_START_FAILED",
      `the throwaway cluster did not start:
${lastErr}`,
      "Run it again; if it persists, check free disk space and that 127.0.0.1 accepts connections.",
      true
    );
  }
  let stopped = false;
  const cluster = {
    port: started.port,
    dir,
    env: {
      PGHOST: "127.0.0.1",
      PGPORT: String(started.port),
      PGUSER: "restoreproof",
      PGPASSWORD: password,
      PGDATABASE: "postgres",
      PGSSLMODE: "disable"
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      live.delete(cluster);
      try {
        await run(
          opts.bin.path("pg_ctl"),
          ["-D", data, "-m", "immediate", "-w", "-t", "30", "stop"],
          { env, timeoutMs: 45e3 }
        );
      } finally {
        remove();
      }
    }
  };
  live.add(cluster);
  return cluster;
}

// src/compare.ts
import { createHash } from "crypto";

// src/sql.ts
var FIELD = "";
var PSQL_ARGS = [
  "-X",
  "-q",
  "-A",
  "-t",
  "-F",
  FIELD,
  "-0",
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  "-"
];
function literal(s2) {
  return `'${s2.replace(/'/g, "''")}'`;
}
function ident(s2) {
  return `"${s2.replace(/"/g, '""')}"`;
}
function schemaArray(schemas) {
  return schemas.length ? `ARRAY[${schemas.map(literal).join(", ")}]::text[]` : `ARRAY[]::text[]`;
}
var PROBE_SQL = `
SELECT 'version', current_setting('server_version_num'), current_setting('server_version');
SELECT 'role', (r.rolsuper OR r.rolbypassrls)::text, ''
  FROM pg_roles r WHERE r.rolname = current_user;
SELECT 'size', pg_database_size(current_database())::text, '';
SELECT 'schema', n.nspname, ''
  FROM pg_namespace n
 WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
 ORDER BY 2;
SELECT 'extension', e.extname, n.nspname
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname <> 'plpgsql'
 ORDER BY 2;
SELECT DISTINCT 'role_used', r::text, ''
  FROM pg_policies, unnest(roles) AS r
 WHERE r::text <> 'public';
SELECT DISTINCT 'role_used', usename::text, ''
  FROM pg_user_mappings
 WHERE usename::text <> 'public';
SELECT 'rls_blocked', n.nspname || '.' || c.relname, n.nspname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity
   AND NOT pg_has_role(c.relowner, 'USAGE')
   AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls));
`;
var memberOf = (cat, oid) => `EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${cat}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;
function factsSql(schemas, opts) {
  const S = schemaArray(schemas);
  const inScope = (nsp) => `${nsp}.nspname = ANY (${S})`;
  const body = `
SELECT 'table', n.nspname || '.' || c.relname,
       'kind=' || c.relkind::text || ' rls=' || c.relrowsecurity::text || ' force=' || c.relforcerowsecurity::text || ' persistence=' || c.relpersistence::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'rows', n.nspname || '.' || c.relname,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r' AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname,
       md5(format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' ||
           coalesce(pg_get_expr(ad.adbin, ad.adrelid), '') || '|' || a.attidentity::text || '|' ||
           a.attgenerated::text || '|' || coalesce(nullif(co.collname, 'default'), ''))
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  LEFT JOIN pg_collation co ON co.oid = a.attcollation
 WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
   AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'constraint', n.nspname || '.' || c.relname || '.' || con.conname, md5(pg_get_constraintdef(con.oid))
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE con.contype <> 'n' AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'index', n.nspname || '.' || i.relname, md5(pg_get_indexdef(i.oid))
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = i.relnamespace
 WHERE t.relkind IN ('r', 'p', 'm') AND ${inScope("n")} AND NOT ${memberOf("pg_class", "t.oid")};
SELECT CASE c.relkind WHEN 'v' THEN 'view' ELSE 'matview' END, n.nspname || '.' || c.relname,
       md5(pg_get_viewdef(c.oid))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('v', 'm') AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END,
       n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prokind = 'a' THEN '' ELSE md5(pg_get_functiondef(p.oid)) END
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE ${inScope("n")} AND NOT ${memberOf("pg_proc", "p.oid")};
SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, md5(pg_get_triggerdef(t.oid))
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'policy', n.nspname || '.' || c.relname || '.' || p.polname,
       md5(p.polcmd::text || '|' || p.polpermissive::text || '|' ||
           coalesce((SELECT string_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END, ',' ORDER BY 1)
                       FROM unnest(p.polroles) AS r), '') || '|' ||
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE ${inScope("n")};
SELECT 'sequence', n.nspname || '.' || c.relname, ''
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'S' AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'enum', n.nspname || '.' || t.typname, md5(string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder))
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE ${inScope("n")} AND NOT ${memberOf("pg_type", "t.oid")}
 GROUP BY n.nspname, t.typname;
SELECT 'domain', n.nspname || '.' || t.typname,
       md5(format_type(t.typbasetype, t.typtypmod) || '|' || t.typnotnull::text || '|' || coalesce(t.typdefault, '') || '|' ||
           coalesce((SELECT string_agg(pg_get_constraintdef(k.oid), ',' ORDER BY k.conname) FROM pg_constraint k WHERE k.contypid = t.oid), ''))
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE t.typtype = 'd' AND ${inScope("n")} AND NOT ${memberOf("pg_type", "t.oid")};
SELECT 'extension', e.extname, e.extversion
  FROM pg_extension e
 WHERE e.extname <> 'plpgsql';
SELECT 'meta', 'server_version', current_setting('server_version');
SELECT 'meta', 'server_version_num', current_setting('server_version_num');
`;
  return opts.readOnly ? `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL row_security = off;
${body}
COMMIT;
` : body;
}
function parseRows(stdout) {
  return stdout.split("\0").map((r) => r.replace(/^\n+/, "")).filter((r) => r.length > 0).map((r) => r.split(FIELD));
}

// src/facts.ts
function majorOf(versionNum) {
  return Math.floor(versionNum / 1e4);
}
function parseProbe(stdout) {
  const p = {
    versionNum: 0,
    version: "",
    major: 0,
    privileged: false,
    size: 0,
    schemas: [],
    extensions: [],
    rolesUsed: [],
    rlsBlocked: []
  };
  for (const [kind, a = "", b = ""] of parseRows(stdout)) {
    if (kind === "version") {
      p.versionNum = Number(a);
      p.version = b.split(" ")[0] ?? b;
      p.major = majorOf(p.versionNum);
    } else if (kind === "role") p.privileged = a === "true";
    else if (kind === "size") p.size = Number(a);
    else if (kind === "schema") p.schemas.push(a);
    else if (kind === "extension") p.extensions.push({ name: a, schema: b });
    else if (kind === "role_used" && !p.rolesUsed.includes(a)) p.rolesUsed.push(a);
    else if (kind === "rls_blocked") p.rlsBlocked.push({ table: a, schema: b });
  }
  return p;
}
var OBJECT_KINDS = [
  "table",
  "column",
  "constraint",
  "index",
  "view",
  "matview",
  "function",
  "procedure",
  "aggregate",
  "trigger",
  "policy",
  "sequence",
  "enum",
  "domain"
];
function parseFacts(stdout) {
  const f = { version: "", versionNum: 0, objects: {}, rows: {}, extensions: {} };
  for (const [kind = "", name = "", detail = ""] of parseRows(stdout)) {
    if (kind === "rows") f.rows[name] = Number(detail);
    else if (kind === "extension") f.extensions[name] = detail;
    else if (kind === "meta") {
      if (name === "server_version") f.version = detail.split(" ")[0] ?? detail;
      if (name === "server_version_num") f.versionNum = Number(detail);
    } else if (OBJECT_KINDS.includes(kind))
      f.objects[`${kind} ${name}`] = detail;
  }
  return f;
}
function sum(values) {
  let n2 = 0;
  for (const v of values) n2 += v;
  return n2;
}

// src/compare.ts
function hashName(name) {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}
var plural = (n2, one, many = `${one}s`) => `${n2.toLocaleString("en-US")} ${n2 === 1 ? one : many}`;
function allowance(live2, driftPct) {
  return Math.max(10, Math.floor(live2 * driftPct / 100));
}
function compare(source, restored, opts) {
  const findings = [];
  const sameMajor = majorOf(source.versionNum) === majorOf(restored.versionNum);
  let missing = 0;
  let changed = 0;
  const missingByKind = {};
  const changedByKind = {};
  const byKind = {};
  for (const [key, def] of Object.entries(source.objects)) {
    const kind = key.slice(0, key.indexOf(" "));
    const name = key.slice(kind.length + 1);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (!(key in restored.objects)) {
      missing++;
      (missingByKind[kind] ??= []).push(name);
    } else if (sameMajor && restored.objects[key] !== def) {
      changed++;
      (changedByKind[kind] ??= []).push(name);
    }
  }
  for (const kind of OBJECT_KINDS) {
    const m = missingByKind[kind];
    if (m?.length)
      findings.push({
        level: "fail",
        code: "OBJECT_MISSING",
        message: `${plural(m.length, kind)} of the source ${m.length === 1 ? "is" : "are"} not in the restored copy: ${list(m)}`,
        summary: `${plural(m.length, kind)} of the source ${m.length === 1 ? "is" : "are"} not in the restored copy`
      });
    const c = changedByKind[kind];
    if (c?.length)
      findings.push({
        level: "fail",
        code: "OBJECT_CHANGED",
        message: `${plural(c.length, kind)} restored with a different definition: ${list(c)}`,
        summary: `${plural(c.length, kind)} restored with a different definition`
      });
  }
  if (!sameMajor)
    findings.push({
      level: "note",
      code: "OTHER_MAJOR",
      message: `the copy runs PostgreSQL ${majorOf(restored.versionNum)} and the source ${majorOf(source.versionNum)}, so objects were compared by name, not definition`,
      summary: `the copy runs PostgreSQL ${majorOf(restored.versionNum)} and the source ${majorOf(source.versionNum)}, so objects were compared by name, not definition`
    });
  const tables = [];
  for (const [table, live2] of Object.entries(source.rows)) {
    const got = table in restored.rows ? restored.rows[table] : null;
    let verdict;
    if (got === null) verdict = "missing";
    else if (got === live2) verdict = "match";
    else if (got === 0 && live2 > 0) verdict = "empty";
    else if (Math.abs(got - live2) > allowance(live2, opts.maxRowDrift)) verdict = "differs";
    else verdict = "changed";
    tables.push({ table, live: live2, restored: got, verdict });
  }
  tables.sort((a, b) => a.table.localeCompare(b.table));
  const pick = (v) => tables.filter((t) => t.verdict === v);
  const empty = pick("empty");
  if (empty.length)
    findings.push({
      level: "fail",
      code: "TABLE_RESTORED_EMPTY",
      message: `${plural(empty.length, "table")} with rows in the source restored empty: ${list(empty.map((t) => `${t.table} (${t.live.toLocaleString("en-US")} rows)`))}`,
      summary: `${plural(empty.length, "table")} with rows in the source restored empty`
    });
  const differs = pick("differs");
  if (differs.length)
    findings.push({
      level: "fail",
      code: "ROWS_DIFFER",
      message: `${plural(differs.length, "table")} restored with more rows missing or extra than writes during the backup explain (over max(10, ${opts.maxRowDrift}%)): ${list(differs.map((t) => `${t.table} ${t.live.toLocaleString("en-US")} \u2192 ${t.restored.toLocaleString("en-US")}`))}`,
      summary: `${plural(differs.length, "table")} restored with more rows missing or extra than writes during the backup explain (over max(10, ${opts.maxRowDrift}%))`
    });
  const moved = pick("changed");
  if (moved.length)
    findings.push({
      level: "warn",
      code: "ROWS_CHANGED_DURING_BACKUP",
      message: `${plural(moved.length, "table")} changed between the backup and the count, within the allowance: ${list(moved.map((t) => `${t.table} ${t.live.toLocaleString("en-US")} \u2192 ${t.restored.toLocaleString("en-US")}`))}`,
      summary: `${plural(moved.length, "table")} changed between the backup and the count, within the allowance`
    });
  const liveRows = sum(Object.values(source.rows));
  const restoredRows = sum(tables.map((t) => t.restored ?? 0));
  const prev = opts.previous;
  if (prev) {
    if (opts.maxShrink < 100 && prev.rows > 0 && liveRows < prev.rows * (1 - opts.maxShrink / 100))
      findings.push({
        level: "fail",
        code: "DATABASE_SHRANK",
        message: `the database has ${liveRows.toLocaleString("en-US")} rows, ${Math.round((1 - liveRows / prev.rows) * 100)}% fewer than the ${prev.rows.toLocaleString("en-US")} at the last good run (${prev.at.slice(0, 10)}); if that was not intended, the last good run's backup still has them`,
        summary: `the database has ${Math.round((1 - liveRows / prev.rows) * 100)}% fewer rows than at the last good run (${prev.at.slice(0, 10)}); if that was not intended, the last good run's backup still has them`
      });
    const names = Object.keys(source.rows);
    const now = new Set(prev.tablesHashed ? names.map(hashName) : names);
    const gone = prev.tables.filter((t) => !now.has(t));
    if (gone.length)
      findings.push({
        level: "warn",
        code: "TABLES_GONE",
        message: `${plural(gone.length, "table")} of the last good run (${prev.at.slice(0, 10)}) ${gone.length === 1 ? "is" : "are"} gone${prev.tablesHashed ? "" : `: ${list(gone)}`}`,
        summary: `${plural(gone.length, "table")} of the last good run (${prev.at.slice(0, 10)}) ${gone.length === 1 ? "is" : "are"} gone`
      });
    if (prev.backupBytes > 0 && opts.backupBytes < prev.backupBytes / 2)
      findings.push({
        level: "warn",
        code: "BACKUP_SHRANK",
        message: `the backup is ${bytes(opts.backupBytes)}, under half the ${bytes(prev.backupBytes)} of the last good run (${prev.at.slice(0, 10)})`,
        summary: `the backup is under half the size of the last good run's (${prev.at.slice(0, 10)})`
      });
  }
  for (const s2 of opts.skippedExtensions ?? [])
    findings.push({
      level: "note",
      code: "EXTENSION_NOT_IN_COPY",
      message: `extension ${s2.name} was not created in the copy: ${s2.why}`,
      summary: `extension ${s2.name} was not created in the copy: ${s2.why}`
    });
  if (opts.skippedForeign)
    findings.push({
      level: "note",
      code: "FOREIGN_NOT_IN_COPY",
      message: `${plural(opts.skippedForeign, "foreign-data object")} (wrappers, servers, user mappings, foreign tables) left out of the copy: they point at other systems, and a backup holds none of their rows`,
      summary: `${plural(opts.skippedForeign, "foreign-data object")} left out of the copy: they point at other systems, and a backup holds none of their rows`
    });
  return {
    ok: !findings.some((f) => f.level === "fail"),
    findings,
    tables,
    objects: {
      source: Object.keys(source.objects).length,
      restored: Object.keys(restored.objects).length,
      missing,
      changed,
      byKind
    },
    rows: { live: liveRows, restored: restoredRows },
    sameMajor
  };
}
function list(items, max = 8) {
  const head = items.slice(0, max).join(", ");
  return items.length > max ? `${head} and ${items.length - max} more` : head;
}
function bytes(n2) {
  if (n2 < 1024) return `${n2} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n2 / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

// src/scope.ts
var SUPABASE_EXCLUDED_SCHEMAS = [
  "graphql",
  "graphql_public",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "net",
  "cron",
  "realtime",
  "_realtime",
  "_analytics",
  "_supavisor",
  "pgbouncer",
  "pgtle"
];
var SUPABASE_EXCLUDED_TABLE_DATA = [
  "storage.buckets_vectors",
  "storage.vector_indexes",
  "supabase_functions.hooks"
];
var NEVER_IN_COPY = [
  "pg_cron",
  "pg_net",
  "http",
  "pgsodium",
  "supabase_vault",
  "pgaudit",
  "pg_stat_monitor",
  "dblink",
  "postgres_fdw",
  "wrappers"
];
var APT_PACKAGES = {
  vector: (m) => `postgresql-${m}-pgvector`,
  postgis: (m) => `postgresql-${m}-postgis-3`,
  postgis_topology: (m) => `postgresql-${m}-postgis-3`,
  postgis_raster: (m) => `postgresql-${m}-postgis-3`,
  postgis_tiger_geocoder: (m) => `postgresql-${m}-postgis-3`,
  address_standardizer: (m) => `postgresql-${m}-postgis-3`,
  pgrouting: (m) => `postgresql-${m}-pgrouting`,
  hypopg: (m) => `postgresql-${m}-hypopg`,
  pg_partman: (m) => `postgresql-${m}-partman`,
  pg_repack: (m) => `postgresql-${m}-repack`,
  rum: (m) => `postgresql-${m}-rum`,
  orafce: (m) => `postgresql-${m}-orafce`,
  pg_hint_plan: (m) => `postgresql-${m}-pg-hint-plan`,
  pgtap: (m) => `postgresql-${m}-pgtap`,
  ip4r: (m) => `postgresql-${m}-ip4r`,
  h3: (m) => `postgresql-${m}-h3`,
  pg_uuidv7: (m) => `postgresql-${m}-pg-uuidv7`
};
function aptPackages(major, extensions) {
  const pkgs = /* @__PURE__ */ new Set([`postgresql-${major}`]);
  for (const e of extensions) {
    if (NEVER_IN_COPY.includes(e)) continue;
    const pkg = APT_PACKAGES[e];
    if (pkg) pkgs.add(pkg(major));
  }
  return [...pkgs];
}
function scopeFor(provider2, schemas, extraExcluded) {
  const excluded = new Set(extraExcluded);
  const tableData = [];
  if (provider2 === "supabase") {
    for (const s2 of SUPABASE_EXCLUDED_SCHEMAS) excluded.add(s2);
    tableData.push(...SUPABASE_EXCLUDED_TABLE_DATA);
  }
  const kept = schemas.filter((s2) => !excluded.has(s2));
  return {
    schemas: kept,
    excludedSchemas: schemas.filter((s2) => excluded.has(s2)),
    excludedTableData: tableData.filter((t) => kept.includes(t.slice(0, t.indexOf("."))))
  };
}
function listFrom(value) {
  return (value ?? "").split(/[\s,]+/).map((s2) => s2.trim()).filter(Boolean);
}

// src/toc.ts
var FOREIGN = /^(FOREIGN DATA WRAPPER|SERVER|USER MAPPING|FOREIGN TABLE)\b/;
var TYPES = [
  "MATERIALIZED VIEW DATA",
  "FOREIGN DATA WRAPPER",
  "PUBLICATION TABLE",
  "PUBLICATION TABLES IN SCHEMA",
  "SEQUENCE OWNED BY",
  "DEFAULT ACL",
  "EVENT TRIGGER",
  "FK CONSTRAINT",
  "FOREIGN TABLE",
  "MATERIALIZED VIEW",
  "ROW SECURITY",
  "SEQUENCE SET",
  "TABLE ATTACH",
  "INDEX ATTACH",
  "TABLE DATA",
  "USER MAPPING",
  "BLOB METADATA",
  "LARGE OBJECTS"
];
function parseToc(text) {
  const header = [];
  const entries = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(";")) {
      header.push(line);
      continue;
    }
    const m = /^\d+; \d+ \d+ (.+)$/.exec(line);
    if (!m) continue;
    const rest = m[1];
    const type = TYPES.find((t) => rest.startsWith(t + " ")) ?? rest.slice(0, rest.indexOf(" "));
    entries.push({ line, type, rest: rest.slice(type.length + 1) });
  }
  return { header, entries };
}
function dumpedFrom(header) {
  for (const h of header) {
    const m = /Dumped from database version:\s*(\d+(?:\.\d+)?)/.exec(h);
    if (m) return m[1];
  }
  return null;
}
function filterToc(text, skipExtension) {
  const { header, entries } = parseToc(text);
  const keep = [...header];
  const skippedExtensions = [];
  const extensions = [];
  let skippedForeign = 0;
  for (const e of entries) {
    if (e.type === "EXTENSION") {
      const name = e.rest.replace(/^- /, "").trim().split(" ")[0] ?? "";
      extensions.push(name);
      if (skipExtension(name)) {
        skippedExtensions.push(name);
        continue;
      }
    }
    if (e.type === "COMMENT") {
      const m = /^- EXTENSION (\S+)/.exec(e.rest);
      if (m && skipExtension(m[1].replace(/^"(.*)"$/, "$1").replace(/""/g, '"'))) continue;
    }
    if (FOREIGN.test(e.type)) {
      skippedForeign++;
      continue;
    }
    keep.push(e.line);
  }
  return { list: keep.join("\n") + "\n", skippedExtensions, skippedForeign, extensions };
}

// src/url.ts
var PROVIDERS = ["supabase", "neon", "postgres"];
var PARAM_ENV = {
  host: "PGHOST",
  hostaddr: "PGHOSTADDR",
  port: "PGPORT",
  dbname: "PGDATABASE",
  user: "PGUSER",
  password: "PGPASSWORD",
  options: "PGOPTIONS",
  application_name: "PGAPPNAME",
  sslmode: "PGSSLMODE",
  sslrootcert: "PGSSLROOTCERT",
  sslcert: "PGSSLCERT",
  sslkey: "PGSSLKEY",
  sslcrl: "PGSSLCRL",
  sslnegotiation: "PGSSLNEGOTIATION",
  channel_binding: "PGCHANNELBINDING",
  connect_timeout: "PGCONNECT_TIMEOUT",
  target_session_attrs: "PGTARGETSESSIONATTRS",
  gssencmode: "PGGSSENCMODE",
  require_auth: "PGREQUIREAUTH",
  sslsni: "PGSSLSNI"
};
function parseDatabaseUrl(raw) {
  const value = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(value))
    throw fail(
      "BAD_DATABASE_URL",
      "the database URL does not start with postgres:// or postgresql://",
      "Use the connection string your provider shows, in URI form: postgresql://user:password@host:5432/dbname."
    );
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail(
      "BAD_DATABASE_URL",
      "the database URL is not a valid URI (a URI with several hosts is not supported)",
      "Use a single-host URI, and percent-encode special characters in the password (@ as %40, # as %23, / as %2F)."
    );
  }
  const env = {};
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host) env["PGHOST"] = decodeURIComponent(host);
  if (url.port) env["PGPORT"] = url.port;
  if (url.username) env["PGUSER"] = decodeURIComponent(url.username);
  if (url.password) env["PGPASSWORD"] = decodeURIComponent(url.password);
  const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (db) env["PGDATABASE"] = db;
  const ignored = [];
  for (const [key, val] of url.searchParams) {
    const name = PARAM_ENV[key];
    if (name) env[name] = val;
    else ignored.push(key);
  }
  if (!env["PGHOST"])
    throw fail(
      "BAD_DATABASE_URL",
      "the database URL names no host",
      "Use the full connection string, with the host your provider shows."
    );
  return { env, host: env["PGHOST"], port: Number(env["PGPORT"] ?? 5432), ignored };
}
function providerOf(host) {
  const h = host.toLowerCase();
  if (h.endsWith(".supabase.co") || h.endsWith(".supabase.com")) return "supabase";
  if (h.endsWith(".neon.tech") || h.endsWith(".neon.build") || h.endsWith(".neon.com"))
    return "neon";
  return "postgres";
}
function isSupabaseDirect(host) {
  return /^db\.[a-z0-9]+\.supabase\.co$/i.test(host);
}
function isSupabasePooler(host) {
  return /\.pooler\.supabase\.com$/i.test(host);
}
function isNeonPooled(host) {
  return /^[^.]+-pooler\./i.test(host) && providerOf(host) === "neon";
}
function checkConnection(conn) {
  if (isSupabasePooler(conn.host) && conn.port === 6543)
    throw fail(
      "SUPABASE_TRANSACTION_POOLER",
      "this is Supabase's transaction pooler (port 6543), which does not support prepared statements or a whole-database dump",
      "Use the Session pooler string instead: Connect > Session pooler in the Supabase dashboard, the same host on port 5432."
    );
  if (isNeonPooled(conn.host))
    throw fail(
      "NEON_POOLED",
      `this is Neon's pooled connection string ("-pooler" in the host); Neon says to avoid pg_dump over a pooled connection`,
      'Use the direct connection string: the same host without "-pooler" (Connection pooling off in the Connect dialog).'
    );
}
function explainConnectError(conn, stderr, ci) {
  if (isSupabaseDirect(conn.host) && /Network is unreachable|No route to host|could not translate host name|ENETUNREACH|Cannot assign requested address/i.test(
    stderr
  ))
    return fail(
      "SUPABASE_DIRECT_IPV6",
      `Supabase's direct connection (db.<ref>.supabase.co) is IPv6 unless the project has the IPv4 add-on, and ${ci ? "GitHub's hosted runners have" : "this network has"} no IPv6`,
      "Use the Session pooler string: Connect > Session pooler in the Supabase dashboard (host *.pooler.supabase.com, port 5432), which is IPv4 on every plan.",
      false
    );
  if (/password authentication failed|authentication failed/i.test(stderr))
    return fail(
      "DATABASE_AUTH_FAILED",
      "the database refused the user name or password in the URL",
      "Copy the connection string again from the provider's dashboard; a password with @, #, / or : must be percent-encoded."
    );
  return null;
}

// src/version.ts
var VERSION = "0.1.0";

// src/drill.ts
var URL_VARIABLES = ["RESTOREPROOF_DATABASE_URL", "DATABASE_URL"];
function sourceUrl(env, urlEnv) {
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
    urlEnv ? `Set ${urlEnv} to the database's connection string in this shell (it is read from the environment, never from an argument).` : "Set RESTOREPROOF_DATABASE_URL to the database's connection string in this shell, e.g. `read -s RESTOREPROOF_DATABASE_URL && export RESTOREPROOF_DATABASE_URL`, so it stays out of your shell history."
  );
}
async function probeSource(env, urlEnv, providerSetting) {
  const { conn, variable } = sourceUrl(env, urlEnv);
  const provider2 = resolveProvider(providerSetting, conn.host);
  const psql = await findAnyPsql(env);
  const r = await run(psql, PSQL_ARGS, {
    env: pgEnv(env, conn.env),
    input: PROBE_SQL,
    timeoutMs: 12e4
  });
  if (r.code !== 0) throw connectError(conn, r.stderr, env);
  return { conn, provider: provider2, probe: parseProbe(r.stdout), variable };
}
function resolveProvider(setting, host) {
  const s2 = (setting ?? "auto").trim().toLowerCase();
  if (s2 === "" || s2 === "auto") return providerOf(host);
  if (s2 === "supabase" || s2 === "neon" || s2 === "postgres") return s2;
  throw fail(
    "BAD_PROVIDER",
    `RESTOREPROOF_PROVIDER is "${setting}"`,
    "Use auto, supabase, neon or postgres."
  );
}
function connectError(conn, stderr, env) {
  return explainConnectError(conn, stderr, env["GITHUB_ACTIONS"] === "true") ?? fail(
    "SOURCE_CONNECT_FAILED",
    `could not read the database:
${tail(stderr)}`,
    "Check that the URL's host is reachable from here and that its user can connect; the provider's dashboard shows the current connection string.",
    true
  );
}
var elapsed = (t0) => Math.round((Date.now() - t0) / 100) / 10;
function stamp(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
var exact = (name) => `"${name.replace(/"/g, '""')}"`;
var exactTable = (qualifiedName) => {
  const dot = qualifiedName.indexOf(".");
  return `${exact(qualifiedName.slice(0, dot))}.${exact(qualifiedName.slice(dot + 1))}`;
};
function dumpArgs(file, scope) {
  return [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--no-subscriptions",
    "--lock-wait-timeout=120000",
    `--file=${file}`,
    ...scope.excludedSchemas.map((s2) => `--exclude-schema=${exact(s2)}`),
    ...scope.excludedTableData.map((t) => `--exclude-table-data=${exactTable(t)}`)
  ];
}
function dumpError(stderr, major) {
  if (/server version mismatch|aborting because of server version/i.test(stderr))
    return fail(
      "PG_VERSION_SKEW",
      `pg_dump is older than the server:
${tail(stderr, 3)}`,
      `Use pg_dump ${major} or newer.`
    );
  if (/row-level security|row level security/i.test(stderr))
    return fail(
      "RLS_BLOCKS_DUMP",
      `row-level security hides rows from this role, so pg_dump stopped:
${tail(stderr, 3)}`,
      "Back up as the tables' owner or a role with BYPASSRLS (on Supabase, the postgres user of the connection string the dashboard shows)."
    );
  if (/permission denied/i.test(stderr))
    return fail(
      "DUMP_PERMISSION_DENIED",
      `the role cannot read everything in the backup:
${tail(stderr, 3)}`,
      "Back up as a role that can read every table, or leave the schema out with RESTOREPROOF_EXCLUDE_SCHEMAS."
    );
  return fail(
    "DUMP_FAILED",
    `pg_dump failed:
${tail(stderr)}`,
    "Read pg_dump's message above; run it again if the network dropped.",
    true
  );
}
async function prepareCopy(bin2, cluster, roles, env) {
  const admin = pgEnv(env, cluster.env);
  const sql = [
    "DROP DATABASE IF EXISTS restoretest;",
    "CREATE DATABASE restoretest;",
    ...roles.map(
      (r2) => `DO $rp$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(r2)}) THEN CREATE ROLE ${ident(r2)} NOLOGIN; END IF; END$rp$;`
    )
  ].join("\n");
  const r = await run(bin2.path("psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    env: admin,
    input: sql,
    timeoutMs: 12e4
  });
  if (r.code !== 0)
    throw fail(
      "COPY_PREPARE_FAILED",
      `could not prepare the throwaway copy:
${tail(r.stderr)}`,
      "Run it again.",
      true
    );
  return { ...cluster.env, PGDATABASE: "restoretest" };
}
async function availableExtensions(bin2, cluster, env) {
  const r = await run(bin2.path("psql"), PSQL_ARGS, {
    env: pgEnv(env, cluster.env),
    input: "SELECT 'ext', name, '' FROM pg_available_extensions;",
    timeoutMs: 6e4
  });
  return new Set(
    r.stdout.split("\0").map((row) => row.split("")[1]).filter((n2) => !!n2)
  );
}
var MISSING_ROLE = /role "([^"]+)" does not exist/;
async function restoreInto(bin2, cluster, file, kind, roles, skip, env) {
  const known = [...roles];
  let skippedExtensions = [];
  let skippedForeign = 0;
  let listFile = null;
  if (kind === "archive") {
    const toc = await run(bin2.path("pg_restore"), ["-l", file], {
      env: pgEnv(env, {}),
      timeoutMs: 3e5
    });
    if (toc.code !== 0)
      return {
        ok: false,
        seconds: 0,
        error: tail(toc.stderr),
        skippedExtensions,
        skippedForeign,
        target: cluster.env
      };
    const filtered = filterToc(toc.stdout, skip);
    skippedExtensions = filtered.skippedExtensions;
    skippedForeign = filtered.skippedForeign;
    listFile = path3.join(cluster.dir, "restore.list");
    writeFileSync2(listFile, filtered.list);
  }
  const t0 = Date.now();
  for (let attempt = 0; attempt < 25; attempt++) {
    const target = await prepareCopy(bin2, cluster, known, env);
    const r = kind === "archive" ? await run(
      bin2.path("pg_restore"),
      [
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        `--use-list=${listFile}`,
        "-d",
        "restoretest",
        file
      ],
      { env: pgEnv(env, target), timeoutMs: 6 * 36e5 }
    ) : await run(bin2.path("psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file], {
      env: pgEnv(env, target),
      timeoutMs: 6 * 36e5
    });
    if (r.code === 0)
      return {
        ok: true,
        seconds: elapsed(t0),
        error: null,
        skippedExtensions,
        skippedForeign,
        target
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
      target
    };
  }
  return {
    ok: false,
    seconds: elapsed(t0),
    error: "gave up after creating 25 missing roles",
    skippedExtensions,
    skippedForeign,
    target: cluster.env
  };
}
async function readFacts(bin2, conn, schemas, readOnly, env) {
  const r = await run(bin2.path("psql"), PSQL_ARGS, {
    env: pgEnv(env, conn),
    input: factsSql(schemas, { readOnly }),
    timeoutMs: 6 * 36e5
  });
  if (r.code !== 0)
    throw fail(
      "FACTS_FAILED",
      `could not read the catalog and counts:
${tail(r.stderr)}`,
      "Run it again; if it persists, report it with the message above.",
      true
    );
  return parseFacts(r.stdout);
}
function whyNotInCopy(name, available, extra) {
  if (NEVER_IN_COPY.includes(name))
    return "restoreproof never creates it in a throwaway copy, because it schedules work, makes requests or needs a server key";
  if (extra.includes(name)) return "RESTOREPROOF_SKIP_EXTENSIONS names it";
  if (!available.has(name))
    return "it is not installed where the copy runs; anything that needs it fails the restore and is named";
  return "skipped";
}
async function drillLive(opts) {
  const env = opts.env;
  const now = opts.now ?? (() => /* @__PURE__ */ new Date());
  const log = opts.log ?? (() => void 0);
  const at = now();
  const src = await probeSource(env, opts.urlEnv, opts.provider);
  const { probe, provider: provider2 } = src;
  log(`source: PostgreSQL ${probe.version} (${provider2}), read through ${src.variable}`);
  const scope = scopeFor(provider2, probe.schemas, opts.excludeSchemas ?? []);
  const blocked = probe.rlsBlocked.filter((b) => scope.schemas.includes(b.schema));
  if (blocked.length)
    throw fail(
      "RLS_BLOCKS_DUMP",
      `row-level security would hide rows of ${blocked.length} table(s) from this role, so pg_dump would stop`,
      "Back up as the tables' owner or a role with BYPASSRLS (on Supabase, the postgres user of the connection string the dashboard shows)."
    );
  const bin2 = await findPgBin(probe.major, env, opts.allowNewerMajor);
  log(`tools: PostgreSQL ${bin2.version} from ${bin2.dir}`);
  mkdirSync(opts.outDir, { recursive: true });
  const file = path3.join(opts.outDir, `restoreproof-${stamp(at)}.dump`);
  const t0 = Date.now();
  const dump = await run(bin2.path("pg_dump"), dumpArgs(file, scope), {
    env: pgEnv(env, src.conn.env),
    timeoutMs: 6 * 36e5
  });
  if (dump.code !== 0) {
    rmSync2(file, { force: true });
    throw dumpError(dump.stderr, probe.major);
  }
  const backup = {
    file,
    bytes: statSync(file).size,
    seconds: elapsed(t0),
    tool: `pg_dump ${bin2.version}`
  };
  log(`backup: ${backup.bytes} bytes in ${backup.seconds}s`);
  const sourceFacts = await readFacts(bin2, src.conn.env, scope.schemas, true, env);
  log(
    `source facts: ${Object.keys(sourceFacts.rows).length} tables, ${sum(Object.values(sourceFacts.rows))} rows`
  );
  const extra = opts.skipExtensions ?? [];
  const cluster = await startCluster({ bin: bin2, baseEnv: env });
  try {
    const available = await availableExtensions(bin2, cluster, env);
    const skip = (name) => NEVER_IN_COPY.includes(name) || extra.includes(name) || !available.has(name);
    const restore = await restoreInto(bin2, cluster, file, "archive", probe.rolesUsed, skip, env);
    log(`restore: ${restore.ok ? "ok" : "failed"} in ${restore.seconds}s`);
    const into = `PostgreSQL ${bin2.version}, a throwaway cluster on 127.0.0.1 with no other connections`;
    const skipped = restore.skippedExtensions.map((name) => ({
      name,
      why: whyNotInCopy(name, available, extra)
    }));
    const base = {
      tool: "restoreproof",
      version: VERSION,
      at: at.toISOString(),
      mode: "live",
      ok: false,
      provider: provider2,
      variable: src.variable,
      source: {
        version: probe.version,
        major: probe.major,
        bytes: probe.size,
        schemas: scope.schemas,
        excludedSchemas: scope.excludedSchemas,
        excludedTableData: scope.excludedTableData
      },
      backup,
      restore: {
        ok: restore.ok,
        seconds: restore.seconds,
        into,
        error: restore.error,
        skippedExtensions: restore.skippedExtensions
      },
      comparison: null,
      restored: null,
      findings: [],
      previous: opts.previous ?? null
    };
    if (!restore.ok) {
      base.findings = [
        {
          level: "fail",
          code: "RESTORE_FAILED",
          message: `the backup did not restore:
${restore.error ?? ""}`,
          summary: "the backup did not restore; pg_restore's message is in the job log"
        },
        ...skipped.map((s2) => ({
          level: "note",
          code: "EXTENSION_NOT_IN_COPY",
          message: `extension ${s2.name} was not created in the copy: ${s2.why}`,
          summary: `extension ${s2.name} was not created in the copy: ${s2.why}`
        }))
      ];
      return base;
    }
    const copyFacts = await readFacts(bin2, restore.target, scope.schemas, false, env);
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
      skippedForeign: restore.skippedForeign
    });
    if (leftOut.length) {
      const note = `the rows of ${leftOut.join(", ")} are left out of the backup by design, as platform data Supabase writes for itself (its own restore guide leaves out the Storage vector tables); their definitions are checked`;
      comparison.findings.push({
        level: "note",
        code: "TABLE_DATA_LEFT_OUT",
        message: note,
        summary: `the rows of ${leftOut.length} Supabase platform table(s) are left out of the backup by design; their definitions are checked`
      });
    }
    const asked = scope.excludedSchemas.filter((s2) => (opts.excludeSchemas ?? []).includes(s2));
    const platform = scope.excludedSchemas.filter((s2) => !asked.includes(s2));
    if (platform.length) {
      const note = `${platform.length} Supabase platform schema(s) left out of the backup, as \`supabase db dump\` does: ${platform.join(", ")}`;
      comparison.findings.push({
        level: "note",
        code: "SCHEMAS_LEFT_OUT",
        message: note,
        summary: note
      });
    }
    if (asked.length) {
      const note = `RESTOREPROOF_EXCLUDE_SCHEMAS left ${asked.length} schema(s) out of the backup: ${asked.join(", ")}`;
      comparison.findings.push({
        level: "note",
        code: "SCHEMAS_LEFT_OUT",
        message: note,
        summary: `RESTOREPROOF_EXCLUDE_SCHEMAS left ${asked.length} schema(s) out of the backup`
      });
    }
    return { ...base, ok: comparison.ok, comparison, findings: comparison.findings };
  } finally {
    await cluster.stop();
  }
}
function backupKind(file) {
  const st = statSync(file);
  if (st.isDirectory()) return "archive";
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(512);
    const n2 = readSync(fd, head, 0, 512, 0);
    if (n2 >= 5 && head.subarray(0, 5).toString("latin1") === "PGDMP") return "archive";
    if (n2 >= 262 && head.subarray(257, 262).toString("latin1") === "ustar") return "archive";
    return "sql";
  } finally {
    closeSync(fd);
  }
}
function sqlDumpedFrom(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4096);
    const n2 = readSync(fd, head, 0, 4096, 0);
    const m = /Dumped from database version (\d+(?:\.\d+)?)/.exec(
      head.subarray(0, n2).toString("utf8")
    );
    return m ? m[1] : null;
  } finally {
    closeSync(fd);
  }
}
async function drillFile(opts) {
  const env = opts.env;
  const log = opts.log ?? (() => void 0);
  const at = (opts.now ?? (() => /* @__PURE__ */ new Date()))();
  if (!existsSync(opts.file))
    throw fail(
      "BACKUP_NOT_FOUND",
      `there is no file or directory at ${opts.file}`,
      "Pass the path of a pg_dump archive or .sql file."
    );
  const kind = backupKind(opts.file);
  let from = kind === "sql" ? sqlDumpedFrom(opts.file) : null;
  if (kind === "archive") {
    const newest = await findNewestPgBin(env).catch(() => null);
    if (newest) {
      const toc = await run(newest.path("pg_restore"), ["-l", opts.file], {
        env: pgEnv(env, {}),
        timeoutMs: 3e5
      });
      if (toc.code === 0) from = dumpedFrom(parseToc(toc.stdout).header);
    }
  }
  const bin2 = from ? await findPgBin(Number(from.split(".")[0]), env, true) : await findNewestPgBin(env);
  log(
    `backup: ${kind === "sql" ? "plain SQL" : "pg_dump archive"}${from ? ` from PostgreSQL ${from}` : ""}; restoring with PostgreSQL ${bin2.version}`
  );
  const extra = opts.skipExtensions ?? [];
  const cluster = await startCluster({ bin: bin2, baseEnv: env });
  try {
    const available = await availableExtensions(bin2, cluster, env);
    const skip = (name) => NEVER_IN_COPY.includes(name) || extra.includes(name) || !available.has(name);
    const restore = await restoreInto(bin2, cluster, opts.file, kind, [], skip, env);
    const into = `PostgreSQL ${bin2.version}, a throwaway cluster on 127.0.0.1 with no other connections`;
    const result = {
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
        tool: kind === "sql" ? "plain SQL" : "pg_dump archive"
      },
      restore: {
        ok: restore.ok,
        seconds: restore.seconds,
        into,
        error: restore.error,
        skippedExtensions: restore.skippedExtensions
      },
      comparison: null,
      restored: null,
      findings: [],
      previous: null
    };
    if (!restore.ok) {
      result.findings = [
        {
          level: "fail",
          code: "RESTORE_FAILED",
          message: `the backup did not restore:
${restore.error ?? ""}`,
          summary: "the backup did not restore"
        }
      ];
      return result;
    }
    const schemas = await userSchemas(bin2, restore.target, env);
    const facts = await readFacts(bin2, restore.target, schemas, false, env);
    const rows = facts.rows;
    const empty = Object.keys(rows).filter((t) => rows[t] === 0).sort();
    result.restored = {
      tables: Object.keys(rows).length,
      rows: sum(Object.values(rows)),
      empty,
      rowsByTable: rows
    };
    if (Object.keys(rows).length === 0)
      result.findings.push({
        level: "fail",
        code: "NOTHING_RESTORED",
        message: "the backup restored without error but holds no tables",
        summary: "the backup restored without error but holds no tables"
      });
    else if (empty.length)
      result.findings.push({
        level: "note",
        code: "EMPTY_TABLES",
        message: `${empty.length} table(s) restored empty; check that they should be: ${empty.slice(0, 8).join(", ")}${empty.length > 8 ? ` and ${empty.length - 8} more` : ""}`,
        summary: `${empty.length} table(s) restored empty`
      });
    for (const name of restore.skippedExtensions)
      result.findings.push({
        level: "note",
        code: "EXTENSION_NOT_IN_COPY",
        message: `extension ${name} was not created in the copy: ${whyNotInCopy(name, available, extra)}`,
        summary: `extension ${name} was not created in the copy`
      });
    result.ok = !result.findings.some((f) => f.level === "fail");
    return result;
  } finally {
    await cluster.stop();
  }
}
function sizeOf(file) {
  const st = statSync(file);
  return st.isDirectory() ? 0 : st.size;
}
async function userSchemas(bin2, conn, env) {
  const r = await run(bin2.path("psql"), PSQL_ARGS, {
    env: pgEnv(env, conn),
    input: PROBE_SQL,
    timeoutMs: 6e4
  });
  return parseProbe(r.stdout).schemas;
}
function scratchDir() {
  return mkdtempSync2(path3.join(tmpdir2(), "restoreproof-backup-"));
}

// src/handoff.ts
var PAGES_URL = "https://agentwares-agentcheck.vercel.app/restoreproof";
var REF = "restoreproof";
var HANDOFF_URL = `${PAGES_URL}?ref=${REF}#watch`;
var HANDOFF_LINE = "An email when a weekly restore test fails or does not run is not built.";
var HANDOFF_DETAIL = "It would email the people you name when a test fails, when the backup shrinks, or when no test has run for eight days, from outside GitHub's scheduler. Today GitHub emails one person when a scheduled run fails, and nobody when it never runs. agentcheck's free hourly watch covers MCP servers only. If you would pay for this one, say so with one click:";

// src/render.ts
var n = (v) => v.toLocaleString("en-US");
var s = (v, one, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
function when(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
function verdictWord(r) {
  return r.ok ? "PASSED" : "FAILED";
}
function findingText(f, redact) {
  return redact ? f.summary : f.message;
}
function kinds(byKind) {
  const order = [
    "table",
    "column",
    "constraint",
    "index",
    "view",
    "matview",
    "function",
    "procedure",
    "aggregate",
    "trigger",
    "policy",
    "sequence",
    "enum",
    "domain"
  ];
  const plural2 = {
    index: "indexes",
    matview: "materialized views",
    policy: "policies"
  };
  return order.filter((k) => byKind[k]).map((k) => {
    const v = byKind[k];
    const name = k === "matview" ? "materialized view" : k;
    return `${n(v)} ${v === 1 ? name : plural2[k] ?? `${name}s`}`;
  }).join(", ");
}
function tablesToShow(tables) {
  if (tables.length <= 40) return { rows: [...tables], hidden: 0 };
  const off = tables.filter((t) => t.verdict !== "match");
  const big = [...tables].filter((t) => t.verdict === "match").sort((a, b) => b.live - a.live).slice(0, 20);
  const rows = [...off, ...big].sort((a, b) => a.table.localeCompare(b.table));
  return { rows, hidden: tables.length - rows.length };
}
var VERDICT = {
  match: "",
  changed: "changed during the backup",
  differs: "DIFFERS",
  empty: "RESTORED EMPTY",
  missing: "MISSING"
};
function renderText(r, opts = {}) {
  const redact = !!opts.redact;
  const out = [];
  out.push(`restoreproof ${r.version} \xB7 restore test ${verdictWord(r)} \xB7 ${when(r.at)}`, "");
  if (r.source)
    out.push(
      `  source    PostgreSQL ${r.source.version}${r.provider ? ` (${r.provider})` : ""}, ${bytes(r.source.bytes)}${r.variable ? `, read through ${r.variable}` : ""}`
    );
  if (r.backup)
    out.push(
      r.mode === "live" ? `  backup    ${bytes(r.backup.bytes)} in ${r.backup.seconds} s (${r.backup.tool}, custom format)` : `  backup    ${r.backup.tool}${r.backup.bytes ? `, ${bytes(r.backup.bytes)}` : ""}`
    );
  out.push(
    `  restored  ${r.restore.ok ? `in ${r.restore.seconds} s` : "FAILED"} into ${r.restore.into}`
  );
  const c = r.comparison;
  if (c) {
    out.push(
      `  checked   ${s(c.rows.live, "row")} in ${s(c.tables.length, "table")} against the live database${c.ok ? ": all match" : ""}`
    );
    out.push(
      ...hang(
        `${s(c.objects.source, "schema object")}: ${kinds(c.objects.byKind)}`,
        "            "
      )
    );
  }
  if (r.restored)
    out.push(
      `  restored  ${s(r.restored.tables, "table")} and ${s(r.restored.rows, "row")} came back`
    );
  if (r.previous) out.push(`  compared  with the last good run, ${r.previous.at.slice(0, 10)}`);
  if (c && !redact && c.tables.length) {
    const { rows, hidden } = tablesToShow(c.tables);
    const w = Math.min(48, Math.max(...rows.map((t) => t.table.length), 5));
    const lw = Math.max(...rows.map((t) => n(t.live).length), 4);
    out.push("", `  ${"table".padEnd(w)}  ${"live".padStart(lw)} \u2192 restored`);
    for (const t of rows)
      out.push(
        `  ${t.table.padEnd(w)}  ${n(t.live).padStart(lw)} \u2192 ${t.restored === null ? "\u2014" : n(t.restored)}${VERDICT[t.verdict] ? `  ${VERDICT[t.verdict]}` : ""}`
      );
    if (hidden) out.push(`  \u2026 and ${s(hidden, "more table")} that match`);
  }
  if (r.restored && !redact && r.restored.tables) {
    const names = Object.keys(r.restored.rowsByTable).sort();
    const w = Math.min(48, Math.max(...names.map((t) => t.length), 5));
    out.push("", `  ${"table".padEnd(w)}  restored rows`);
    for (const t of names.slice(0, 40))
      out.push(`  ${t.padEnd(w)}  ${n(r.restored.rowsByTable[t])}`);
    if (names.length > 40) out.push(`  \u2026 and ${s(names.length - 40, "more table")}`);
  }
  const groups = [
    ["fail", "FAILED"],
    ["warn", "warnings"],
    ["note", "notes"]
  ];
  for (const [level, title] of groups) {
    const fs = r.findings.filter((f) => f.level === level);
    if (!fs.length) continue;
    out.push("", `  ${title}`);
    for (const f of fs)
      for (const [i, para] of findingText(f, redact).split("\n").entries())
        out.push(...hang(para, i === 0 ? "    - " : "      ", "      "));
  }
  if (opts.kept !== void 0 && r.mode === "live")
    out.push(
      "",
      opts.kept ? `  The backup is kept at ${opts.kept}.` : "  The backup was deleted; pass --out <dir> to keep it."
    );
  out.push("", HANDOFF_LINE, wrap(HANDOFF_DETAIL), HANDOFF_URL, "");
  return out.join("\n");
}
function hang(text, first, rest = first, width = 100) {
  const lines = [];
  let line = first;
  let empty = true;
  for (const w of text.split(" ")) {
    if (!empty && line.length + 1 + w.length > width) {
      lines.push(line);
      line = rest + w;
    } else line = empty ? line + w : `${line} ${w}`;
    empty = false;
  }
  lines.push(line);
  return lines;
}
function wrap(text, width = 100) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
var md = (t) => t.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
function renderMarkdown(r, opts = {}) {
  const redact = !!opts.redact;
  const out = [];
  out.push(`## restoreproof: the restore test ${r.ok ? "passed" : "FAILED"}`, "");
  out.push("| | |", "| --- | --- |");
  if (r.source)
    out.push(
      `| Source | PostgreSQL ${r.source.version}${r.provider ? ` (${r.provider})` : ""}, ${bytes(r.source.bytes)} |`
    );
  if (r.backup)
    out.push(
      `| Backup | ${bytes(r.backup.bytes)} in ${r.backup.seconds} s, ${r.backup.tool}, custom format |`
    );
  out.push(
    `| Restored | ${r.restore.ok ? `in ${r.restore.seconds} s` : "**failed**"} into ${r.restore.into} |`
  );
  const c = r.comparison;
  if (c) {
    out.push(
      `| Tables and rows | ${s(c.tables.length, "table")}, ${s(c.rows.live, "row")} live, ${s(c.rows.restored, "row")} restored |`
    );
    out.push(
      `| Schema objects | ${s(c.objects.source, "object")}: ${kinds(c.objects.byKind)}; ${c.objects.missing} missing, ${c.objects.changed} changed |`
    );
  }
  if (r.previous) out.push(`| Compared with | the last good run, ${r.previous.at.slice(0, 10)} |`);
  out.push(`| Run | ${when(r.at)}, restoreproof ${r.version} |`);
  for (const [level, title] of [
    ["fail", "Failed"],
    ["warn", "Warnings"],
    ["note", "Notes"]
  ]) {
    const fs = r.findings.filter((f) => f.level === level);
    if (!fs.length) continue;
    out.push("", `### ${title}`, "");
    for (const f of fs)
      out.push(
        `- ${level === "fail" ? "**" : ""}${md(findingText(f, redact))}${level === "fail" ? "**" : ""}`
      );
  }
  if (c && !redact && c.tables.length) {
    const { rows, hidden } = tablesToShow(c.tables);
    out.push(
      "",
      "### Rows by table",
      "",
      "| Table | Live | Restored | |",
      "| --- | ---: | ---: | --- |"
    );
    for (const t of rows)
      out.push(
        `| ${md(t.table)} | ${n(t.live)} | ${t.restored === null ? "\u2014" : n(t.restored)} | ${VERDICT[t.verdict]} |`
      );
    if (hidden) out.push("", `${s(hidden, "more table")} match and are not listed.`);
  }
  if (redact)
    out.push(
      "",
      "This repository is public, so this summary names no table and gives no per-table count. Run `restoreproof check` where you keep the database URL to see them."
    );
  out.push(
    "",
    "---",
    "",
    `${HANDOFF_LINE} ${HANDOFF_DETAIL} [I would pay for it](${HANDOFF_URL})`,
    ""
  );
  return out.join("\n");
}
function renderJson(r) {
  return JSON.stringify(r, null, 2) + "\n";
}
function renderError(p, json) {
  if (json) return JSON.stringify({ error: p }, null, 2) + "\n";
  return `restoreproof: ${p.code}
  ${p.cause.split("\n").join("\n  ")}
  fix: ${p.fix}
`;
}
function factsFile(r, redact) {
  const c = r.comparison;
  const names = c ? c.tables.map((t) => t.table) : [];
  return {
    tool: "restoreproof",
    version: r.version,
    at: r.at,
    ok: r.ok,
    provider: r.provider,
    redacted: redact,
    source: r.source ? { version: r.source.version, bytes: r.source.bytes } : null,
    backupBytes: r.backup?.bytes ?? 0,
    rows: c?.rows.live ?? 0,
    tables: redact ? names.map(hashName) : names,
    ...redact || !c ? {} : { rowsByTable: Object.fromEntries(c.tables.map((t) => [t.table, t.live])) }
  };
}
function previousFrom(text) {
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    return null;
  }
  if (f.tool !== "restoreproof" || typeof f.at !== "string" || typeof f.rows !== "number" || !Array.isArray(f.tables))
    return null;
  return {
    at: f.at,
    rows: f.rows,
    tables: f.tables.filter((t) => typeof t === "string"),
    backupBytes: typeof f.backupBytes === "number" ? f.backupBytes : 0,
    tablesHashed: !!f.redacted
  };
}

// src/ci.ts
function output(env, pairs) {
  const file = env["GITHUB_OUTPUT"];
  if (!file) return;
  appendFileSync(
    file,
    Object.entries(pairs).map(([k, v]) => `${k}=${String(v).replace(/\n/g, " ")}
`).join("")
  );
}
function summary(env, text) {
  const file = env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, text);
}
function shouldRedact(env) {
  if (env["GITHUB_ACTIONS"] !== "true") return false;
  const v = (env["RESTOREPROOF_VISIBILITY"] ?? "").toUpperCase();
  return v !== "PRIVATE" && v !== "INTERNAL";
}
function percent(env, name, fallback) {
  const raw = env[name];
  if (raw === void 0 || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 100)
    throw fail(
      "BAD_SETTING",
      `${name} is "${raw}"`,
      `Set ${name} to a percentage from 0 to 100, or remove it for ${fallback}.`
    );
  return v;
}
async function probeCommand(deps) {
  try {
    const src = await probeSource(
      deps.env,
      deps.env["RESTOREPROOF_URL_ENV"],
      deps.env["RESTOREPROOF_PROVIDER"]
    );
    const packages = aptPackages(
      src.probe.major,
      src.probe.extensions.map((e) => e.name)
    );
    output(deps.env, {
      major: src.probe.major,
      packages: packages.join(" "),
      provider: src.provider
    });
    deps.stdout(
      `PostgreSQL ${src.probe.version} (${src.provider}), read through ${src.variable}
major=${src.probe.major}
packages=${packages.join(" ")}
`
    );
    return 0;
  } catch (e) {
    return report(e, deps);
  }
}
function report(e, deps) {
  if (!(e instanceof CliError)) throw e;
  deps.stderr(renderError(e.toJSON(), false));
  if (deps.env["GITHUB_ACTIONS"] === "true") {
    deps.stdout(`::error title=restoreproof ${e.code}::${e.cause.split("\n")[0]} Fix: ${e.fix}
`);
    summary(
      deps.env,
      `## restoreproof: the restore test could not run

**${e.code}**: ${e.cause.replace(/\n/g, "<br>")}

**Fix:** ${e.fix}
`
    );
    output(deps.env, { ok: false });
  }
  return e.exitCode;
}
async function drillCommand(deps) {
  const env = deps.env;
  const redact = shouldRedact(env);
  try {
    const outDir = env["RESTOREPROOF_OUT"] || (env["RUNNER_TEMP"] ? path4.join(env["RUNNER_TEMP"], "restoreproof") : path4.join(tmpdir3(), "restoreproof"));
    mkdirSync2(outDir, { recursive: true });
    const prevFile = env["RESTOREPROOF_PREVIOUS"];
    const previous = prevFile && existsSync2(prevFile) ? previousFrom(readFileSync2(prevFile, "utf8")) : null;
    const result = await drillLive({
      env,
      urlEnv: env["RESTOREPROOF_URL_ENV"],
      provider: env["RESTOREPROOF_PROVIDER"],
      outDir,
      maxRowDrift: percent(env, "RESTOREPROOF_MAX_ROW_DRIFT", 10),
      maxShrink: percent(env, "RESTOREPROOF_MAX_SHRINK", 50),
      previous,
      excludeSchemas: listFrom(env["RESTOREPROOF_EXCLUDE_SCHEMAS"]),
      skipExtensions: listFrom(env["RESTOREPROOF_SKIP_EXTENSIONS"]),
      allowNewerMajor: false,
      now: deps.now,
      log: (l) => deps.stderr(`restoreproof: ${l}
`)
    });
    const facts = path4.join(outDir, "facts.json");
    writeFileSync3(facts, JSON.stringify(factsFile(result, redact), null, 2) + "\n");
    deps.stdout(renderText(result, { redact }));
    summary(env, renderMarkdown(result, { redact }));
    if (env["GITHUB_ACTIONS"] === "true")
      for (const f of result.findings.filter((x) => x.level === "fail"))
        deps.stdout(
          `::error title=restoreproof ${f.code}::${(redact ? f.summary : f.message).split("\n")[0]}
`
        );
    output(env, {
      ok: result.ok,
      backup: result.backup?.file ?? "",
      facts,
      tables: result.comparison?.tables.length ?? 0,
      rows: result.comparison?.rows.live ?? 0
    });
    return result.ok ? 0 : 1;
  } catch (e) {
    return report(e, deps);
  }
}

// src/init.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync4 } from "fs";
import path5 from "path";

// src/install.ts
var ON_NPM = false;
var NAME = "restoreproof";
var REPO = `https://github.com/agentwares/${NAME}`;
var INSTALL = ON_NPM ? `npx ${NAME}` : `npx --allow-git=root github:agentwares/${NAME}`;
var RUN = ON_NPM ? `npx -y ${NAME}@latest` : `npx -y --allow-git=root github:agentwares/${NAME}`;

// src/workflow.ts
var WORKFLOW_PATH = ".github/workflows/restoreproof.yml";
var DRILL_PATH = ".github/restoreproof/drill.mjs";
var DEFAULT_CRON = "17 4 * * 1";
var DEFAULT_KEEP_DAYS = 28;
var DEFAULT_SECRET = "RESTOREPROOF_DATABASE_URL";
function checkCron(cron) {
  const c = cron.trim().replace(/\s+/g, " ");
  if (!/^([\d*/,-]+ ){4}[\d*/,-]+$/.test(c))
    throw usage(
      `--cron "${cron}" is not five cron fields`,
      'e.g. `--cron "17 4 * * 1"` (Mondays 04:17 UTC) or `--cron "17 4 * * *"` (daily)'
    );
  return c;
}
function checkSecret(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name) || /^GITHUB_/i.test(name))
    throw usage(
      `--secret "${name}" is not a repository secret name`,
      "Use letters, digits and underscores, not starting with GITHUB_, e.g. SUPABASE_DB_URL."
    );
  return name;
}
function checkKeepDays(raw) {
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1 || v > 400)
    throw usage(
      `--keep-days takes 1 to 400 days, got "${raw}"`,
      "GitHub keeps artifacts 1 to 90 days in a public repository and up to 400 in a private one."
    );
  return v;
}
function describeCron(cron) {
  if (cron === DEFAULT_CRON) return "Mondays 04:17 UTC";
  const [min, hour, dom, mon, dow] = cron.split(" ");
  if (/^\d+$/.test(min ?? "") && /^\d+$/.test(hour ?? "") && dom === "*" && mon === "*" && dow === "*")
    return `daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
  return "UTC";
}
var WHICH_URL = {
  supabase: [
    "Supabase: the Session pooler string (Connect > Session pooler: *.pooler.supabase.com, port",
    "5432). The direct db.<ref>.supabase.co host is IPv6 only, and GitHub's runners have no IPv6;",
    "port 6543 is the transaction pooler, which cannot take a whole-database dump."
  ],
  neon: [
    'Neon: the direct connection string, with no "-pooler" in the host (Connect > Connection',
    "pooling off). Neon says to avoid pg_dump over a pooled connection."
  ],
  postgres: ["Any postgres:// URL this runner can reach, for a role that can read every table."],
  auto: [
    "Supabase: the Session pooler string (Connect > Session pooler, port 5432); the direct",
    "  db.<ref>.supabase.co host is IPv6 only, and GitHub's runners have no IPv6.",
    'Neon: the direct string, with no "-pooler" in the host.',
    "Others: any postgres:// URL this runner can reach, for a role that can read every table."
  ]
};
function renderWorkflow(o) {
  const which = WHICH_URL[o.provider].map((l) => `#   ${l}`).join("\n");
  const secretNote = o.secret === DEFAULT_SECRET ? `# Setup, once: add the repository secret ${DEFAULT_SECRET} (Settings > Secrets and variables >
# Actions, or \`gh secret set ${DEFAULT_SECRET}\`), holding the database's connection string:` : `# Setup, once: the repository secret ${o.secret} holds the database's connection string:`;
  return `# restoreproof ${VERSION}: a backup of this project's Postgres database, restored into a throwaway
# copy and checked table by table, every time it runs. ${REPO}
#
${secretNote}
${which}
#
# Optional secrets:
#   RESTOREPROOF_PASSPHRASE   encrypts the backup (gpg, AES-256) before it is stored. Required in a
#                             public repository, where anyone can download a run's artifacts.
#   RESTOREPROOF_S3_URL       s3://bucket/prefix: also copy each backup to your own S3, R2, B2 or
#                             MinIO bucket, with RESTOREPROOF_S3_ACCESS_KEY_ID,
#                             RESTOREPROOF_S3_SECRET_ACCESS_KEY, and for R2, B2 or MinIO,
#                             RESTOREPROOF_S3_ENDPOINT (and RESTOREPROOF_S3_REGION if it needs one).
#
# What runs: the steps below and .github/restoreproof/drill.mjs, copied here by
# \`${INSTALL} init\`. Nothing is fetched from agentwares and nothing is sent to it: the backup
# stays in this repository's artifacts (${o.keepDays} days) and, if you add one, your bucket.
name: restoreproof

on:
  schedule:
    - cron: "${o.cron}" # ${describeCron(o.cron)}; GitHub may start it late, or drop it under load
  workflow_dispatch:

permissions:
  contents: read
  actions: read

concurrency:
  group: restoreproof
  cancel-in-progress: false

jobs:
  restore-test:
    name: Back up, restore and compare
    runs-on: ubuntu-24.04
    timeout-minutes: 120
    defaults:
      run:
        shell: bash
    env:
      RESTOREPROOF_DATABASE_URL: \${{ secrets.${o.secret} }}
      RESTOREPROOF_PROVIDER: ${o.provider} # auto, supabase, neon or postgres
      RESTOREPROOF_MAX_ROW_DRIFT: "10" # % a table's restored rows may differ from its live count
      RESTOREPROOF_MAX_SHRINK: "50" # % fewer live rows than at the last good run that fails the test
      RESTOREPROOF_EXCLUDE_SCHEMAS: "" # schemas to leave out of the backup, comma-separated
      RESTOREPROOF_S3_URL: \${{ secrets.RESTOREPROOF_S3_URL }}
    steps:
      - name: Check out the drill
        uses: actions/checkout@v7
        with:
          sparse-checkout: .github/restoreproof
          persist-credentials: false

      - name: Read the last good run's facts and the repository's visibility
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          echo "RESTOREPROOF_VISIBILITY=$(gh repo view "$GITHUB_REPOSITORY" --json visibility --jq .visibility || echo UNKNOWN)" >> "$GITHUB_ENV"
          run=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow restoreproof.yml --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty' || true)
          if [ -n "$run" ]; then
            gh run download "$run" --repo "$GITHUB_REPOSITORY" --name restoreproof-facts --dir "$RUNNER_TEMP/previous" || echo "Run $run kept no facts."
          else
            echo "No earlier successful run: nothing to compare with yet."
          fi

      - name: Read the database's PostgreSQL version
        id: probe
        run: node .github/restoreproof/drill.mjs probe

      - name: Install PostgreSQL \${{ steps.probe.outputs.major }} from the PostgreSQL apt repository
        env:
          PACKAGES: \${{ steps.probe.outputs.packages }}
        run: |
          sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
          sudo apt-get install -y --no-install-recommends $PACKAGES

      - name: Back up, restore into a throwaway copy, compare
        id: drill
        env:
          RESTOREPROOF_PG_BIN: /usr/lib/postgresql/\${{ steps.probe.outputs.major }}/bin
          RESTOREPROOF_PREVIOUS: \${{ runner.temp }}/previous/facts.json
          RESTOREPROOF_OUT: \${{ runner.temp }}/restoreproof
        run: node .github/restoreproof/drill.mjs drill

      - name: Encrypt the backup, or refuse to publish it
        id: seal
        if: \${{ !cancelled() && steps.drill.outputs.backup != '' }}
        env:
          BACKUP: \${{ steps.drill.outputs.backup }}
          RESTOREPROOF_PASSPHRASE: \${{ secrets.RESTOREPROOF_PASSPHRASE }}
        run: |
          file="$BACKUP"
          if [ -n "$RESTOREPROOF_PASSPHRASE" ]; then
            gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --symmetric --cipher-algo AES256 --output "$BACKUP.gpg" "$BACKUP" <<< "$RESTOREPROOF_PASSPHRASE"
            rm -f "$BACKUP"
            file="$BACKUP.gpg"
            echo "Encrypted. To read it: gpg --decrypt --output backup.dump $(basename "$file")"
          fi
          echo "file=$file" >> "$GITHUB_OUTPUT"
          if [ -n "$RESTOREPROOF_PASSPHRASE" ] || [ "$RESTOREPROOF_VISIBILITY" = "PRIVATE" ] || [ "$RESTOREPROOF_VISIBILITY" = "INTERNAL" ]; then
            echo "artifact=true" >> "$GITHUB_OUTPUT"
          elif [ -n "$RESTOREPROOF_S3_URL" ]; then
            echo "This repository is $RESTOREPROOF_VISIBILITY: the unencrypted backup goes to your bucket only, not to the run's artifacts."
          else
            echo "::error title=restoreproof::This repository is $RESTOREPROOF_VISIBILITY, and anyone who can read it can download a run's artifacts. Add the RESTOREPROOF_PASSPHRASE secret to encrypt the backup, or a bucket (RESTOREPROOF_S3_URL)."
            exit 1
          fi

      - name: Keep the backup as an artifact
        if: \${{ !cancelled() && steps.seal.outputs.artifact == 'true' }}
        uses: actions/upload-artifact@v7
        with:
          name: restoreproof-backup-\${{ github.run_number }}
          path: \${{ steps.seal.outputs.file }}
          retention-days: ${o.keepDays}
          compression-level: 0
          if-no-files-found: error

      - name: Copy the backup to your bucket
        if: \${{ !cancelled() && steps.seal.outputs.file != '' && env.RESTOREPROOF_S3_URL != '' }}
        env:
          FILE: \${{ steps.seal.outputs.file }}
          S3_ENDPOINT: \${{ secrets.RESTOREPROOF_S3_ENDPOINT }}
          AWS_ACCESS_KEY_ID: \${{ secrets.RESTOREPROOF_S3_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.RESTOREPROOF_S3_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: \${{ secrets.RESTOREPROOF_S3_REGION || (secrets.RESTOREPROOF_S3_ENDPOINT && 'auto') || 'us-east-1' }}
          AWS_REQUEST_CHECKSUM_CALCULATION: when_required
          AWS_RESPONSE_CHECKSUM_VALIDATION: when_required
        run: |
          key="\${RESTOREPROOF_S3_URL%/}/$(date -u +%Y%m%dT%H%MZ)-run$GITHUB_RUN_NUMBER-$(basename "$FILE")"
          args=()
          if [ -n "$S3_ENDPOINT" ]; then args+=(--endpoint-url "$S3_ENDPOINT"); fi
          aws s3 cp "\${args[@]}" --only-show-errors "$FILE" "$key"
          echo "Copied the backup to your bucket."

      - name: Keep the facts (counts and hashes, no data)
        if: \${{ !cancelled() && steps.drill.outputs.facts != '' }}
        uses: actions/upload-artifact@v7
        with:
          name: restoreproof-facts
          path: \${{ steps.drill.outputs.facts }}
          retention-days: 90
          if-no-files-found: ignore
`;
}
function drillHeader() {
  return [
    `// restoreproof ${VERSION}: the drill .github/workflows/restoreproof.yml runs.`,
    `// Generated from ${REPO} (MIT). It reads your database with pg_dump and psql,`,
    "// restores the backup into a throwaway PostgreSQL on the runner, compares the two, and sends",
    "// nothing anywhere. No dependencies. To update it, run `" + INSTALL + " init --force`.",
    ""
  ].join("\n");
}

// src/init.ts
function repoRoot(dir) {
  let d = path5.resolve(dir);
  for (; ; ) {
    if (existsSync3(path5.join(d, ".git"))) return { root: d, git: true };
    const up = path5.dirname(d);
    if (up === d) return { root: path5.resolve(dir), git: false };
    d = up;
  }
}
function detectProvider(root) {
  if (existsSync3(path5.join(root, "supabase", "config.toml"))) return "supabase";
  try {
    const pkg = JSON.parse(readFileSync3(path5.join(root, "package.json"), "utf8"));
    const deps = { ...pkg["dependencies"], ...pkg["devDependencies"] };
    if (Object.keys(deps).some((d) => d.startsWith("@supabase/"))) return "supabase";
    if (Object.keys(deps).some((d) => d.startsWith("@neondatabase/"))) return "neon";
  } catch {
  }
  return null;
}
function planInit(dir, options, drillSource) {
  if (!existsSync3(dir))
    throw fail(
      "DIR_NOT_FOUND",
      `there is no directory at ${dir}`,
      "Run it in your repository, or pass its path: `restoreproof init path/to/repo`."
    );
  const { root, git } = repoRoot(dir);
  const detected = options.provider === "auto" ? detectProvider(root) : null;
  const files = [
    { path: WORKFLOW_PATH, content: renderWorkflow(options) },
    { path: DRILL_PATH, content: drillHeader() + drillSource }
  ].map((f) => {
    const abs = path5.join(root, f.path);
    const state = !existsSync3(abs) ? "new" : readFileSync3(abs, "utf8") === f.content ? "same" : "differs";
    return { ...f, state };
  });
  return { root, git, detected, files, options };
}
function writeInit(plan, force) {
  const differs = plan.files.filter((f) => f.state === "differs");
  if (differs.length && !force)
    throw fail(
      "FILES_EXIST",
      `${differs.map((f) => f.path).join(" and ")} already exist${differs.length === 1 ? "s" : ""} and differ${differs.length === 1 ? "s" : ""} from what this version writes`,
      "Review the difference, then run init again with --force to replace them (the workflow's settings are re-applied from the options you pass)."
    );
  for (const f of plan.files) {
    if (f.state === "same") continue;
    const abs = path5.join(plan.root, f.path);
    mkdirSync3(path5.dirname(abs), { recursive: true });
    writeFileSync4(abs, f.content);
  }
}
function nextSteps(plan) {
  const provider2 = plan.options.provider === "auto" ? plan.detected ?? "auto" : plan.options.provider;
  const secret = plan.options.secret;
  const lines = [
    "Next:",
    "",
    secret === DEFAULT_SECRET ? `  1. Add the repository secret ${secret}: \`gh secret set ${secret}\` (it asks for the value,` : `  1. The workflow reads the repository secret ${secret}; check it holds the connection string,`,
    secret === DEFAULT_SECRET ? "     and nothing echoes it), holding the connection string:" : "     of this kind:",
    ...WHICH_URL[provider2].map((l) => `       ${l}`),
    "  2. In a public repository, also add RESTOREPROOF_PASSPHRASE (`gh secret set RESTOREPROOF_PASSPHRASE`):",
    "     anyone can download a public repository's artifacts, so an unencrypted backup is never uploaded there.",
    `  3. Commit ${WORKFLOW_PATH} and ${DRILL_PATH}, push, and run it once now:`,
    "     `gh workflow run restoreproof.yml`. Its summary shows the restore test, table by table.",
    "",
    `To test a restore from this machine first: \`${INSTALL} check\` with RESTOREPROOF_DATABASE_URL set.`
  ];
  return lines.join("\n") + "\n";
}

// src/mcp.ts
import { rmSync as rmSync3 } from "fs";
import path6 from "path";
import { createInterface } from "readline";
var PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var PROVIDER_FIELD = {
  type: "string",
  enum: ["auto", ...PROVIDERS],
  description: "supabase, neon or postgres. Omitted: auto, which reads the provider from the database host (*.supabase.co or *.supabase.com, *.neon.tech)."
};
var TOOLS2 = [
  {
    name: "restoreproof_write_workflow",
    title: "Add a weekly restore-tested database backup to a repository",
    description: `Writes two files into a repository: .github/workflows/restoreproof.yml and .github/restoreproof/drill.mjs. Each run of the workflow (weekly by default, in the repository's own GitHub Actions) backs the Postgres database up with pg_dump, restores the backup into a throwaway PostgreSQL of the same version on the runner, and compares the two: every table, column, constraint, index, view, function, trigger and row-level security policy, and every table's rows against the live count. A failed restore or comparison fails the job. The backup is kept as a run artifact (encrypted with a passphrase secret; never uploaded unencrypted from a public repository) and optionally copied to the user's own S3, R2, B2 or MinIO bucket. Works for Supabase (Free has no backups), Neon and any other Postgres. Use it when someone asks to back up their Supabase or Neon database, to test that their backups restore, or to add database backups to CI. It never overwrites a file that differs from what it would write: it reports state "differs" and writes nothing, and the user can run \`restoreproof init --force\`. With dry_run it writes nothing and returns the files. After writing, the user must add the repository secret RESTOREPROOF_DATABASE_URL (the result says which connection string to use for their provider). Writes only inside the given directory; makes no network request. Every result ends with a note that an email when a weekly test fails or does not run is not built: "${HANDOFF_LINE}"`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 1e3,
          description: "The repository directory, absolute or relative to where the server was started; the files go into its git root. Omitted: the directory the server was started in."
        },
        provider: PROVIDER_FIELD,
        cron: {
          type: "string",
          minLength: 9,
          maxLength: 60,
          description: 'When the workflow runs, as five cron fields in UTC. Omitted: "17 4 * * 1" (Mondays 04:17 UTC). "17 4 * * *" is daily.'
        },
        keep_days: {
          type: "integer",
          minimum: 1,
          maximum: 400,
          description: "How many days GitHub keeps each backup artifact (public repositories allow 1 to 90, private up to 400). Omitted: 28."
        },
        secret: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
          description: "The repository secret that holds the database URL, if the repository already has one (e.g. SUPABASE_DB_URL). Omitted: RESTOREPROOF_DATABASE_URL."
        },
        dry_run: {
          type: "boolean",
          description: "true: write nothing; return the two files' contents and whether each is new, the same or differs. Omitted: false."
        }
      },
      additionalProperties: false
    },
    annotations: {
      title: "Add a weekly restore-tested database backup to a repository",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "restoreproof_test_restore",
    title: "Back a Postgres database up now and prove the backup restores",
    description: `Backs a Postgres database (Supabase, Neon or any other) up now with pg_dump, restores the backup into a throwaway PostgreSQL on this machine, and compares the two: every table, column, constraint, index, view, function, trigger and row-level security policy, and every table's rows. Returns the verdict, the tables with live and restored row counts, and what failed and why (version skew, missing extensions, roles, row-level security, Supabase's IPv6-only direct host, Neon's pooled host). Call it before running a migration, a schema change or any destructive command against a database, with keep_backup_in set, so a tested backup exists first; or when someone asks whether their database backup would restore. Or pass dump_file to restore-test a backup file they already have. The database URL is never an argument: it is read from an environment variable of this server's environment (url_env; default RESTOREPROOF_DATABASE_URL, then DATABASE_URL). The source is only read (pg_dump and one READ ONLY transaction). Needs PostgreSQL's programs installed on this machine, of the server's major version or newer. The throwaway copy runs on 127.0.0.1 with a random password and is deleted at the end; the backup is deleted too unless keep_backup_in names a directory. Results hold table names and counts, never rows of data and never the URL.`,
    inputSchema: {
      type: "object",
      properties: {
        url_env: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
          description: "The name of the environment variable that holds the database URL, in this server's environment. Never the URL itself. Omitted: RESTOREPROOF_DATABASE_URL, then DATABASE_URL."
        },
        dump_file: {
          type: "string",
          minLength: 1,
          maxLength: 1e3,
          description: "Instead of backing up a live database: a backup file to restore-test (a pg_dump archive, or a .sql file), absolute or relative to where the server was started. Give this or url_env, not both."
        },
        keep_backup_in: {
          type: "string",
          minLength: 1,
          maxLength: 1e3,
          description: "A directory to keep the new backup in (created if missing). Keep it out of a git checkout: it holds the database's data. Omitted: the backup is deleted after the test."
        },
        provider: PROVIDER_FIELD,
        exclude_schemas: {
          type: "array",
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 63 },
          description: "Schemas to leave out of the backup. Omitted: none beyond the provider's platform schemas."
        }
      },
      additionalProperties: false
    },
    annotations: {
      title: "Back a Postgres database up now and prove the backup restores",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  }
];
function invalid(cause, fix) {
  throw new CliError({ code: "INVALID_INPUT", cause, fix, retryable: false });
}
function checkArgs(tool, raw) {
  if (raw === void 0 || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    invalid(
      "arguments must be an object",
      `Pass { ${Object.keys(tool.inputSchema.properties).join("?, ")}? }.`
    );
  const props = tool.inputSchema.properties;
  const a = raw;
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (!p) invalid(`unknown argument \`${k}\``, `Use only: ${Object.keys(props).join(", ")}.`);
    if (v === void 0) continue;
    if (p.type === "boolean" && typeof v !== "boolean")
      invalid(`\`${k}\` must be true or false`, "Omit it, or pass a boolean.");
    if (p.type === "integer" && (!Number.isInteger(v) || v < p.minimum || v > p.maximum))
      invalid(
        `\`${k}\` must be a whole number from ${String(p.minimum)} to ${String(p.maximum)}`,
        "Omit it, or pass a number in range."
      );
    if (p.type === "string") {
      if (typeof v !== "string" || v.length < p.minLength || v.length > p.maxLength)
        invalid(
          `\`${k}\` must be a string of ${String(p.minLength)} to ${String(p.maxLength)} characters`,
          "Omit it, or pass a string."
        );
      if (Array.isArray(p.enum) && !p.enum.includes(v))
        invalid(`\`${k}\` must be one of ${p.enum.join(", ")}`, "Omit it for auto.");
      if (typeof p.pattern === "string" && !new RegExp(p.pattern).test(v))
        invalid(
          `\`${k}\` does not match ${p.pattern}`,
          "Pass a variable or secret name: letters, digits and underscores."
        );
    }
    if (p.type === "array") {
      if (!Array.isArray(v) || v.length > p.maxItems || v.some((x) => typeof x !== "string" || x.length < 1 || x.length > 63))
        invalid(
          `\`${k}\` must be a list of up to ${String(p.maxItems)} schema names`,
          'Omit it, or pass names such as ["archive"].'
        );
    }
  }
  return a;
}
async function callTool(name, rawArgs, ctx = {}) {
  const tool = TOOLS2.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();
  try {
    const args = checkArgs(tool, rawArgs);
    if (name === "restoreproof_write_workflow") {
      if (!ctx.drillSource) throw new Error("no drill source");
      const options = {
        provider: args.provider ?? "auto",
        cron: checkCron(args.cron ?? DEFAULT_CRON),
        keepDays: checkKeepDays(args.keep_days ?? DEFAULT_KEEP_DAYS),
        secret: checkSecret(args.secret ?? DEFAULT_SECRET)
      };
      const plan = planInit(
        path6.resolve(cwd, args.path ?? "."),
        options,
        ctx.drillSource()
      );
      const dry = args.dry_run === true;
      const differs = plan.files.some((f) => f.state === "differs");
      const written = !dry && !differs;
      if (written) writeInit(plan, false);
      return {
        structured: {
          root: plan.root,
          written,
          files: plan.files.map((f) => ({
            path: f.path,
            state: f.state,
            ...dry ? { content: f.content } : {}
          })),
          ...differs && !dry ? {
            refused: "A file differs from what this version writes, so nothing was written. Show the user the difference; they can replace it with `restoreproof init --force`."
          } : {},
          next_steps: nextSteps(plan),
          note: HANDOFF_LINE
        },
        isError: false
      };
    }
    if (args.dump_file !== void 0 && args.url_env !== void 0)
      invalid(
        "give url_env or dump_file, not both",
        "Pass url_env for a live database, or dump_file for a backup file."
      );
    if (typeof args.dump_file === "string") {
      const result = await drillFile({
        env,
        file: path6.resolve(cwd, args.dump_file),
        now: ctx.now
      });
      return {
        structured: { ...result, note: HANDOFF_LINE },
        isError: false
      };
    }
    const keep = typeof args.keep_backup_in === "string" ? path6.resolve(cwd, args.keep_backup_in) : null;
    const outDir = keep ?? scratchDir();
    try {
      const result = await drillLive({
        env,
        urlEnv: args.url_env,
        provider: args.provider,
        outDir,
        maxRowDrift: 10,
        maxShrink: 100,
        excludeSchemas: args.exclude_schemas ?? [],
        allowNewerMajor: true,
        now: ctx.now
      });
      if (!keep && result.backup)
        result.backup.file = "(deleted after the test; pass keep_backup_in to keep it)";
      return {
        structured: { ...result, note: HANDOFF_LINE },
        isError: false
      };
    } finally {
      if (!keep) rmSync3(outDir, { recursive: true, force: true });
    }
  } catch (err) {
    const body = err instanceof CliError ? err.toJSON() : {
      code: "INTERNAL",
      cause: err instanceof Error ? err.message : String(err),
      fix: "Run restoreproof in a terminal with the same input to see the error in context, and report it at https://github.com/agentwares/restoreproof/issues.",
      retryable: false
    };
    return { structured: { ...body }, isError: true };
  }
}
var INSTRUCTIONS = "restoreproof backs up a Postgres database (Supabase, Neon or any other) and proves the backup restores: it restores into a throwaway PostgreSQL and compares schema and row counts. restoreproof_write_workflow adds a weekly restore-tested backup to a repository's GitHub Actions; restoreproof_test_restore takes and tests a backup now, e.g. before a migration. Database URLs are read from environment variables by name, never passed as arguments.";
async function handleMessage(msg, ctx) {
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleMessage(m, ctx)))).filter(
      (r) => r !== void 0
    );
    return out.length ? out : void 0;
  }
  const req = msg && typeof msg === "object" ? msg : {};
  const hasId = "id" in req && (typeof req.id === "string" || typeof req.id === "number");
  const id = hasId ? req.id : null;
  const error = (code, message) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
  if (!("method" in req) && ("result" in req || "error" in req)) return void 0;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string")
    return hasId || !("method" in req) ? error(-32600, "Invalid Request") : void 0;
  if (!hasId) return void 0;
  const params = req.params && typeof req.params === "object" ? req.params : {};
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "restoreproof", title: "restoreproof", version: VERSION },
          instructions: INSTRUCTIONS
        }
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS2 } };
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !TOOLS2.some((t) => t.name === name))
        return error(
          -32602,
          `Unknown tool: ${String(name)}. Tools: ${TOOLS2.map((t) => t.name).join(", ")}`
        );
      const { structured, isError } = await callTool(name, params.arguments, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError
        }
      };
    }
    default:
      return error(-32601, `Method not found: ${req.method}`);
  }
}
async function serveStdio(ctx = {}) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" }
        }) + "\n"
      );
      continue;
    }
    try {
      const res = await handleMessage(msg, ctx);
      if (res !== void 0) process.stdout.write(JSON.stringify(res) + "\n");
    } catch (err) {
      process.stderr.write(
        `restoreproof mcp: ${err instanceof Error ? err.message : String(err)}
`
      );
    }
  }
}

// src/main.ts
var HELP = `restoreproof ${VERSION} \u2014 a Postgres backup that is restored and checked every time

Usage
  ${INSTALL} init [dir]
      write .github/workflows/restoreproof.yml and .github/restoreproof/drill.mjs into the
      repository at dir (default: this one). Each run backs the database up with pg_dump, restores
      the backup into a throwaway PostgreSQL of the same version on the runner, and compares the
      two: every table, column, constraint, index, view, function, trigger and RLS policy, and
      every table's rows. A failed test fails the job.
        --provider auto|supabase|neon|postgres   only changes which connection string it tells you to use
        --cron "17 4 * * 1"                      when it runs (UTC; default Mondays 04:17)
        --keep-days 28                           how long GitHub keeps each backup artifact
        --secret NAME                            the repository secret with the URL (default ${DEFAULT_SECRET})
        --force                                  replace files that differ; --dry-run writes nothing
  ${INSTALL} check
      the same test from this machine, once: reads RESTOREPROOF_DATABASE_URL (or DATABASE_URL, or
      the variable --url-env names), needs PostgreSQL's programs of the server's version (or newer)
      installed, and deletes the backup afterwards unless --out <dir> keeps it
  ${INSTALL} check --dump <file>
      restore a backup you already have (a pg_dump archive or a .sql file) into a throwaway
      PostgreSQL and list what came back
  ${INSTALL} demo
      a recorded run on a synthetic database: no database, no network
  ${INSTALL} mcp
      a local MCP server over stdio: restoreproof_write_workflow and restoreproof_test_restore

Options
  --json                       the result as JSON
  --exclude-schemas a,b        leave these schemas out of the backup
  --skip-extensions x,y        do not create these extensions in the throwaway copy

The URL is never taken as an argument and never printed. The source is only read: pg_dump and one
READ ONLY transaction of catalog queries and counts. The copy runs on 127.0.0.1 with a random
password and is deleted when the test ends. Nothing is sent to us.
More: ${HANDOFF_URL.replace(/#.*$/, "")}
`;
var defaultDeps = {
  stdout: (s2) => process.stdout.write(s2),
  stderr: (s2) => process.stderr.write(s2)
};
function readDrillSource() {
  try {
    return readFileSync4(fileURLToPath(new URL("./drill.js", import.meta.url)), "utf8");
  } catch {
    throw new CliError({
      code: "DRILL_NOT_BUILT",
      cause: "this copy of restoreproof has no dist/drill.js to write into the repository",
      fix: "Run it from the published package, or build it first (`pnpm build`).",
      retryable: false
    });
  }
}
async function main(argv, deps = defaultDeps) {
  const json = argv.includes("--json");
  try {
    return await run2(argv, deps);
  } catch (e) {
    if (e instanceof CliError) {
      (json ? deps.stdout : deps.stderr)(renderError(e.toJSON(), json));
      return e.exitCode;
    }
    throw e;
  }
}
var COMMANDS = ["init", "check", "demo", "mcp", "probe", "drill", "help"];
var PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
var RECORDED_RUN = "examples/recorded-run.json";
function provider(raw) {
  const v = (raw ?? "auto").toLowerCase();
  if (v === "auto" || PROVIDERS.includes(v)) return v;
  throw usage(
    `--provider is auto, supabase, neon or postgres, got "${raw}"`,
    "e.g. `--provider supabase`"
  );
}
async function run2(argv, deps) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        provider: { type: "string" },
        cron: { type: "string" },
        "keep-days": { type: "string" },
        secret: { type: "string" },
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "url-env": { type: "string" },
        dump: { type: "string" },
        out: { type: "string" },
        "exclude-schemas": { type: "string" },
        "skip-extensions": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" }
      }
    });
  } catch (e) {
    throw usage(
      e instanceof Error ? e.message : String(e),
      `run \`${INSTALL} --help\` for the options`
    );
  }
  const { values, positionals } = parsed;
  if (values.version) {
    deps.stdout(`${VERSION}
`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === "help" || command === void 0) {
    deps.stdout(HELP);
    return command === void 0 && !values.help ? 2 : 0;
  }
  if (!COMMANDS.includes(command))
    throw usage(`unknown command "${command}"`, `run \`${INSTALL} --help\` for the commands`);
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => /* @__PURE__ */ new Date());
  if (command === "probe" || command === "drill") {
    if (rest.length)
      throw usage(
        `${command} takes no arguments; it reads the workflow's environment`,
        "see .github/workflows/restoreproof.yml"
      );
    const ci = { env, stdout: deps.stdout, stderr: deps.stderr, now };
    return command === "probe" ? probeCommand(ci) : drillCommand(ci);
  }
  if (command === "mcp") {
    if (rest.length) throw usage("mcp takes no arguments", `run \`${INSTALL} mcp\``);
    await serveStdio({ env, cwd, now, drillSource: deps.drillSource ?? readDrillSource });
    return 0;
  }
  if (command === "demo") {
    if (rest.length) throw usage("demo takes no arguments", `run \`${INSTALL} demo\``);
    const recorded = JSON.parse(
      readFileSync4(path7.join(PACKAGE_ROOT, RECORDED_RUN), "utf8")
    );
    if (!values.json)
      deps.stdout(
        "A recorded run on a synthetic database (examples/synthetic-source.sql): not anyone's data.\n\n"
      );
    deps.stdout(values.json ? renderJson(recorded) : renderText(recorded));
    return 0;
  }
  if (command === "init") {
    if (rest.length > 1)
      throw usage(`init takes one directory, got ${rest.length}`, `run \`${INSTALL} init [dir]\``);
    const options = {
      provider: provider(values.provider),
      cron: checkCron(values.cron ?? DEFAULT_CRON),
      keepDays: checkKeepDays(values["keep-days"] ?? DEFAULT_KEEP_DAYS),
      secret: checkSecret(values.secret ?? DEFAULT_SECRET)
    };
    const plan = planInit(
      path7.resolve(cwd, rest[0] ?? "."),
      options,
      (deps.drillSource ?? readDrillSource)()
    );
    if (!values["dry-run"]) writeInit(plan, !!values.force);
    if (values.json) {
      deps.stdout(
        JSON.stringify(
          {
            root: plan.root,
            written: !values["dry-run"],
            files: plan.files.map((f) => ({
              path: f.path,
              state: f.state,
              bytes: Buffer.byteLength(f.content)
            })),
            provider: plan.options.provider,
            detected: plan.detected
          },
          null,
          2
        ) + "\n"
      );
      return 0;
    }
    const verb = values["dry-run"] ? "would write" : "wrote";
    for (const f of plan.files)
      deps.stdout(
        `${f.state === "same" ? "unchanged" : f.state === "differs" ? `${verb} (replacing)` : verb}  ${path7.join(plan.root, f.path)}
`
      );
    if (!plan.git)
      deps.stdout(`(${plan.root} is not a git checkout; the files go where you run init)
`);
    if (plan.detected)
      deps.stdout(
        `This repository looks like ${plan.detected === "supabase" ? "a Supabase" : "a Neon"} project.
`
      );
    deps.stdout("\n" + nextSteps(plan));
    return 0;
  }
  if (rest.length)
    throw usage(
      "check takes no arguments; the URL comes from the environment",
      `run \`${INSTALL} check\` with RESTOREPROOF_DATABASE_URL set, or \`check --dump <file>\``
    );
  const log = values.json ? () => void 0 : (l) => deps.stderr(`restoreproof: ${l}
`);
  if (values.dump) {
    const result = await drillFile({
      env,
      file: path7.resolve(cwd, values.dump),
      skipExtensions: listFrom(values["skip-extensions"]),
      now,
      log
    });
    deps.stdout(values.json ? renderJson(result) : renderText(result));
    return result.ok ? 0 : 1;
  }
  const keep = values.out ? path7.resolve(cwd, values.out) : null;
  const outDir = keep ?? scratchDir();
  try {
    const result = await drillLive({
      env,
      urlEnv: values["url-env"],
      provider: values.provider === void 0 ? void 0 : provider(values.provider),
      outDir,
      maxRowDrift: 10,
      maxShrink: 100,
      previous: null,
      excludeSchemas: listFrom(values["exclude-schemas"]),
      skipExtensions: listFrom(values["skip-extensions"]),
      allowNewerMajor: true,
      now,
      log
    });
    const kept = keep ? result.backup?.file ?? null : null;
    if (!keep && result.backup)
      result.backup.file = "(deleted after the test; --out <dir> keeps it)";
    deps.stdout(values.json ? renderJson(result) : renderText(result, { kept }));
    return result.ok ? 0 : 1;
  } finally {
    if (!keep) rmSync4(outDir, { recursive: true, force: true });
  }
}

// src/cli.ts
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`restoreproof: ${err instanceof Error ? err.message : String(err)}
`);
    process.exitCode = 1;
  }
);
