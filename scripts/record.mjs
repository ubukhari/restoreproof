#!/usr/bin/env node
/**
 * Record the run `restoreproof demo` replays and the README shows: the drill on the synthetic
 * database in examples/synthetic-source.sql, loaded into a throwaway cluster this script makes and
 * deletes. No real database is reached. Build first (`pnpm build`), then:
 *
 *   RESTOREPROOF_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin pnpm record
 *
 * It writes examples/recorded-run.json (the backup's path reduced to its file name) and prints
 * the workflow's view of the same run: the vendored drill (dist/drill.js) run as GitHub would run
 * it, with GITHUB_OUTPUT and GITHUB_STEP_SUMMARY in a temporary directory, then the workflow's
 * "Encrypt the backup" step in bash. Everything it starts, it stops; everything it writes outside
 * examples/, it deletes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  drillLive,
  findPgBin,
  parseToolVersion,
  renderWorkflow,
  startCluster,
} from "../dist/index.js";

const BIN = process.env.RESTOREPROOF_TEST_PG_BIN;
if (!BIN) {
  console.error("set RESTOREPROOF_TEST_PG_BIN to a PostgreSQL bin directory");
  process.exit(2);
}
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SQL = readFileSync(path.join(ROOT, "examples/synthetic-source.sql"), "utf8");
const base = { PATH: process.env.PATH };

const v = parseToolVersion(
  execFileSync(path.join(BIN, "pg_dump"), ["--version"], { encoding: "utf8" }),
);
const bin = await findPgBin(v.major, { RESTOREPROOF_PG_BIN: BIN });
const source = await startCluster({ bin, baseEnv: base });
const work = mkdtempSync(path.join(tmpdir(), "restoreproof-record-"));
try {
  const admin = { ...base, ...source.env };
  execFileSync(
    bin.path("psql"),
    ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE source"],
    { env: admin },
  );
  execFileSync(bin.path("psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    env: { ...admin, PGDATABASE: "source" },
    input: SQL,
  });
  const url = `postgresql://${source.env.PGUSER}:${source.env.PGPASSWORD}@127.0.0.1:${source.port}/source?sslmode=disable`;

  // 1. the run demo replays
  const result = await drillLive({
    env: { ...base, RESTOREPROOF_PG_BIN: BIN, RESTOREPROOF_DATABASE_URL: url },
    provider: "supabase",
    outDir: path.join(work, "out"),
    maxRowDrift: 10,
    maxShrink: 50,
    previous: null,
    allowNewerMajor: false,
  });
  result.backup.file = path.basename(result.backup.file);
  writeFileSync(
    path.join(ROOT, "examples/recorded-run.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    `recorded: ${result.ok ? "PASSED" : "FAILED"}, ${result.comparison?.tables.length} tables, ${result.comparison?.rows.live} rows`,
  );

  // 2. the same, as the workflow runs it: the vendored drill, then the encrypt step
  const gh = path.join(work, "gh");
  execFileSync("mkdir", ["-p", gh]);
  const ghEnv = {
    ...base,
    GITHUB_ACTIONS: "true",
    GITHUB_OUTPUT: path.join(gh, "output"),
    GITHUB_STEP_SUMMARY: path.join(gh, "summary.md"),
    RUNNER_TEMP: gh,
    RESTOREPROOF_VISIBILITY: "PRIVATE",
    RESTOREPROOF_DATABASE_URL: url,
    RESTOREPROOF_PROVIDER: "supabase",
    RESTOREPROOF_MAX_ROW_DRIFT: "10",
    RESTOREPROOF_MAX_SHRINK: "50",
    RESTOREPROOF_PG_BIN: BIN,
    RESTOREPROOF_OUT: path.join(gh, "restoreproof"),
  };
  writeFileSync(ghEnv.GITHUB_OUTPUT, "");
  writeFileSync(ghEnv.GITHUB_STEP_SUMMARY, "");
  for (const step of ["probe", "drill"]) {
    const r = spawnSync("node", [path.join(ROOT, "dist/drill.js"), step], {
      env: ghEnv,
      encoding: "utf8",
    });
    console.log(
      `\n--- node .github/restoreproof/drill.mjs ${step} (exit ${r.status}) ---\n${r.stdout}`,
    );
    if (r.status !== 0) console.log(r.stderr);
  }
  const outputs = Object.fromEntries(
    readFileSync(ghEnv.GITHUB_OUTPUT, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  console.log(
    `--- GITHUB_OUTPUT ---\n${Object.entries(outputs)
      .map(([k, val]) => `${k}=${k === "backup" || k === "facts" ? path.basename(val) : val}`)
      .join("\n")}`,
  );
  console.log(`\n--- GITHUB_STEP_SUMMARY ---\n${readFileSync(ghEnv.GITHUB_STEP_SUMMARY, "utf8")}`);

  const yaml = renderWorkflow({
    provider: "auto",
    cron: "17 4 * * 1",
    keepDays: 28,
    secret: "RESTOREPROOF_DATABASE_URL",
  });
  const seal = /- name: Encrypt the backup, or refuse to publish it[\s\S]*?run: \|\n([\s\S]*?)\n\n/
    .exec(yaml)[1]
    .replace(/^ {10}/gm, "");
  // gpg in a GNUPGHOME of its own, whose agent is stopped below: nothing is left running
  const gnupg = path.join(work, "gnupg");
  execFileSync("mkdir", ["-m", "700", "-p", gnupg]);
  const sealOut = path.join(gh, "seal-output");
  writeFileSync(sealOut, "");
  const s = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", seal], {
    env: {
      ...base,
      GNUPGHOME: gnupg,
      BACKUP: outputs.backup,
      RESTOREPROOF_PASSPHRASE: "synthetic-passphrase",
      RESTOREPROOF_VISIBILITY: "PUBLIC",
      GITHUB_OUTPUT: sealOut,
    },
    encoding: "utf8",
  });
  console.log(
    `--- the encrypt step, as a public repository with a passphrase (exit ${s.status}) ---\n${s.stdout}${s.stderr}${readFileSync(sealOut, "utf8").replace(/file=.*\//, "file=")}`,
  );
  const refused = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", seal], {
    env: {
      ...base,
      BACKUP: path.join(gh, "none.dump"),
      RESTOREPROOF_PASSPHRASE: "",
      RESTOREPROOF_VISIBILITY: "PUBLIC",
      RESTOREPROOF_S3_URL: "",
      GITHUB_OUTPUT: sealOut,
    },
    encoding: "utf8",
  });
  console.log(
    `--- the encrypt step, as a public repository with no passphrase and no bucket (exit ${refused.status}) ---\n${refused.stdout}`,
  );
  spawnSync("gpgconf", ["--kill", "all"], { env: { ...base, GNUPGHOME: gnupg } });
} finally {
  await source.stop();
  rmSync(work, { recursive: true, force: true });
}
