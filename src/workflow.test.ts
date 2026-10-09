import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectProvider, nextSteps, planInit, writeInit } from "./init.js";
import { INSTALL } from "./install.js";
import {
  DRILL_PATH,
  WORKFLOW_PATH,
  checkCron,
  checkKeepDays,
  checkSecret,
  describeCron,
  drillHeader,
  renderWorkflow,
  type WorkflowOptions,
} from "./workflow.js";
import { VERSION } from "./version.js";

const OPTS: WorkflowOptions = {
  provider: "auto",
  cron: "17 4 * * 1",
  keepDays: 28,
  secret: "RESTOREPROOF_DATABASE_URL",
};
const yaml = renderWorkflow(OPTS);

/** A step's `run: |` script, as GitHub hands it to bash. */
function script(name: string): string {
  const m = new RegExp(
    `- name: ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?run: \\|\\n([\\s\\S]*?)\\n(?:\\n|$)`,
  ).exec(yaml);
  if (!m) throw new Error(`no step ${name}`);
  return m[1]!.replace(/^ {10}/gm, "");
}

describe("the workflow", () => {
  it("runs weekly and on demand, on a pinned runner, with read-only permissions", () => {
    expect(yaml).toContain('    - cron: "17 4 * * 1" # Mondays 04:17 UTC');
    expect(yaml).toContain("  workflow_dispatch:");
    expect(yaml).toMatch(/permissions:\n {2}contents: read\n {2}actions: read\n/);
    expect(yaml).toContain("runs-on: ubuntu-24.04");
    expect(yaml).toContain("timeout-minutes: 120");
    expect(yaml).toContain(`# restoreproof ${VERSION}:`);
  });

  it("uses only GitHub's own actions, at majors that run on Node 24", () => {
    const uses = [...yaml.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(new Set(uses)).toEqual(new Set(["actions/checkout@v7", "actions/upload-artifact@v7"]));
  });

  it("puts secrets in env only, never inside a script", () => {
    const runs = [...yaml.matchAll(/run: \|\n([\s\S]*?)\n\n/g)].map((m) => m[1]!);
    expect(runs.length).toBeGreaterThan(3);
    for (const r of runs) expect(r).not.toContain("secrets.");
    expect(yaml).toContain("RESTOREPROOF_DATABASE_URL: ${{ secrets.RESTOREPROOF_DATABASE_URL }}");
  });

  it("reads the URL from the secret it is told", () => {
    const other = renderWorkflow({ ...OPTS, secret: "SUPABASE_DB_URL", provider: "supabase" });
    expect(other).toContain("RESTOREPROOF_DATABASE_URL: ${{ secrets.SUPABASE_DB_URL }}");
    expect(other).toContain("RESTOREPROOF_PROVIDER: supabase");
    expect(other).toContain("Session pooler");
  });

  it("runs the vendored drill, installs the server's major, and keeps backup and facts", () => {
    expect(yaml).toContain("run: node .github/restoreproof/drill.mjs probe");
    expect(yaml).toContain("run: node .github/restoreproof/drill.mjs drill");
    expect(yaml).toContain("sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y");
    expect(yaml).toContain(
      "RESTOREPROOF_PG_BIN: /usr/lib/postgresql/${{ steps.probe.outputs.major }}/bin",
    );
    expect(yaml).toContain("retention-days: 28");
    expect(yaml).toContain("name: restoreproof-facts");
    expect(yaml).toContain("sparse-checkout: .github/restoreproof");
    // the last good run of this file, whatever it is named (a renamed workflow still compares)
    expect(script("Read the last good run's facts and the repository's visibility")).toContain(
      'workflow=$(basename "${GITHUB_WORKFLOW_REF%%@*}")\nrun=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$workflow" --status success',
    );
  });

  it("names no command but the install constant", () => {
    expect(yaml).toContain(`\`${INSTALL} init\``);
    expect(drillHeader()).toContain(`${INSTALL} init --force`);
  });
});

describe("the encrypt step, run as GitHub runs it", () => {
  const seal = script("Encrypt the backup, or refuse to publish it");
  function runSeal(env: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), "restoreproof-seal-"));
    const out = path.join(dir, "out");
    writeFileSync(out, "");
    let status = 0;
    let stdout: string;
    try {
      stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", seal], {
        env: {
          PATH: process.env["PATH"],
          GITHUB_OUTPUT: out,
          BACKUP: path.join(dir, "b.dump"),
          RESTOREPROOF_PASSPHRASE: "",
          RESTOREPROOF_S3_URL: "",
          ...env,
        },
        encoding: "utf8",
      });
    } catch (e) {
      status = (e as { status: number }).status;
      stdout = String((e as { stdout: unknown }).stdout ?? "");
    }
    return { status, stdout, outputs: readFileSync(out, "utf8") };
  }

  it("uploads an unencrypted backup from a private repository", () => {
    const r = runSeal({ RESTOREPROOF_VISIBILITY: "PRIVATE" });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatch(/^file=.*b\.dump\nartifact=true\n$/);
  });

  it("refuses an unencrypted backup from a public repository, unless it goes to a bucket only", () => {
    const pub = runSeal({ RESTOREPROOF_VISIBILITY: "PUBLIC" });
    expect(pub.status).toBe(1);
    expect(pub.stdout).toContain("::error title=restoreproof::This repository is PUBLIC");
    expect(pub.outputs).not.toContain("artifact=true");
    const unknown = runSeal({ RESTOREPROOF_VISIBILITY: "UNKNOWN" });
    expect(unknown.status).toBe(1);
    const bucket = runSeal({
      RESTOREPROOF_VISIBILITY: "PUBLIC",
      RESTOREPROOF_S3_URL: "s3://bucket/db",
    });
    expect(bucket.status).toBe(0);
    expect(bucket.outputs).not.toContain("artifact=true");
    expect(bucket.stdout).toContain("goes to your bucket only");
  });
});

describe("the options", () => {
  it("checks cron, days and secret names", () => {
    expect(checkCron(" 17  4 * * * ")).toBe("17 4 * * *");
    expect(() => checkCron("@weekly")).toThrow(/BAD_ARGUMENTS/);
    expect(() => checkCron("17 4 * *")).toThrow(/BAD_ARGUMENTS/);
    expect(describeCron("17 4 * * 1")).toBe("Mondays 04:17 UTC");
    expect(describeCron("5 3 * * *")).toBe("daily at 03:05 UTC");
    expect(checkKeepDays("90")).toBe(90);
    expect(() => checkKeepDays(0)).toThrow();
    expect(() => checkKeepDays(401)).toThrow();
    expect(checkSecret("SUPABASE_DB_URL")).toBe("SUPABASE_DB_URL");
    expect(() => checkSecret("GITHUB_TOKEN")).toThrow();
    expect(() => checkSecret("bad-name")).toThrow();
  });
});

describe("init", () => {
  const drill = "export const drill = true;\n";
  const repo = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "restoreproof-init-"));
    mkdirSync(path.join(dir, ".git"));
    mkdirSync(path.join(dir, "web"));
    return dir;
  };

  it("writes the two files at the git root, from a subdirectory", () => {
    const dir = repo();
    const plan = planInit(path.join(dir, "web"), OPTS, drill);
    expect(plan.root).toBe(dir);
    expect(plan.git).toBe(true);
    expect(plan.files.map((f) => [f.path, f.state])).toEqual([
      [WORKFLOW_PATH, "new"],
      [DRILL_PATH, "new"],
    ]);
    writeInit(plan, false);
    expect(readFileSync(path.join(dir, WORKFLOW_PATH), "utf8")).toBe(yaml);
    expect(readFileSync(path.join(dir, DRILL_PATH), "utf8")).toBe(drillHeader() + drill);
    expect(planInit(dir, OPTS, drill).files.map((f) => f.state)).toEqual(["same", "same"]);
  });

  it("never replaces a file that differs without --force", () => {
    const dir = repo();
    writeInit(planInit(dir, OPTS, drill), false);
    const other = { ...OPTS, cron: "17 4 * * *" };
    const plan = planInit(dir, other, drill);
    expect(plan.files.map((f) => f.state)).toEqual(["differs", "same"]);
    expect(() => writeInit(plan, false)).toThrow(/FILES_EXIST/);
    expect(readFileSync(path.join(dir, WORKFLOW_PATH), "utf8")).toBe(yaml);
    writeInit(plan, true);
    expect(readFileSync(path.join(dir, WORKFLOW_PATH), "utf8")).toContain('cron: "17 4 * * *"');
  });

  it("tells Supabase and Neon projects apart from their files, and says which URL to use", () => {
    const dir = repo();
    expect(detectProvider(dir)).toBeNull();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@neondatabase/serverless": "^1" } }),
    );
    expect(detectProvider(dir)).toBe("neon");
    mkdirSync(path.join(dir, "supabase"));
    writeFileSync(path.join(dir, "supabase", "config.toml"), "");
    expect(detectProvider(dir)).toBe("supabase");
    const steps = nextSteps(planInit(dir, OPTS, drill));
    expect(steps).toContain("gh secret set RESTOREPROOF_DATABASE_URL");
    expect(steps).toContain("Session pooler");
    expect(steps).toContain("RESTOREPROOF_PASSPHRASE");
    expect(steps).toContain("gh workflow run restoreproof.yml");
  });
});
