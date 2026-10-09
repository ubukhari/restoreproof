/**
 * The drill against real PostgreSQL, on synthetic databases only. It runs when
 * RESTOREPROOF_TEST_PG_BIN names a PostgreSQL bin directory (e.g. /opt/homebrew/opt/postgresql@17/bin);
 * otherwise it is skipped, and the fixture tests cover the logic.
 *
 * The "source" is a throwaway cluster this test makes, loaded from examples/synthetic-source.sql.
 * The drill makes its own throwaway copy. Both are stopped and deleted before the test ends. No real
 * database is ever reached: the only URL the drill sees points at 127.0.0.1 and the source cluster.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCluster, type Cluster } from "./cluster.js";
import { drillFile, drillLive, type DrillResult } from "./drill.js";
import { findPgBin, parseToolVersion, pgEnv, run, type PgBin } from "./pg.js";

const BIN = process.env["RESTOREPROOF_TEST_PG_BIN"];
const OTHER_BIN = process.env["RESTOREPROOF_TEST_PG_BIN_OLDER"];
const SQL = readFileSync(new URL("../examples/synthetic-source.sql", import.meta.url), "utf8");

describe.skipIf(!BIN)("the drill on a synthetic database (RESTOREPROOF_TEST_PG_BIN)", () => {
  let bin: PgBin;
  let source: Cluster;
  let url: string;
  let out: string;
  const base = () => ({
    PATH: process.env["PATH"],
    RESTOREPROOF_PG_BIN: BIN,
    RESTOREPROOF_DATABASE_URL: url,
  });

  beforeAll(async () => {
    const v = parseToolVersion(
      execFileSync(path.join(BIN!, "pg_dump"), ["--version"], { encoding: "utf8" }),
    );
    bin = await findPgBin(v!.major, { RESTOREPROOF_PG_BIN: BIN });
    source = await startCluster({ bin, baseEnv: { PATH: process.env["PATH"] } });
    const admin = pgEnv({ PATH: process.env["PATH"] }, source.env);
    const made = await run(
      bin.path("psql"),
      ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE source"],
      { env: admin, timeoutMs: 60_000 },
    );
    expect(made.stderr).toBe("");
    const loaded = await run(bin.path("psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      env: { ...admin, PGDATABASE: "source" },
      input: SQL,
      timeoutMs: 120_000,
    });
    expect(loaded.code, loaded.stderr).toBe(0);
    url = `postgresql://${source.env["PGUSER"]}:${source.env["PGPASSWORD"]}@127.0.0.1:${source.port}/source?sslmode=disable`;
    out = mkdtempSync(path.join(tmpdir(), "restoreproof-test-out-"));
  }, 180_000);

  afterAll(async () => {
    await source?.stop();
    if (out) rmSync(out, { recursive: true, force: true });
  }, 60_000);

  const drill = (extra: Record<string, string> = {}, previous: DrillResult["previous"] = null) =>
    drillLive({
      env: { ...base(), ...extra },
      provider: extra["RESTOREPROOF_PROVIDER"] ?? "supabase",
      outDir: out,
      maxRowDrift: 10,
      maxShrink: 50,
      previous,
      skipExtensions: (extra["RESTOREPROOF_SKIP_EXTENSIONS"] ?? "").split(",").filter(Boolean),
      allowNewerMajor: false,
    });

  let first: DrillResult;

  it("backs up, restores into a throwaway copy, and finds every object and row", async () => {
    first = await drill();
    expect(first.restore.error).toBeNull();
    expect(first.ok, JSON.stringify(first.findings, null, 2)).toBe(true);
    const c = first.comparison!;
    expect(c.objects.missing).toBe(0);
    expect(c.objects.changed).toBe(0);
    expect(c.rows.live).toBe(c.rows.restored);
    expect(c.rows.live).toBe(400 + 400 + 2000 + 3000 + 2 + 1 + 120 + 2);
    expect(c.objects.byKind).toMatchObject({
      policy: 3,
      trigger: 1,
      view: 1,
      matview: 1,
      enum: 1,
      domain: 1,
    });
    // the Supabase platform schema is left out, and the webhook log's rows
    expect(first.source!.excludedSchemas).toEqual(["graphql"]);
    expect(Object.keys(c.tables.map((t) => t.table))).not.toContain("graphql.cache");
    expect(c.tables.map((t) => t.table)).not.toContain("supabase_functions.hooks");
    expect(c.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["SCHEMAS_LEFT_OUT", "TABLE_DATA_LEFT_OUT"]),
    );
    expect(existsSync(first.backup!.file)).toBe(true);
  }, 180_000);

  it("fails loudly when the backup does not restore", async () => {
    const r = await drill({ RESTOREPROOF_SKIP_EXTENSIONS: "uuid-ossp" });
    expect(r.ok).toBe(false);
    expect(r.restore.ok).toBe(false);
    expect(r.findings[0]!.code).toBe("RESTORE_FAILED");
    expect(r.restore.error).toMatch(/uuid_generate_v4/);
  }, 180_000);

  it("fails when the database shrank since the last good run", async () => {
    const r = await drill(
      {},
      {
        at: "2026-10-02T04:17:00Z",
        rows: first.comparison!.rows.live * 3,
        tables: ["public.gone"],
        backupBytes: first.backup!.bytes * 4,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["DATABASE_SHRANK", "TABLES_GONE", "BACKUP_SHRANK"]),
    );
  }, 180_000);

  it("restore-tests a backup file someone already has, archive or plain SQL", async () => {
    const archive = await drillFile({
      env: { PATH: process.env["PATH"], RESTOREPROOF_PG_BIN: BIN },
      file: first.backup!.file,
    });
    expect(archive.ok, JSON.stringify(archive.findings)).toBe(true);
    expect(archive.restored!.rows).toBe(first.comparison!.rows.restored);
    const plain = path.join(out, "plain.sql");
    const dumped = await run(
      bin.path("pg_dump"),
      ["--format=plain", `--file=${plain}`, "--exclude-schema=graphql"],
      {
        env: pgEnv({ PATH: process.env["PATH"] }, { ...source.env, PGDATABASE: "source" }),
        timeoutMs: 60_000,
      },
    );
    expect(dumped.code, dumped.stderr).toBe(0);
    const sql = await drillFile({
      env: { PATH: process.env["PATH"], RESTOREPROOF_PG_BIN: BIN },
      file: plain,
    });
    expect(sql.ok, JSON.stringify(sql.findings)).toBe(true);
    expect(sql.restored!.rows).toBeGreaterThan(5000);
  }, 180_000);

  it.skipIf(!OTHER_BIN)(
    "refuses an older pg_dump than the server (RESTOREPROOF_TEST_PG_BIN_OLDER)",
    async () => {
      await expect(drill({ RESTOREPROOF_PG_BIN: OTHER_BIN! })).rejects.toMatchObject({
        code: "PG_VERSION_SKEW",
      });
    },
    60_000,
  );
});
