interface Probe {
    /** e.g. 170006 */
    versionNum: number;
    /** e.g. "17.6" or "17.6 (Debian 17.6-1.pgdg120+1)" */
    version: string;
    major: number;
    /** superuser or BYPASSRLS: pg_dump reads past row-level security */
    privileged: boolean;
    /** bytes, pg_database_size */
    size: number;
    /** every schema but pg_* and information_schema */
    schemas: string[];
    extensions: {
        name: string;
        schema: string;
    }[];
    /** roles named by policies or user mappings: the copy needs them to exist */
    rolesUsed: string[];
    /** tables row-level security would hide from this role, so pg_dump would fail on them */
    rlsBlocked: {
        table: string;
        schema: string;
    }[];
}
declare function parseProbe(stdout: string): Probe;
interface Facts {
    version: string;
    versionNum: number;
    /** `kind name` → definition hash (or detail, for tables) */
    objects: Record<string, string>;
    /** leaf table `schema.name` → exact row count */
    rows: Record<string, number>;
    /** extension name → version */
    extensions: Record<string, string>;
}
declare function parseFacts(stdout: string): Facts;

type Level = "fail" | "warn" | "note";
interface Finding {
    level: Level;
    code: string;
    /** the finding, naming the tables and objects it is about */
    message: string;
    /**
     * the same without any table, object or extension name or per-table count: what a public
     * repository's run summary shows, since anyone can read it
     */
    summary: string;
}
interface TableCheck {
    table: string;
    live: number;
    restored: number | null;
    verdict: "match" | "changed" | "differs" | "empty" | "missing";
}
interface Previous {
    at: string;
    rows: number;
    /** table names, or their hashes (hashName) when that run was in a public repository */
    tables: string[];
    tablesHashed?: boolean;
    backupBytes: number;
}
/** A table name as a public repository's facts file keeps it: a short SHA-256. */
declare function hashName(name: string): string;
interface CompareOptions {
    /** percent a table may differ from its live count; default 10 */
    maxRowDrift: number;
    /** percent fewer live rows than the last good run that fails; default 50; 100 turns it off */
    maxShrink: number;
    backupBytes: number;
    previous?: Previous | null;
    /** extensions left out of the copy, and why */
    skippedExtensions?: {
        name: string;
        why: string;
    }[];
    skippedForeign?: number;
}
interface Comparison {
    ok: boolean;
    findings: Finding[];
    tables: TableCheck[];
    objects: {
        source: number;
        restored: number;
        missing: number;
        changed: number;
        byKind: Record<string, number>;
    };
    rows: {
        live: number;
        restored: number;
    };
    sameMajor: boolean;
}
/** The most rows a table may differ by: max(10, drift% of its live count). */
declare function allowance(live: number, driftPct: number): number;
declare function compare(source: Facts, restored: Facts, opts: CompareOptions): Comparison;
declare function bytes(n: number): string;

/** Every error and warning carries what went wrong, why, how to fix it, and whether a retry helps. */
interface Problem {
    code: string;
    cause: string;
    fix: string;
    retryable: boolean;
}
declare class CliError extends Error implements Problem {
    readonly code: string;
    readonly cause: string;
    readonly fix: string;
    readonly retryable: boolean;
    /** 2 for a usage mistake, 1 for anything else */
    readonly exitCode: number;
    constructor(p: Problem, exitCode?: number);
    toJSON(): Problem;
}

type Provider = "supabase" | "neon" | "postgres";
interface Connection {
    /** libpq environment variables: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, … */
    env: Record<string, string>;
    host: string;
    port: number;
    /** URI parameters libpq does not read (Prisma's `schema`, `pgbouncer`, …), ignored */
    ignored: string[];
}
/** Parse a `postgres://` or `postgresql://` URI. Throws BAD_DATABASE_URL, naming no part of it. */
declare function parseDatabaseUrl(raw: string): Connection;
/** The provider a host belongs to. */
declare function providerOf(host: string): Provider;
/**
 * Refuse the connection strings the providers document as unusable for `pg_dump`, before anything
 * connects: Supabase's transaction pooler and Neon's pooled endpoint.
 */
declare function checkConnection(conn: Connection): void;

/**
 * What goes into the backup, per provider, and what the throwaway copy leaves out.
 *
 * Supabase runs platform services inside the database. Their schemas belong to extensions or to
 * services that recreate them (GraphQL, Vault, Realtime, pg_net, pg_cron, the pooler, analytics),
 * so the backup leaves them out, as `supabase db dump` does. It keeps what is the customer's: their
 * own schemas, `public`, and the `auth` and `storage` tables (users, identities, buckets and the
 * metadata of stored objects), plus `supabase_migrations` and `supabase_functions` (database
 * webhooks). Supabase's own restore guide leaves out the data of two Storage vector tables; so does
 * this.
 */

/** Supabase schemas the backup leaves out: extension-owned or recreated by the platform. */
declare const SUPABASE_EXCLUDED_SCHEMAS: readonly ["graphql", "graphql_public", "vault", "pgsodium", "pgsodium_masks", "net", "cron", "realtime", "_realtime", "_analytics", "_supavisor", "pgbouncer", "pgtle"];
/**
 * Extensions never created in the throwaway copy, whatever the source has: they schedule work,
 * make HTTP requests or need a server key, and a restored copy must not act. Objects that need them
 * are reported, not run.
 */
declare const NEVER_IN_COPY: readonly ["pg_cron", "pg_net", "http", "pgsodium", "supabase_vault", "pgaudit", "pg_stat_monitor", "dblink", "postgres_fdw", "wrappers"];
/** The apt packages the throwaway copy needs: the server of `major`, then extension packages. */
declare function aptPackages(major: number, extensions: readonly string[]): string[];
interface Scope {
    /** schemas in the backup and in the comparison */
    schemas: string[];
    /** schemas pg_dump is told to leave out */
    excludedSchemas: string[];
    /** tables whose rows pg_dump leaves out */
    excludedTableData: string[];
}
/**
 * The backup's schemas: every non-system schema of the source, less the provider's platform
 * schemas and any the customer names (RESTOREPROOF_EXCLUDE_SCHEMAS).
 */
declare function scopeFor(provider: Provider, schemas: readonly string[], extraExcluded: readonly string[]): Scope;

type Env = Record<string, string | undefined>;
/** The variables a database URL is read from, in order, when none is named. */
declare const URL_VARIABLES: readonly ["RESTOREPROOF_DATABASE_URL", "DATABASE_URL"];
interface Source {
    conn: Connection;
    provider: Provider;
    probe: Probe;
    /** the variable the URL came from: its name, never its value */
    variable: string;
}
/** Read the URL from the environment (never an argument), parse it and refuse known traps. */
declare function sourceUrl(env: Env, urlEnv?: string): {
    conn: Connection;
    variable: string;
};
/** Connect once and read what the drill needs: version, schemas, extensions, roles, RLS. */
declare function probeSource(env: Env, urlEnv: string | undefined, providerSetting: string | undefined): Promise<Source>;
interface DrillOptions {
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
interface DrillResult {
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
    backup: {
        file: string;
        bytes: number;
        seconds: number;
        tool: string;
    } | null;
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
/** The pg_dump arguments: custom format, no owners or grants, the scope's exclusions. */
declare function dumpArgs(file: string, scope: Scope): string[];
/** The whole drill on a live database. */
declare function drillLive(opts: DrillOptions): Promise<DrillResult>;
/** What kind of file a backup is: a pg_dump archive (custom, tar or directory) or plain SQL. */
declare function backupKind(file: string): "archive" | "sql";
interface FileDrillOptions {
    env: Env;
    file: string;
    skipExtensions?: string[];
    now?: () => Date;
    log?: (line: string) => void;
}
/** Restore a backup someone already has into a throwaway copy, and report what came back. */
declare function drillFile(opts: FileDrillOptions): Promise<DrillResult>;

interface CiDeps {
    env: Env;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    now?: () => Date;
}
/** Whether summaries and facts must name no table: a public repository, or one we cannot tell. */
declare function shouldRedact(env: Env): boolean;
/** `probe`: the server's major version and the apt packages the copy needs. */
declare function probeCommand(deps: CiDeps): Promise<number>;
/** `drill`: the whole test, as the workflow runs it. */
declare function drillCommand(deps: CiDeps): Promise<number>;

declare const TOOLS$1: readonly ["pg_dump", "pg_restore", "psql", "initdb", "pg_ctl"];
type Tool = (typeof TOOLS$1)[number];
interface PgBin {
    dir: string;
    major: number;
    /** e.g. "17.6" */
    version: string;
    path(tool: Tool): string;
}
/** `pg_dump (PostgreSQL) 17.6 (Homebrew)` → 17.6; `16beta1` → 16. */
declare function parseToolVersion(text: string): {
    major: number;
    version: string;
} | null;
/**
 * PostgreSQL's programs of exactly `major` (or, with `orNewer`, the nearest newer major found),
 * from RESTOREPROOF_PG_BIN or the usual places. Throws PG_BIN_NOT_FOUND or PG_VERSION_SKEW.
 */
declare function findPgBin(major: number, env: Record<string, string | undefined>, orNewer?: boolean): Promise<PgBin>;

interface Cluster {
    /** libpq environment for the copy's `postgres` database */
    env: Record<string, string>;
    port: number;
    dir: string;
    stop(): Promise<void>;
}
interface StartOptions {
    bin: PgBin;
    baseEnv: Record<string, string | undefined>;
    /** where the temporary directory goes; default the OS temp directory */
    parent?: string;
    /** seconds to wait for start-up */
    waitSeconds?: number;
}
declare function startCluster(opts: StartOptions): Promise<Cluster>;

/**
 * The hand-off, worded as not built (brief DOOR-16). agentcheck's hourly watch checks MCP servers
 * only, and nothing of ours takes a ping from a job. GitHub emails one person when a scheduled run
 * fails; nobody is told when it never runs. So every run and every page ends with the same sentence
 * and a link to the /restoreproof waitlist button, whose click is the count. No price is named
 * until one is decided and its checkout works.
 */
/** The pages, on agentcheck. */
declare const PAGES_URL = "https://agentwares-agentcheck.vercel.app/restoreproof";
/** What the CLI's links put in `?ref=`, recorded through agentcheck's page-view beacon. */
declare const REF = "restoreproof";
/** Where a run's hand-off line points: the landing page's watch section. */
declare const HANDOFF_URL = "https://agentwares-agentcheck.vercel.app/restoreproof?ref=restoreproof#watch";
/** The hand-off, word for word, at the end of every run and in the watch section of every page. */
declare const HANDOFF_LINE = "An email when a weekly restore test fails or does not run is not built.";
/** What it would do, what GitHub does today, and what agentcheck's free watch covers today. */
declare const HANDOFF_DETAIL: string;

declare const WORKFLOW_PATH = ".github/workflows/restoreproof.yml";
declare const DRILL_PATH = ".github/restoreproof/drill.mjs";
interface WorkflowOptions {
    provider: Provider | "auto";
    cron: string;
    keepDays: number;
    /** the repository secret holding the database URL */
    secret: string;
}
declare function renderWorkflow(o: WorkflowOptions): string;

interface PlannedFile {
    /** relative to the repository root */
    path: string;
    content: string;
    /** "new", "same" (already there, identical) or "differs" (there, and not identical) */
    state: "new" | "same" | "differs";
}
interface InitPlan {
    root: string;
    /** whether `root` is a git checkout */
    git: boolean;
    /** the provider the repository's files point to, when the option was auto */
    detected: Provider | null;
    files: PlannedFile[];
    options: WorkflowOptions;
}
/** The repository root: the nearest directory up from `dir` with a .git, else `dir` itself. */
declare function repoRoot(dir: string): {
    root: string;
    git: boolean;
};
/** Supabase or Neon, from the repository's own files; null when nothing says. */
declare function detectProvider(root: string): Provider | null;
declare function planInit(dir: string, options: WorkflowOptions, drillSource: string): InitPlan;
/** Write the plan. Refuses, writing nothing, while a file differs and `force` is not set. */
declare function writeInit(plan: InitPlan, force: boolean): void;
/** What to do next, printed after the files are written. */
declare function nextSteps(plan: InitPlan): string;

/**
 * How to run restoreproof: the one constant behind every place the command is shown or printed
 * (`--help` and the CLI's own hints, the README, the plugin skill and marketplace, and agentcheck's
 * /restoreproof pages).
 *
 * npm does not serve `restoreproof` yet, so it runs from the public repo, whose committed dist/
 * needs no build (scripts/sync-oss-repos.sh). The day npm serves it, flip ON_NPM and rewrite the
 * rest:
 *
 *   RESTOREPROOF_WRITE_INSTALL=1 pnpm --filter restoreproof exec vitest run src/distribution
 *
 * The GitHub form carries `--allow-git=root`: npm 12 refuses a git spec unless `--allow-git`
 * permits it (its default is `none`), `root` permits only the spec named on the command line, and
 * npm 10 and 11 accept the flag (the same form as REL-1, checked 8 Oct 2026).
 *
 * src/distribution.test.ts fails while any surface names another form of the command.
 */
declare const ON_NPM: boolean;
/**
 * Whether the public repo agentwares/restoreproof is up, so that INSTALL resolves. Until it is,
 * agentcheck's /restoreproof pages (which import a mirror of this file) show no `npx` line, only
 * the by-hand restore test anyone can run today: a page never prints a command that 404s. The
 * README and the CLI live in that repo, so they name the command as they are.
 *
 * Flip it to true the day the sync has pushed the repo, then rewrite the mirror:
 *
 *   RESTOREPROOF_WRITE_INSTALL=1 pnpm --filter restoreproof exec vitest run src/distribution
 */
declare const PUBLISHED: boolean;
declare const REPO = "https://github.com/agentwares/restoreproof";
/** What a person types. */
declare const INSTALL: string;
/** What an agent runs unattended: no install prompt, and on npm the newest version, not a cached one. */
declare const RUN: string;

declare const HELP: string;
interface Deps {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    now?: () => Date;
    cwd?: string;
    env?: Env;
    /** the drill bundle init vendors; default dist/drill.js beside this file */
    drillSource?: () => string;
}
declare function main(argv: string[], deps?: Deps): Promise<number>;
declare const RECORDED_RUN = "examples/recorded-run.json";

interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
        additionalProperties: false;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
}
declare const TOOLS: readonly ToolDefinition[];
interface McpContext {
    env?: Env;
    cwd?: string;
    now?: () => Date;
    drillSource?: () => string;
}
declare function callTool(name: string, rawArgs: unknown, ctx?: McpContext): Promise<{
    structured: Record<string, unknown>;
    isError: boolean;
}>;
declare function handleMessage(msg: unknown, ctx: McpContext): Promise<unknown>;

/**
 * The drill's result, for a terminal, for a GitHub step summary, and as the facts file the next
 * run compares with. With `redact` (a public repository, whose run summaries and artifacts anyone
 * can read) nothing names a table or gives a per-table count: totals and verdicts only.
 */

interface RenderOptions {
    redact?: boolean;
    /** check mode: whether the backup file was kept, and where */
    kept?: string | null;
}
declare function renderText(r: DrillResult, opts?: RenderOptions): string;
/** The GitHub step summary. */
declare function renderMarkdown(r: DrillResult, opts?: RenderOptions): string;
declare function renderJson(r: DrillResult): string;

interface FactsFile {
    tool: "restoreproof";
    version: string;
    at: string;
    ok: boolean;
    provider: string | null;
    redacted: boolean;
    source: {
        version: string;
        bytes: number;
    } | null;
    backupBytes: number;
    rows: number;
    /** table names, or their hashes when redacted */
    tables: string[];
    /** per-table live counts, only when not redacted */
    rowsByTable?: Record<string, number>;
}
/** What the next run compares with: counts and names (or hashes), never data. */
declare function factsFile(r: DrillResult, redact: boolean): FactsFile;
/**
 * The last good run's facts, as compare() takes them. When that run was redacted, its table names
 * are hashes, compared as hashes, and a gone table is reported without its name.
 */
declare function previousFrom(text: string): Previous | null;

/** What the drill needs to know about the source before it dumps it. */
declare const PROBE_SQL = "\nSELECT 'version', current_setting('server_version_num'), current_setting('server_version');\nSELECT 'role', (r.rolsuper OR r.rolbypassrls)::text, ''\n  FROM pg_roles r WHERE r.rolname = current_user;\nSELECT 'size', pg_database_size(current_database())::text, '';\nSELECT 'schema', n.nspname, ''\n  FROM pg_namespace n\n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'\n ORDER BY 2;\nSELECT 'extension', e.extname, n.nspname\n  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace\n WHERE e.extname <> 'plpgsql'\n ORDER BY 2;\nSELECT DISTINCT 'role_used', r::text, ''\n  FROM pg_policies, unnest(roles) AS r\n WHERE r::text <> 'public';\nSELECT DISTINCT 'role_used', usename::text, ''\n  FROM pg_user_mappings\n WHERE usename::text <> 'public';\nSELECT 'rls_blocked', n.nspname || '.' || c.relname, n.nspname\n  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace\n WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity\n   AND NOT pg_has_role(c.relowner, 'USAGE')\n   AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls));\n";
/**
 * The schema of everything in `schemas` that is not part of an extension: tables and their RLS
 * flags, columns, constraints, indexes, views, functions, triggers, policies, sequences, enums and
 * domains; the extensions; and the exact row count of every leaf table (partitions, not their
 * parents), through `query_to_xml`, so that every count comes from the transaction's one snapshot.
 */
declare function factsSql(schemas: readonly string[], opts: {
    readOnly: boolean;
}): string;

/**
 * The archive's table of contents (`pg_restore -l`), and the list the restore follows
 * (`pg_restore -L`). The list leaves out:
 *
 * - extensions the copy does not have or must not run (src/scope.ts), with their comments;
 * - foreign-data wrappers, servers, user mappings and foreign tables: they point at other systems,
 *   and a backup holds none of their rows.
 *
 * Everything else restores as dumped, and fails the test if it cannot.
 */
interface TocEntry {
    line: string;
    /** e.g. "TABLE", "TABLE DATA", "EXTENSION", "FK CONSTRAINT" */
    type: string;
    rest: string;
}
declare function parseToc(text: string): {
    header: string[];
    entries: TocEntry[];
};
interface Filtered {
    list: string;
    skippedExtensions: string[];
    skippedForeign: number;
    /** extensions the archive creates */
    extensions: string[];
}
/** The `-L` list without the entries named above. */
declare function filterToc(text: string, skipExtension: (name: string) => boolean): Filtered;

/**
 * The package version, as a constant rather than read from package.json: the drill is copied into
 * customers' repos as one file (`.github/restoreproof/drill.mjs`) with no package.json beside it.
 * src/distribution.test.ts holds it equal to package.json's.
 */
declare const VERSION = "0.1.0";

export { CliError, type Cluster, type Comparison, DRILL_PATH, type DrillResult, type Facts, type Finding, HANDOFF_DETAIL, HANDOFF_LINE, HANDOFF_URL, HELP, INSTALL, NEVER_IN_COPY, ON_NPM, PAGES_URL, PROBE_SQL, PUBLISHED, type Previous, type Probe, type Problem, RECORDED_RUN, REF, REPO, RUN, SUPABASE_EXCLUDED_SCHEMAS, TOOLS, type TableCheck, URL_VARIABLES, VERSION, WORKFLOW_PATH, allowance, aptPackages, backupKind, bytes, callTool, checkConnection, compare, detectProvider, drillCommand, drillFile, drillLive, dumpArgs, factsFile, factsSql, filterToc, findPgBin, handleMessage, hashName, main, nextSteps, parseDatabaseUrl, parseFacts, parseProbe, parseToc, parseToolVersion, planInit, previousFrom, probeCommand, probeSource, providerOf, renderJson, renderMarkdown, renderText, renderWorkflow, repoRoot, scopeFor, shouldRedact, sourceUrl, startCluster, writeInit };
