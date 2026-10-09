/**
 * `restoreproof` — a backup of your Postgres database that is restored and checked every time.
 *
 *   restoreproof init [dir] [--provider p] [--cron c] [--keep-days n] [--secret NAME] [--force] [--dry-run]
 *   restoreproof check [--url-env NAME] [--out DIR] [--provider p] [--exclude-schemas a,b]
 *   restoreproof check --dump FILE
 *   restoreproof demo
 *   restoreproof mcp
 *   restoreproof probe | drill        (what the workflow runs)
 *
 * The database URL is read from the environment, never from an argument. No account, no
 * telemetry, no LLM calls; nothing is sent to us.
 */
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { drillCommand, probeCommand } from "./ci.js";
import { drillFile, drillLive, scratchDir, type DrillResult, type Env } from "./drill.js";
import { CliError, usage } from "./errors.js";
import { HANDOFF_URL } from "./handoff.js";
import { nextSteps, planInit, writeInit } from "./init.js";
import { INSTALL } from "./install.js";
import { serveStdio } from "./mcp.js";
import { renderError, renderJson, renderText } from "./render.js";
import { listFrom } from "./scope.js";
import { PROVIDERS, type Provider } from "./url.js";
import { VERSION } from "./version.js";
import {
  DEFAULT_CRON,
  DEFAULT_KEEP_DAYS,
  DEFAULT_SECRET,
  checkCron,
  checkKeepDays,
  checkSecret,
  type WorkflowOptions,
} from "./workflow.js";

export const HELP = `restoreproof ${VERSION} — a Postgres backup that is restored and checked every time

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

export interface Deps {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  now?: () => Date;
  cwd?: string;
  env?: Env;
  /** the drill bundle init vendors; default dist/drill.js beside this file */
  drillSource?: () => string;
}

const defaultDeps: Deps = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

/** The bundled drill (dist/drill.js), which init copies into the repository. */
export function readDrillSource(): string {
  try {
    return readFileSync(fileURLToPath(new URL("./drill.js", import.meta.url)), "utf8");
  } catch {
    throw new CliError({
      code: "DRILL_NOT_BUILT",
      cause: "this copy of restoreproof has no dist/drill.js to write into the repository",
      fix: "Run it from the published package, or build it first (`pnpm build`).",
      retryable: false,
    });
  }
}

export async function main(argv: string[], deps: Deps = defaultDeps): Promise<number> {
  const json = argv.includes("--json");
  try {
    return await run(argv, deps);
  } catch (e) {
    if (e instanceof CliError) {
      (json ? deps.stdout : deps.stderr)(renderError(e.toJSON(), json));
      return e.exitCode;
    }
    throw e;
  }
}

const COMMANDS = ["init", "check", "demo", "mcp", "probe", "drill", "help"];

/** The package root: `demo` replays examples/recorded-run.json, shipped in it. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RECORDED_RUN = "examples/recorded-run.json";

function provider(raw: string | undefined): Provider | "auto" {
  const v = (raw ?? "auto").toLowerCase();
  if (v === "auto" || (PROVIDERS as readonly string[]).includes(v)) return v as Provider | "auto";
  throw usage(
    `--provider is auto, supabase, neon or postgres, got "${raw}"`,
    "e.g. `--provider supabase`",
  );
}

async function run(argv: string[], deps: Deps): Promise<number> {
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
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    throw usage(
      e instanceof Error ? e.message : String(e),
      `run \`${INSTALL} --help\` for the options`,
    );
  }
  const { values, positionals } = parsed;
  if (values.version) {
    deps.stdout(`${VERSION}\n`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === "help" || command === undefined) {
    deps.stdout(HELP);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (!COMMANDS.includes(command))
    throw usage(`unknown command "${command}"`, `run \`${INSTALL} --help\` for the commands`);
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());

  if (command === "probe" || command === "drill") {
    if (rest.length)
      throw usage(
        `${command} takes no arguments; it reads the workflow's environment`,
        "see .github/workflows/restoreproof.yml",
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
      readFileSync(path.join(PACKAGE_ROOT, RECORDED_RUN), "utf8"),
    ) as DrillResult;
    if (!values.json)
      deps.stdout(
        "A recorded run on a synthetic database (examples/synthetic-source.sql): not anyone's data.\n\n",
      );
    deps.stdout(values.json ? renderJson(recorded) : renderText(recorded));
    return 0;
  }
  if (command === "init") {
    if (rest.length > 1)
      throw usage(`init takes one directory, got ${rest.length}`, `run \`${INSTALL} init [dir]\``);
    const options: WorkflowOptions = {
      provider: provider(values.provider),
      cron: checkCron(values.cron ?? DEFAULT_CRON),
      keepDays: checkKeepDays(values["keep-days"] ?? DEFAULT_KEEP_DAYS),
      secret: checkSecret(values.secret ?? DEFAULT_SECRET),
    };
    const plan = planInit(
      path.resolve(cwd, rest[0] ?? "."),
      options,
      (deps.drillSource ?? readDrillSource)(),
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
              bytes: Buffer.byteLength(f.content),
            })),
            provider: plan.options.provider,
            detected: plan.detected,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    const verb = values["dry-run"] ? "would write" : "wrote";
    for (const f of plan.files)
      deps.stdout(
        `${f.state === "same" ? "unchanged" : f.state === "differs" ? `${verb} (replacing)` : verb}  ${path.join(plan.root, f.path)}\n`,
      );
    if (!plan.git)
      deps.stdout(`(${plan.root} is not a git checkout; the files go where you run init)\n`);
    if (plan.detected)
      deps.stdout(
        `This repository looks like ${plan.detected === "supabase" ? "a Supabase" : "a Neon"} project.\n`,
      );
    deps.stdout("\n" + nextSteps(plan));
    return 0;
  }

  // check
  if (rest.length)
    throw usage(
      "check takes no arguments; the URL comes from the environment",
      `run \`${INSTALL} check\` with RESTOREPROOF_DATABASE_URL set, or \`check --dump <file>\``,
    );
  const log = values.json ? () => undefined : (l: string) => deps.stderr(`restoreproof: ${l}\n`);
  if (values.dump) {
    const result = await drillFile({
      env,
      file: path.resolve(cwd, values.dump),
      skipExtensions: listFrom(values["skip-extensions"]),
      now,
      log,
    });
    deps.stdout(values.json ? renderJson(result) : renderText(result));
    return result.ok ? 0 : 1;
  }
  const keep = values.out ? path.resolve(cwd, values.out) : null;
  const outDir = keep ?? scratchDir();
  try {
    const result = await drillLive({
      env,
      urlEnv: values["url-env"],
      provider: values.provider === undefined ? undefined : provider(values.provider),
      outDir,
      maxRowDrift: 10,
      maxShrink: 100,
      previous: null,
      excludeSchemas: listFrom(values["exclude-schemas"]),
      skipExtensions: listFrom(values["skip-extensions"]),
      allowNewerMajor: true,
      now,
      log,
    });
    const kept = keep ? (result.backup?.file ?? null) : null;
    if (!keep && result.backup)
      result.backup.file = "(deleted after the test; --out <dir> keeps it)";
    deps.stdout(values.json ? renderJson(result) : renderText(result, { kept }));
    return result.ok ? 0 : 1;
  } finally {
    if (!keep) rmSync(outDir, { recursive: true, force: true });
  }
}
