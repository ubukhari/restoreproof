/**
 * `restoreproof mcp`: a local MCP server over stdio with two tools, so an agent can set up the
 * weekly restore test in a repository, and take and test a backup before it runs a migration or a
 * destructive command.
 *
 * Implemented here rather than on the MCP SDK so the package has no runtime dependencies. It speaks
 * the initialize-based protocol revisions (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05):
 * newline-delimited JSON-RPC on stdin/stdout, `initialize`, `ping`, `tools/list`, `tools/call`. Any
 * other method answers -32601. Nothing but protocol goes to stdout.
 *
 * No tool takes a connection string: `restoreproof_test_restore` takes the *name* of an environment
 * variable of the server's own environment, so a URL never passes through a model. What the tools
 * return goes to the agent's model provider like any tool result: table names, counts and verdicts,
 * never a row of data and never the URL.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { drillFile, drillLive, scratchDir, type Env } from "./drill.js";
import { CliError } from "./errors.js";
import { HANDOFF_LINE } from "./handoff.js";
import { nextSteps, planInit, writeInit } from "./init.js";
import { PROVIDERS, type Provider } from "./url.js";
import { VERSION } from "./version.js";
import {
  DEFAULT_CRON,
  DEFAULT_KEEP_DAYS,
  DEFAULT_SECRET,
  checkCron,
  checkKeepDays,
  checkSecret,
} from "./workflow.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface ToolDefinition {
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

const PROVIDER_FIELD = {
  type: "string",
  enum: ["auto", ...PROVIDERS],
  description:
    "supabase, neon or postgres. Omitted: auto, which reads the provider from the database host (*.supabase.co or *.supabase.com, *.neon.tech).",
};

export const TOOLS: readonly ToolDefinition[] = [
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
          maxLength: 1000,
          description:
            "The repository directory, absolute or relative to where the server was started; the files go into its git root. Omitted: the directory the server was started in.",
        },
        provider: PROVIDER_FIELD,
        cron: {
          type: "string",
          minLength: 9,
          maxLength: 60,
          description:
            'When the workflow runs, as five cron fields in UTC. Omitted: "17 4 * * 1" (Mondays 04:17 UTC). "17 4 * * *" is daily.',
        },
        keep_days: {
          type: "integer",
          minimum: 1,
          maximum: 400,
          description:
            "How many days GitHub keeps each backup artifact (public repositories allow 1 to 90, private up to 400). Omitted: 28.",
        },
        secret: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
          description:
            "The repository secret that holds the database URL, if the repository already has one (e.g. SUPABASE_DB_URL). Omitted: RESTOREPROOF_DATABASE_URL.",
        },
        dry_run: {
          type: "boolean",
          description:
            "true: write nothing; return the two files' contents and whether each is new, the same or differs. Omitted: false.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Add a weekly restore-tested database backup to a repository",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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
          description:
            "The name of the environment variable that holds the database URL, in this server's environment. Never the URL itself. Omitted: RESTOREPROOF_DATABASE_URL, then DATABASE_URL.",
        },
        dump_file: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description:
            "Instead of backing up a live database: a backup file to restore-test (a pg_dump archive, or a .sql file), absolute or relative to where the server was started. Give this or url_env, not both.",
        },
        keep_backup_in: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description:
            "A directory to keep the new backup in (created if missing). Keep it out of a git checkout: it holds the database's data. Omitted: the backup is deleted after the test.",
        },
        provider: PROVIDER_FIELD,
        exclude_schemas: {
          type: "array",
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 63 },
          description:
            "Schemas to leave out of the backup. Omitted: none beyond the provider's platform schemas.",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Back a Postgres database up now and prove the backup restores",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

export interface McpContext {
  env?: Env;
  cwd?: string;
  now?: () => Date;
  drillSource?: () => string;
}

function invalid(cause: string, fix: string): never {
  throw new CliError({ code: "INVALID_INPUT", cause, fix, retryable: false });
}

function checkArgs(tool: ToolDefinition, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    invalid(
      "arguments must be an object",
      `Pass { ${Object.keys(tool.inputSchema.properties).join("?, ")}? }.`,
    );
  const props = tool.inputSchema.properties;
  const a = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (!p) invalid(`unknown argument \`${k}\``, `Use only: ${Object.keys(props).join(", ")}.`);
    if (v === undefined) continue;
    if (p.type === "boolean" && typeof v !== "boolean")
      invalid(`\`${k}\` must be true or false`, "Omit it, or pass a boolean.");
    if (
      p.type === "integer" &&
      (!Number.isInteger(v) ||
        (v as number) < (p.minimum as number) ||
        (v as number) > (p.maximum as number))
    )
      invalid(
        `\`${k}\` must be a whole number from ${String(p.minimum)} to ${String(p.maximum)}`,
        "Omit it, or pass a number in range.",
      );
    if (p.type === "string") {
      if (
        typeof v !== "string" ||
        v.length < (p.minLength as number) ||
        v.length > (p.maxLength as number)
      )
        invalid(
          `\`${k}\` must be a string of ${String(p.minLength)} to ${String(p.maxLength)} characters`,
          "Omit it, or pass a string.",
        );
      if (Array.isArray(p.enum) && !(p.enum as string[]).includes(v))
        invalid(`\`${k}\` must be one of ${(p.enum as string[]).join(", ")}`, "Omit it for auto.");
      if (typeof p.pattern === "string" && !new RegExp(p.pattern).test(v))
        invalid(
          `\`${k}\` does not match ${p.pattern}`,
          "Pass a variable or secret name: letters, digits and underscores.",
        );
    }
    if (p.type === "array") {
      if (
        !Array.isArray(v) ||
        v.length > (p.maxItems as number) ||
        v.some((x) => typeof x !== "string" || x.length < 1 || x.length > 63)
      )
        invalid(
          `\`${k}\` must be a list of up to ${String(p.maxItems)} schema names`,
          'Omit it, or pass names such as ["archive"].',
        );
    }
  }
  return a;
}

export async function callTool(
  name: string,
  rawArgs: unknown,
  ctx: McpContext = {},
): Promise<{ structured: Record<string, unknown>; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();
  try {
    const args = checkArgs(tool, rawArgs);
    if (name === "restoreproof_write_workflow") {
      if (!ctx.drillSource) throw new Error("no drill source");
      const options = {
        provider: ((args.provider as string | undefined) ?? "auto") as Provider | "auto",
        cron: checkCron((args.cron as string | undefined) ?? DEFAULT_CRON),
        keepDays: checkKeepDays((args.keep_days as number | undefined) ?? DEFAULT_KEEP_DAYS),
        secret: checkSecret((args.secret as string | undefined) ?? DEFAULT_SECRET),
      };
      const plan = planInit(
        path.resolve(cwd, (args.path as string | undefined) ?? "."),
        options,
        ctx.drillSource(),
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
            ...(dry ? { content: f.content } : {}),
          })),
          ...(differs && !dry
            ? {
                refused:
                  "A file differs from what this version writes, so nothing was written. Show the user the difference; they can replace it with `restoreproof init --force`.",
              }
            : {}),
          next_steps: nextSteps(plan),
          note: HANDOFF_LINE,
        },
        isError: false,
      };
    }
    if (args.dump_file !== undefined && args.url_env !== undefined)
      invalid(
        "give url_env or dump_file, not both",
        "Pass url_env for a live database, or dump_file for a backup file.",
      );
    if (typeof args.dump_file === "string") {
      const result = await drillFile({
        env,
        file: path.resolve(cwd, args.dump_file),
        now: ctx.now,
      });
      return {
        structured: { ...result, note: HANDOFF_LINE } as unknown as Record<string, unknown>,
        isError: false,
      };
    }
    const keep =
      typeof args.keep_backup_in === "string" ? path.resolve(cwd, args.keep_backup_in) : null;
    const outDir = keep ?? scratchDir();
    try {
      const result = await drillLive({
        env,
        urlEnv: args.url_env as string | undefined,
        provider: args.provider as string | undefined,
        outDir,
        maxRowDrift: 10,
        maxShrink: 100,
        excludeSchemas: (args.exclude_schemas as string[] | undefined) ?? [],
        allowNewerMajor: true,
        now: ctx.now,
      });
      if (!keep && result.backup)
        result.backup.file = "(deleted after the test; pass keep_backup_in to keep it)";
      return {
        structured: { ...result, note: HANDOFF_LINE } as unknown as Record<string, unknown>,
        isError: false,
      };
    } finally {
      if (!keep) rmSync(outDir, { recursive: true, force: true });
    }
  } catch (err) {
    const body =
      err instanceof CliError
        ? err.toJSON()
        : {
            code: "INTERNAL",
            cause: err instanceof Error ? err.message : String(err),
            fix: "Run restoreproof in a terminal with the same input to see the error in context, and report it at https://github.com/agentwares/restoreproof/issues.",
            retryable: false,
          };
    return { structured: { ...body }, isError: true };
  }
}

interface Request {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const INSTRUCTIONS =
  "restoreproof backs up a Postgres database (Supabase, Neon or any other) and proves the backup restores: it restores into a throwaway PostgreSQL and compares schema and row counts. restoreproof_write_workflow adds a weekly restore-tested backup to a repository's GitHub Actions; restoreproof_test_restore takes and tests a backup now, e.g. before a migration. Database URLs are read from environment variables by name, never passed as arguments.";

export async function handleMessage(msg: unknown, ctx: McpContext): Promise<unknown> {
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleMessage(m, ctx)))).filter(
      (r) => r !== undefined,
    );
    return out.length ? out : undefined;
  }
  const req = (msg && typeof msg === "object" ? msg : {}) as Request;
  const hasId = "id" in req && (typeof req.id === "string" || typeof req.id === "number");
  const id = hasId ? req.id : null;
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  if (!("method" in req) && ("result" in req || "error" in req)) return undefined;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string")
    return hasId || !("method" in req) ? error(-32600, "Invalid Request") : undefined;
  if (!hasId) return undefined; // notifications
  const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<
    string,
    unknown
  >;
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "restoreproof", title: "restoreproof", version: VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !TOOLS.some((t) => t.name === name))
        return error(
          -32602,
          `Unknown tool: ${String(name)}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`,
        );
      const { structured, isError } = await callTool(name, params.arguments, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError,
        },
      };
    }
    default:
      return error(-32601, `Method not found: ${req.method}`);
  }
}

/** Serve on stdin/stdout until stdin closes. */
export async function serveStdio(ctx: McpContext = {}): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
      continue;
    }
    try {
      const res = await handleMessage(msg, ctx);
      if (res !== undefined) process.stdout.write(JSON.stringify(res) + "\n");
    } catch (err) {
      process.stderr.write(
        `restoreproof mcp: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
