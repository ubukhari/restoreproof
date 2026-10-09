/**
 * The self-test the public repo runs on GitHub's own runners (.github/workflows/selftest.yml, from
 * src/selftest.ts): valid for GitHub Actions, and the workflow `init` writes rather than a hand-made
 * copy of it. In the monorepo the file is under distribution/root; in the public repo, at the root,
 * so these tests run in both.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";
import { REPO } from "./install.js";
import { main } from "./main.js";
import {
  SELFTEST_PATH,
  SELFTEST_VALUES,
  SELFTEST_WITHHELD,
  checkSelftest,
  initParts,
  renderSelftest,
  withTestValues,
} from "./selftest.js";
import { DRILL_PATH, WORKFLOW_PATH, checkCron, renderWorkflow } from "./workflow.js";

const here = (rel: string): URL => new URL(`../${rel}`, import.meta.url);
const read = (rel: string): string => readFileSync(here(rel), "utf8");
const COMMITTED = [`distribution/root/${SELFTEST_PATH}`, SELFTEST_PATH].find((p) =>
  existsSync(here(p)),
);
const DRILL = "// the drill\n";

/** What `restoreproof init` writes with its defaults, into an empty repository. */
async function initWrites(): Promise<{ dir: string; workflow: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "restoreproof-selftest-"));
  mkdirSync(path.join(dir, ".git"));
  const said: string[] = [];
  const code = await main(["init", dir], {
    stdout: (s) => void said.push(s),
    stderr: (s) => void said.push(s),
    env: {},
    drillSource: () => DRILL,
  });
  expect(code, said.join("")).toBe(0);
  return { dir, workflow: readFileSync(path.join(dir, WORKFLOW_PATH), "utf8") };
}

type Step = Record<string, unknown> & { name: string; id?: string; uses?: string; run?: string };
type Job = Record<string, unknown> & {
  steps: Step[];
  needs?: string | string[];
  services?: Record<string, { image: string }>;
};
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const own = (s: Step): boolean => s.name.startsWith("Self-test: ");
const expressions = (value: unknown): string[] =>
  [...JSON.stringify(value).matchAll(/\$\{\{(.*?)\}\}/g)].map((m) => m[1]!.trim());

describe.runIf(COMMITTED)("the self-test workflow", () => {
  const text = read(COMMITTED!);

  it("is what renderSelftest makes of the workflow init writes with its defaults", async () => {
    const { workflow } = await initWrites();
    expect(text).toBe(renderSelftest(workflow));
  });

  it("is valid YAML that GitHub Actions can run: triggers, runner, actions, references", () => {
    const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
    expect(doc.errors.map(String)).toEqual([]);
    expect(doc.warnings.map(String)).toEqual([]);
    const wf = doc.toJS() as Workflow;

    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const schedule = wf.on["schedule"] as { cron: string }[];
    expect(schedule).toHaveLength(1);
    const cron = checkCron(schedule[0]!.cron);
    expect(cron.split(" ")[4], "weekly").toMatch(/^\d$/);
    expect(wf.permissions).toEqual({ contents: "read", actions: "read" });
    expect(Object.keys(wf.jobs)).toEqual(["restore-test", "fetch-backup", "restore-fails"]);

    for (const [id, job] of Object.entries(wf.jobs)) {
      expect(job["runs-on"], id).toBe("ubuntu-24.04");
      expect(job["timeout-minutes"], id).toEqual(expect.any(Number));
      const ids = new Set<string>();
      const needs = [job.needs ?? []].flat();
      for (const n of needs) expect(Object.keys(wf.jobs), `${id} needs ${n}`).toContain(n);
      for (const s of job.steps) {
        expect(s.name, `${id}: every step is named`).toEqual(expect.any(String));
        expect(Number("uses" in s) + Number("run" in s), `${id}: ${s.name}`).toBe(1);
        if (s.uses)
          expect(["actions/checkout@v7", "actions/upload-artifact@v7"], s.name).toContain(s.uses);
        // a step reads only the steps before it, the jobs it needs, and its own services
        for (const e of expressions(s)) {
          for (const m of e.matchAll(/\bsteps\.([\w-]+)\./g))
            expect([...ids], `${id}: ${s.name} reads ${m[0]}`).toContain(m[1]);
          for (const m of e.matchAll(/\bneeds\.([\w-]+)\./g))
            expect(needs, `${id}: ${s.name} reads ${m[0]}`).toContain(m[1]);
          for (const m of e.matchAll(/\bjob\.services\.([\w-]+)\./g))
            expect(Object.keys(job.services ?? {}), `${id}: ${s.name}`).toContain(m[1]);
          expect(e, `${id}: ${s.name}`).toMatch(/^(?:!?[\w(]|')/);
        }
        if (s.id) {
          expect(ids.has(s.id), `${id}: step id ${s.id} is unique`).toBe(false);
          ids.add(s.id);
        }
      }
      for (const e of expressions(job["outputs"] ?? {}))
        for (const m of e.matchAll(/\bsteps\.([\w-]+)\./g)) expect([...ids]).toContain(m[1]);
      for (const svc of Object.values(job.services ?? {}))
        expect(svc.image, "a service image is pinned to a version").toMatch(/:\d/);
    }
  });

  it("runs init's job, settings and steps in init's order, with only its secrets replaced", async () => {
    const { workflow } = await initWrites();
    const init = (parse(withTestValues(workflow)) as Workflow).jobs["restore-test"]!;
    const wf = parse(text) as Workflow;

    const job = wf.jobs["restore-test"]!;
    expect(Object.keys(job).sort()).toEqual([
      "defaults",
      "env",
      "name",
      "outputs",
      "runs-on",
      "services",
      "steps",
      "timeout-minutes",
    ]);
    for (const key of ["name", "runs-on", "timeout-minutes", "defaults", "env"])
      expect(job[key], key).toEqual(init[key]);
    expect(job.steps.filter((s) => !own(s))).toEqual(init.steps);
    // the self-test's own steps come before init's and after them, never between
    expect(job.steps.map((s) => (own(s) ? "S" : "i")).join("")).toMatch(/^S+i+S+$/);

    const fails = wf.jobs["restore-fails"]!;
    expect(fails.env).toEqual(init.env);
    expect(fails.defaults).toEqual(init.defaults);
    const [checkout, , probe, install, drill] = init.steps;
    expect(drill!.id).toBe("drill");
    expect(fails.steps.filter((s) => !own(s))).toEqual([checkout, probe, install]);
    const last = fails.steps.at(-1)!;
    expect(own(last)).toBe(true);
    expect(last.run).toContain(drill!.run!);
    // the drill step's settings, less the last good run (there is none), plus the withheld extension
    const { RESTOREPROOF_PREVIOUS: previous, ...settings } = drill!["env"] as Record<
      string,
      string
    >;
    expect(previous).toBeDefined();
    expect(last["env"]).toEqual({ RESTOREPROOF_SKIP_EXTENSIONS: SELFTEST_WITHHELD, ...settings });
  });

  it("carries init's lines byte for byte: each of init's steps is in the file as init wrote it", async () => {
    const { workflow } = await initWrites();
    const parts = initParts(workflow);
    expect(parts.steps.length).toBeGreaterThan(5);
    expect(text).toContain(withTestValues(parts.head));
    for (const s of parts.steps) expect(text).toContain(withTestValues(s));
    // and the only lines withTestValues changes are the ones naming a secret
    const before = parts.steps.join("").split("\n");
    const after = withTestValues(parts.steps.join("")).split("\n");
    before.forEach((line, i) => {
      if (line !== after[i]) expect(line).toContain("secrets.");
    });
  });

  it("holds no secret, and reaches no database but its own service container", () => {
    // only the header comment names `secrets.`, to say none is read
    expect(JSON.stringify(parse(text))).not.toMatch(/\bsecrets\./);
    expect(text.split("\n").filter((l) => /\bsecrets\./.test(l) && !/^#/.test(l))).toEqual([]);
    expect(SELFTEST_VALUES["RESTOREPROOF_DATABASE_URL"]).toMatch(
      /^postgresql:\/\/[^@]+@127\.0\.0\.1:/,
    );
    expect(SELFTEST_VALUES["RESTOREPROOF_S3_ENDPOINT"]).toMatch(/^http:\/\/127\.0\.0\.1:/);
    for (const [name, value] of Object.entries(SELFTEST_VALUES)) {
      expect(value, name).not.toContain("'");
      if (value && name !== "RESTOREPROOF_DATABASE_URL" && name !== "RESTOREPROOF_S3_ENDPOINT")
        expect(value, name).toContain("selftest");
    }
  });

  it("loads the synthetic fixture the drill's tests use, and withholds an extension it needs", () => {
    expect(text).toContain("< selftest/examples/synthetic-source.sql");
    const sql = read("examples/synthetic-source.sql");
    expect(sql).toContain(`CREATE EXTENSION IF NOT EXISTS "${SELFTEST_WITHHELD}"`);
    expect(sql).toMatch(/DEFAULT extensions\.uuid_generate_v4\(\)/);
  });
});

describe("renderSelftest", () => {
  it("has a test value for every secret init's workflow reads, and refuses one it does not know", () => {
    const opts = {
      provider: "auto" as const,
      cron: "17 4 * * 1",
      keepDays: 28,
      secret: "RESTOREPROOF_DATABASE_URL",
    };
    const names = [...renderWorkflow(opts).matchAll(/\bsecrets\.(\w+)/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) expect(Object.keys(SELFTEST_VALUES)).toContain(n);
    expect(() => renderSelftest(renderWorkflow({ ...opts, secret: "SUPABASE_DB_URL" }))).toThrow(
      /secrets\.SUPABASE_DB_URL/,
    );
    expect(() => renderSelftest("name: something else\n")).toThrow(/not laid out/);
  });
});

describe("the self-test's first check (scripts/selftest.mjs)", () => {
  async function repoWith(edit: (selftest: string, drill: string) => [string | null, string]) {
    const { dir: customer, workflow } = await initWrites();
    const repo = mkdtempSync(path.join(tmpdir(), "restoreproof-selftest-repo-"));
    const [selftest, drill] = edit(
      renderSelftest(workflow),
      readFileSync(path.join(customer, DRILL_PATH), "utf8"),
    );
    mkdirSync(path.join(repo, ".github/workflows"), { recursive: true });
    mkdirSync(path.join(repo, ".github/restoreproof"), { recursive: true });
    if (selftest !== null) writeFileSync(path.join(repo, SELFTEST_PATH), selftest);
    writeFileSync(path.join(repo, DRILL_PATH), drill);
    return checkSelftest(customer, repo);
  }

  it("passes when the repository holds this self-test and the drill init writes", async () => {
    const r = await repoWith((s, d) => [s, d]);
    expect(r.lines.join("\n")).not.toContain("::error");
    expect(r.ok).toBe(true);
  });

  it("fails, naming the first line that differs, when either was changed by hand", async () => {
    const edited = await repoWith((s, d) => [
      s.replace("timeout-minutes: 120", "timeout-minutes: 30"),
      d,
    ]);
    expect(edited.ok).toBe(false);
    expect(edited.lines[0]).toMatch(
      /^::error title=selftest::.*selftest\.yml is not what init writes/,
    );
    expect(edited.lines.join("\n")).toMatch(/line \d+, this repo: +timeout-minutes: 30/);
    const drill = await repoWith((s, d) => [s, d + "// changed\n"]);
    expect(drill.ok).toBe(false);
    expect(drill.lines.join("\n")).toContain("is not the drill init writes");
    const missing = await repoWith((_, d) => [null, d]);
    expect(missing.ok).toBe(false);
    expect(missing.lines.join("\n")).toContain("is missing");
  });

  it("is what the workflow runs, through the library the public repo commits in dist/", () => {
    const script = read("scripts/selftest.mjs");
    expect(script).toContain('import { checkSelftest } from "../dist/index.js";');
    expect(read("src/index.ts")).toMatch(/\bcheckSelftest\b/);
    expect(
      renderSelftest(
        renderWorkflow({
          provider: "auto",
          cron: "17 4 * * 1",
          keepDays: 28,
          secret: "RESTOREPROOF_DATABASE_URL",
        }),
      ),
    ).toContain('node selftest/scripts/selftest.mjs "$RUNNER_TEMP/customer" selftest');
  });
});

describe("README", () => {
  it("says where it is tested, pointing at the self-test's latest run", () => {
    const readme = read("README.md");
    expect(readme).toContain(`${REPO}/actions/workflows/selftest.yml`);
    expect(readme).toContain(`${REPO}/actions/workflows/selftest.yml/badge.svg`);
  });
});
