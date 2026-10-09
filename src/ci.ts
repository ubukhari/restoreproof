/**
 * The two commands the workflow runs (`.github/workflows/restoreproof.yml`), through the vendored
 * `.github/restoreproof/drill.mjs`:
 *
 *   probe   read the server's version and say which PostgreSQL packages to install
 *   drill   back up, restore into a throwaway copy, compare; write the step summary and outputs
 *
 * Both read their settings from the environment the workflow sets, and write to GitHub's files
 * (GITHUB_OUTPUT, GITHUB_STEP_SUMMARY) when they exist. Neither sends anything anywhere.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drillLive, probeSource, type Env } from "./drill.js";
import { CliError, fail } from "./errors.js";
import { aptPackages, listFrom } from "./scope.js";
import { factsFile, previousFrom, renderError, renderMarkdown, renderText } from "./render.js";

export interface CiDeps {
  env: Env;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  now?: () => Date;
}

function output(env: Env, pairs: Record<string, string | number | boolean>): void {
  const file = env["GITHUB_OUTPUT"];
  if (!file) return;
  appendFileSync(
    file,
    Object.entries(pairs)
      .map(([k, v]) => `${k}=${String(v).replace(/\n/g, " ")}\n`)
      .join(""),
  );
}

function summary(env: Env, text: string): void {
  const file = env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, text);
}

/** Whether summaries and facts must name no table: a public repository, or one we cannot tell. */
export function shouldRedact(env: Env): boolean {
  if (env["GITHUB_ACTIONS"] !== "true") return false;
  const v = (env["RESTOREPROOF_VISIBILITY"] ?? "").toUpperCase();
  return v !== "PRIVATE" && v !== "INTERNAL";
}

function percent(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 100)
    throw fail(
      "BAD_SETTING",
      `${name} is "${raw}"`,
      `Set ${name} to a percentage from 0 to 100, or remove it for ${fallback}.`,
    );
  return v;
}

/** `probe`: the server's major version and the apt packages the copy needs. */
export async function probeCommand(deps: CiDeps): Promise<number> {
  try {
    const src = await probeSource(
      deps.env,
      deps.env["RESTOREPROOF_URL_ENV"],
      deps.env["RESTOREPROOF_PROVIDER"],
    );
    const packages = aptPackages(
      src.probe.major,
      src.probe.extensions.map((e) => e.name),
    );
    output(deps.env, {
      major: src.probe.major,
      packages: packages.join(" "),
      provider: src.provider,
    });
    deps.stdout(
      `PostgreSQL ${src.probe.version} (${src.provider}), read through ${src.variable}\n` +
        `major=${src.probe.major}\npackages=${packages.join(" ")}\n`,
    );
    return 0;
  } catch (e) {
    return report(e, deps);
  }
}

function report(e: unknown, deps: CiDeps): number {
  if (!(e instanceof CliError)) throw e;
  deps.stderr(renderError(e.toJSON(), false));
  if (deps.env["GITHUB_ACTIONS"] === "true") {
    deps.stdout(`::error title=restoreproof ${e.code}::${e.cause.split("\n")[0]} Fix: ${e.fix}\n`);
    summary(
      deps.env,
      `## restoreproof: the restore test could not run\n\n**${e.code}**: ${e.cause.replace(/\n/g, "<br>")}\n\n**Fix:** ${e.fix}\n`,
    );
    output(deps.env, { ok: false });
  }
  return e.exitCode;
}

/** `drill`: the whole test, as the workflow runs it. */
export async function drillCommand(deps: CiDeps): Promise<number> {
  const env = deps.env;
  const redact = shouldRedact(env);
  try {
    const outDir =
      env["RESTOREPROOF_OUT"] ||
      (env["RUNNER_TEMP"]
        ? path.join(env["RUNNER_TEMP"], "restoreproof")
        : path.join(tmpdir(), "restoreproof"));
    mkdirSync(outDir, { recursive: true });
    const prevFile = env["RESTOREPROOF_PREVIOUS"];
    const previous =
      prevFile && existsSync(prevFile) ? previousFrom(readFileSync(prevFile, "utf8")) : null;
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
      log: (l) => deps.stderr(`restoreproof: ${l}\n`),
    });
    const facts = path.join(outDir, "facts.json");
    writeFileSync(facts, JSON.stringify(factsFile(result, redact), null, 2) + "\n");
    deps.stdout(renderText(result, { redact }));
    summary(env, renderMarkdown(result, { redact }));
    if (env["GITHUB_ACTIONS"] === "true")
      for (const f of result.findings.filter((x) => x.level === "fail"))
        deps.stdout(
          `::error title=restoreproof ${f.code}::${(redact ? f.summary : f.message).split("\n")[0]}\n`,
        );
    output(env, {
      ok: result.ok,
      backup: result.backup?.file ?? "",
      facts,
      tables: result.comparison?.tables.length ?? 0,
      rows: result.comparison?.rows.live ?? 0,
    });
    return result.ok ? 0 : 1;
  } catch (e) {
    return report(e, deps);
  }
}
