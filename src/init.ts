/**
 * `restoreproof init`: write the workflow and the drill into a repository. It never overwrites a
 * file that differs unless told to (`--force`), and with `--dry-run` it writes nothing and returns
 * what it would write.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { INSTALL } from "./install.js";
import type { Provider } from "./url.js";
import {
  DEFAULT_SECRET,
  DRILL_PATH,
  WHICH_URL,
  WORKFLOW_PATH,
  drillHeader,
  renderWorkflow,
  type WorkflowOptions,
} from "./workflow.js";

export interface PlannedFile {
  /** relative to the repository root */
  path: string;
  content: string;
  /** "new", "same" (already there, identical) or "differs" (there, and not identical) */
  state: "new" | "same" | "differs";
}

export interface InitPlan {
  root: string;
  /** whether `root` is a git checkout */
  git: boolean;
  /** the provider the repository's files point to, when the option was auto */
  detected: Provider | null;
  files: PlannedFile[];
  options: WorkflowOptions;
}

/** The repository root: the nearest directory up from `dir` with a .git, else `dir` itself. */
export function repoRoot(dir: string): { root: string; git: boolean } {
  let d = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(d, ".git"))) return { root: d, git: true };
    const up = path.dirname(d);
    if (up === d) return { root: path.resolve(dir), git: false };
    d = up;
  }
}

/** Supabase or Neon, from the repository's own files; null when nothing says. */
export function detectProvider(root: string): Provider | null {
  if (existsSync(path.join(root, "supabase", "config.toml"))) return "supabase";
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const deps = { ...pkg["dependencies"], ...pkg["devDependencies"] };
    if (Object.keys(deps).some((d) => d.startsWith("@supabase/"))) return "supabase";
    if (Object.keys(deps).some((d) => d.startsWith("@neondatabase/"))) return "neon";
  } catch {
    // no package.json, or not JSON
  }
  return null;
}

export function planInit(dir: string, options: WorkflowOptions, drillSource: string): InitPlan {
  if (!existsSync(dir))
    throw fail(
      "DIR_NOT_FOUND",
      `there is no directory at ${dir}`,
      "Run it in your repository, or pass its path: `restoreproof init path/to/repo`.",
    );
  const { root, git } = repoRoot(dir);
  const detected = options.provider === "auto" ? detectProvider(root) : null;
  const files = [
    { path: WORKFLOW_PATH, content: renderWorkflow(options) },
    { path: DRILL_PATH, content: drillHeader() + drillSource },
  ].map((f) => {
    const abs = path.join(root, f.path);
    const state: PlannedFile["state"] = !existsSync(abs)
      ? "new"
      : readFileSync(abs, "utf8") === f.content
        ? "same"
        : "differs";
    return { ...f, state };
  });
  return { root, git, detected, files, options };
}

/** Write the plan. Refuses, writing nothing, while a file differs and `force` is not set. */
export function writeInit(plan: InitPlan, force: boolean): void {
  const differs = plan.files.filter((f) => f.state === "differs");
  if (differs.length && !force)
    throw fail(
      "FILES_EXIST",
      `${differs.map((f) => f.path).join(" and ")} already exist${differs.length === 1 ? "s" : ""} and differ${differs.length === 1 ? "s" : ""} from what this version writes`,
      "Review the difference, then run init again with --force to replace them (the workflow's settings are re-applied from the options you pass).",
    );
  for (const f of plan.files) {
    if (f.state === "same") continue;
    const abs = path.join(plan.root, f.path);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

/** What to do next, printed after the files are written. */
export function nextSteps(plan: InitPlan): string {
  const provider =
    plan.options.provider === "auto" ? (plan.detected ?? "auto") : plan.options.provider;
  const secret = plan.options.secret;
  const lines = [
    "Next:",
    "",
    secret === DEFAULT_SECRET
      ? `  1. Add the repository secret ${secret}: \`gh secret set ${secret}\` (it asks for the value,`
      : `  1. The workflow reads the repository secret ${secret}; check it holds the connection string,`,
    secret === DEFAULT_SECRET
      ? "     and nothing echoes it), holding the connection string:"
      : "     of this kind:",
    ...WHICH_URL[provider].map((l) => `       ${l}`),
    "  2. In a public repository, also add RESTOREPROOF_PASSPHRASE (`gh secret set RESTOREPROOF_PASSPHRASE`):",
    "     anyone can download a public repository's artifacts, so an unencrypted backup is never uploaded there.",
    `  3. Commit ${WORKFLOW_PATH} and ${DRILL_PATH}, push, and run it once now:`,
    "     `gh workflow run restoreproof.yml`. Its summary shows the restore test, table by table.",
    "",
    `To test a restore from this machine first: \`${INSTALL} check\` with RESTOREPROOF_DATABASE_URL set.`,
  ];
  return lines.join("\n") + "\n";
}
