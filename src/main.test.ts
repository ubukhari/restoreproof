/**
 * The CLI and the MCP server, with no database: every path here stops before a connection, or uses
 * the recorded run. The drill against PostgreSQL itself is in drill.pg.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { drillCommand, probeCommand, shouldRedact } from "./ci.js";
import type { DrillResult } from "./drill.js";
import { HANDOFF_LINE } from "./handoff.js";
import { INSTALL } from "./install.js";
import { HELP, main, RECORDED_RUN } from "./main.js";
import { callTool, handleMessage, type TOOLS } from "./mcp.js";
import { factsFile, previousFrom, renderMarkdown, renderText } from "./render.js";
import { DRILL_PATH, WORKFLOW_PATH } from "./workflow.js";

const recorded = JSON.parse(
  readFileSync(new URL(`../${RECORDED_RUN}`, import.meta.url), "utf8"),
) as DrillResult;

async function cli(argv: string[], env: Record<string, string> = {}, cwd?: string) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { PATH: process.env["PATH"] ?? "", ...env },
    cwd,
    drillSource: () => "export {};\n",
  });
  return { code, out, err };
}

describe("the CLI", () => {
  it("prints help with the install command, and its version", async () => {
    const h = await cli(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toBe(HELP);
    expect(HELP).toContain(`${INSTALL} init`);
    expect((await cli(["--version"])).out).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect((await cli([])).code).toBe(2);
    const bad = await cli(["backup"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("BAD_ARGUMENTS");
  });

  it("init writes the workflow and the drill, and says what to do next", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "restoreproof-cli-init-"));
    mkdirSync(path.join(dir, ".git"));
    const r = await cli(["init", "--provider", "neon"], {}, dir);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`wrote  ${path.join(dir, WORKFLOW_PATH)}`);
    expect(r.out).toContain('no "-pooler" in the host');
    expect(readFileSync(path.join(dir, DRILL_PATH), "utf8")).toContain("export {};");
    const again = await cli(["init", "--cron", "0 3 * * *", "--json"], {}, dir);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.out).error.code).toBe("FILES_EXIST");
    const dry = await cli(["init", "--cron", "0 3 * * *", "--dry-run", "--json"], {}, dir);
    expect(JSON.parse(dry.out)).toMatchObject({
      written: false,
      files: [{ state: "differs" }, { state: "same" }],
    });
  });

  it("check reads the URL from the environment only, and refuses known traps before connecting", async () => {
    const none = await cli(["check", "--json"]);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.out).error.code).toBe("NO_DATABASE_URL");
    const arg = await cli(["check", "postgres://u:p@h/db"]);
    expect(arg.code).toBe(2);
    expect(arg.err).not.toContain("u:p@h");
    const tx = await cli(["check", "--json"], {
      RESTOREPROOF_DATABASE_URL:
        "postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    });
    expect(JSON.parse(tx.out).error.code).toBe("SUPABASE_TRANSACTION_POOLER");
    const named = await cli(["check", "--url-env", "PROD_DB", "--json"], {
      DATABASE_URL: "postgresql://ignored@h/db",
      PROD_DB: "postgresql://app:pw@ep-x-1-pooler.us-east-2.aws.neon.tech/neondb",
    });
    expect(JSON.parse(named.out).error.code).toBe("NEON_POOLED");
  });

  it("check --dump refuses a file that is not there", async () => {
    const r = await cli(["check", "--dump", "nope.dump", "--json"], {}, tmpdir());
    expect(JSON.parse(r.out).error.code).toBe("BACKUP_NOT_FOUND");
  });

  it("demo replays the recorded run, labelled synthetic", async () => {
    const r = await cli(["demo"]);
    expect(r.code).toBe(0);
    expect(r.out.startsWith("A recorded run on a synthetic database")).toBe(true);
    expect(r.out).toContain("restore test PASSED");
    expect(r.out).toContain(HANDOFF_LINE);
    expect(recorded.backup!.file).toMatch(/^restoreproof-\d{8}T\d{6}Z\.dump$/);
  });
});

describe("the workflow's commands", () => {
  function files() {
    const dir = mkdtempSync(path.join(tmpdir(), "restoreproof-gh-"));
    const output = path.join(dir, "output");
    const summary = path.join(dir, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    return { dir, output, summary };
  }

  it("probe and drill fail loudly, with an annotation and a summary, when they cannot start", async () => {
    const f = files();
    let out = "";
    const env = {
      PATH: process.env["PATH"],
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: f.output,
      GITHUB_STEP_SUMMARY: f.summary,
      RESTOREPROOF_DATABASE_URL: "postgresql://app:pw@ep-x-1-pooler.us-east-2.aws.neon.tech/neondb",
    };
    const code = await probeCommand({ env, stdout: (s) => (out += s), stderr: () => undefined });
    expect(code).toBe(1);
    expect(out).toContain("::error title=restoreproof NEON_POOLED::");
    expect(readFileSync(f.summary, "utf8")).toContain(
      "## restoreproof: the restore test could not run",
    );
    expect(readFileSync(f.output, "utf8")).toBe("ok=false\n");
    const drill = await drillCommand({
      env: { ...env, RESTOREPROOF_DATABASE_URL: "" },
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(drill).toBe(1);
    expect(readFileSync(f.summary, "utf8")).toContain("NO_DATABASE_URL");
  });

  it("redacts in a public repository, or one whose visibility is unknown, and only on Actions", () => {
    expect(shouldRedact({ GITHUB_ACTIONS: "true", RESTOREPROOF_VISIBILITY: "PUBLIC" })).toBe(true);
    expect(shouldRedact({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(shouldRedact({ GITHUB_ACTIONS: "true", RESTOREPROOF_VISIBILITY: "PRIVATE" })).toBe(
      false,
    );
    expect(shouldRedact({ GITHUB_ACTIONS: "true", RESTOREPROOF_VISIBILITY: "INTERNAL" })).toBe(
      false,
    );
    expect(shouldRedact({})).toBe(false);
  });
});

describe("rendering the recorded run", () => {
  const tables = recorded.comparison!.tables.map((t) => t.table);

  it("names tables and counts in a private summary", () => {
    const md = renderMarkdown(recorded);
    expect(md).toContain("## restoreproof: the restore test passed");
    expect(md).toContain("| auth.users | 400 | 400 |");
    expect(md).toContain(HANDOFF_LINE);
  });

  it("names no table and no per-table count when redacted", () => {
    for (const text of [
      renderMarkdown(recorded, { redact: true }),
      renderText(recorded, { redact: true }),
      JSON.stringify(factsFile(recorded, true)),
    ])
      for (const t of tables) expect(text).not.toContain(t);
    expect(renderMarkdown(recorded, { redact: true })).toContain("This repository is public");
  });

  it("writes facts the next run reads back", () => {
    const priv = previousFrom(JSON.stringify(factsFile(recorded, false)))!;
    expect(priv).toMatchObject({
      rows: recorded.comparison!.rows.live,
      tablesHashed: false,
      backupBytes: recorded.backup!.bytes,
    });
    expect(priv.tables).toEqual(tables);
    const pub = previousFrom(JSON.stringify(factsFile(recorded, true)))!;
    expect(pub.tablesHashed).toBe(true);
    expect(pub.tables).toHaveLength(tables.length);
    expect(previousFrom("not json")).toBeNull();
    expect(previousFrom(JSON.stringify({ tool: "other" }))).toBeNull();
  });
});

describe("the MCP server", () => {
  it("lists two strict tools, each with all four annotations", async () => {
    const res = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {})) as {
      result: { tools: typeof TOOLS };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual([
      "restoreproof_write_workflow",
      "restoreproof_test_restore",
    ]);
    for (const t of res.result.tools) {
      expect(t.name).toMatch(/^restoreproof_[a-z_]+$/);
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const [k, p] of Object.entries(t.inputSchema.properties))
        expect(String(p["description"] ?? ""), `${t.name}.${k}`).not.toBe("");
      expect(Object.keys(t.annotations).sort()).toEqual([
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
        "title",
      ]);
      expect(t.description).not.toMatch(/postgres(ql)?:\/\/\S+@/);
    }
    const [write, test] = res.result.tools;
    expect(write!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(test!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(Object.keys(test!.inputSchema.properties)).not.toContain("url");
  });

  it("answers initialize and refuses unknown methods", async () => {
    const init = (await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      {},
    )) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "restoreproof" },
    });
    expect(
      await handleMessage({ jsonrpc: "2.0", id: 2, method: "resources/list" }, {}),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, {}),
    ).toBeUndefined();
  });

  it("writes the workflow, never over a file that differs, and dry-runs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "restoreproof-mcp-"));
    const ctx = { cwd: dir, env: {}, drillSource: () => "export {};\n" };
    const dry = await callTool("restoreproof_write_workflow", { dry_run: true }, ctx);
    expect(dry.isError).toBe(false);
    expect(dry.structured).toMatchObject({ written: false });
    expect((dry.structured["files"] as { content: string }[])[0]!.content).toContain(
      "name: restoreproof",
    );
    const first = await callTool("restoreproof_write_workflow", {}, ctx);
    expect(first.structured).toMatchObject({ written: true, note: HANDOFF_LINE });
    const again = await callTool("restoreproof_write_workflow", { cron: "0 3 * * *" }, ctx);
    expect(again.structured).toMatchObject({ written: false });
    expect(again.structured["refused"]).toContain("--force");
  });

  it("test_restore takes a variable's name, never a URL, and errors with code, cause, fix and retryable", async () => {
    const bad = await callTool(
      "restoreproof_test_restore",
      { url: "postgres://u:p@h/db" },
      { env: {} },
    );
    expect(bad).toMatchObject({ isError: true, structured: { code: "INVALID_INPUT" } });
    const none = await callTool("restoreproof_test_restore", {}, { env: {} });
    expect(none.isError).toBe(true);
    expect(Object.keys(none.structured).sort()).toEqual(["cause", "code", "fix", "retryable"]);
    expect(none.structured["code"]).toBe("NO_DATABASE_URL");
    const both = await callTool(
      "restoreproof_test_restore",
      { url_env: "X", dump_file: "a.dump" },
      { env: {} },
    );
    expect(both.structured["code"]).toBe("INVALID_INPUT");
  });
});
