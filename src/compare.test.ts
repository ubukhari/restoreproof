import { describe, expect, it } from "vitest";
import { allowance, bytes, compare, hashName, type CompareOptions } from "./compare.js";
import type { Facts } from "./facts.js";

const facts = (over: Partial<Facts> = {}): Facts => ({
  version: "17.6",
  versionNum: 170006,
  objects: {
    "table public.users": "kind=r rls=true force=false persistence=p",
    "column public.users.id": "aaa",
    "column public.users.email": "bbb",
    "policy public.users.own": "ccc",
    "function public.touch()": "ddd",
    "index public.users_pkey": "eee",
  },
  rows: { "public.users": 1000, "public.notes": 50, "public.empty": 0 },
  extensions: { pgcrypto: "1.3" },
  ...over,
});
const opts = (over: Partial<CompareOptions> = {}): CompareOptions => ({
  maxRowDrift: 10,
  maxShrink: 50,
  backupBytes: 100_000,
  ...over,
});

describe("compare", () => {
  it("passes when every object and every row came back", () => {
    const c = compare(facts(), facts(), opts());
    expect(c.ok).toBe(true);
    expect(c.findings).toEqual([]);
    expect(c.rows).toEqual({ live: 1050, restored: 1050 });
    expect(c.objects).toMatchObject({ source: 6, restored: 6, missing: 0, changed: 0 });
    expect(c.objects.byKind).toEqual({ table: 1, column: 2, policy: 1, function: 1, index: 1 });
    expect(c.tables.map((t) => t.verdict)).toEqual(["match", "match", "match"]);
  });

  it("fails on an object missing from the copy, or restored with another definition", () => {
    const copy = facts();
    delete copy.objects["policy public.users.own"];
    copy.objects["function public.touch()"] = "zzz";
    const c = compare(facts(), copy, opts());
    expect(c.ok).toBe(false);
    expect(c.findings.map((f) => [f.level, f.code])).toEqual([
      ["fail", "OBJECT_CHANGED"],
      ["fail", "OBJECT_MISSING"],
    ]);
    expect(c.findings[1]!.message).toContain("public.users.own");
    expect(c.findings[1]!.summary).not.toContain("public.users");
  });

  it("compares by name only across major versions, and says so", () => {
    const copy = facts({ versionNum: 180001 });
    copy.objects["function public.touch()"] = "different in 18";
    const c = compare(facts(), copy, opts());
    expect(c.ok).toBe(true);
    expect(c.sameMajor).toBe(false);
    expect(c.findings.map((f) => f.code)).toEqual(["OTHER_MAJOR"]);
  });

  it("fails a table that restored empty, whatever the allowance", () => {
    const c = compare(
      facts(),
      facts({ rows: { "public.users": 1000, "public.notes": 0, "public.empty": 0 } }),
      opts({ maxRowDrift: 100 }),
    );
    expect(c.ok).toBe(false);
    expect(c.findings[0]).toMatchObject({ level: "fail", code: "TABLE_RESTORED_EMPTY" });
    expect(c.findings[0]!.message).toContain("public.notes (50 rows)");
  });

  it("allows rows written during the backup, up to max(10, drift%), and warns", () => {
    expect(allowance(1000, 10)).toBe(100);
    expect(allowance(5, 10)).toBe(10);
    const near = compare(
      facts(),
      facts({ rows: { "public.users": 940, "public.notes": 48, "public.empty": 0 } }),
      opts(),
    );
    expect(near.ok).toBe(true);
    expect(near.findings).toMatchObject([{ level: "warn", code: "ROWS_CHANGED_DURING_BACKUP" }]);
    const far = compare(
      facts(),
      facts({ rows: { "public.users": 800, "public.notes": 50, "public.empty": 0 } }),
      opts(),
    );
    expect(far.ok).toBe(false);
    expect(far.findings[0]).toMatchObject({ level: "fail", code: "ROWS_DIFFER" });
    expect(far.findings[0]!.message).toContain("public.users 1,000 → 800");
  });

  it("fails a table missing from the copy", () => {
    const c = compare(
      facts(),
      facts({ rows: { "public.users": 1000, "public.empty": 0 } }),
      opts(),
    );
    expect(c.tables.find((t) => t.table === "public.notes")).toMatchObject({
      verdict: "missing",
      restored: null,
    });
  });

  it("against the last good run: fails a database that lost over half its rows, warns on gone tables and a shrunken backup", () => {
    const prev = {
      at: "2026-10-05T04:17:00Z",
      rows: 5000,
      tables: ["public.users", "public.notes", "public.orders"],
      backupBytes: 500_000,
    };
    const c = compare(facts(), facts(), opts({ previous: prev }));
    expect(c.ok).toBe(false);
    expect(c.findings.map((f) => [f.level, f.code])).toEqual([
      ["fail", "DATABASE_SHRANK"],
      ["warn", "TABLES_GONE"],
      ["warn", "BACKUP_SHRANK"],
    ]);
    expect(c.findings[0]!.message).toContain(
      "79% fewer than the 5,000 at the last good run (2026-10-05)",
    );
    expect(c.findings[1]!.message).toContain("public.orders");
    expect(
      compare(facts(), facts(), opts({ previous: prev, maxShrink: 100 })).findings.map(
        (f) => f.code,
      ),
    ).not.toContain("DATABASE_SHRANK");
  });

  it("compares a public repository's hashed table names without naming the gone one", () => {
    const prev = {
      at: "2026-10-05T04:17:00Z",
      rows: 1050,
      tables: ["public.users", "public.notes", "public.orders"].map(hashName),
      tablesHashed: true,
      backupBytes: 0,
    };
    const c = compare(facts(), facts(), opts({ previous: prev }));
    expect(c.findings).toHaveLength(1);
    expect(c.findings[0]).toMatchObject({ code: "TABLES_GONE" });
    expect(c.findings[0]!.message).toBe("1 table of the last good run (2026-10-05) is gone");
  });

  it("notes extensions and foreign-data objects left out of the copy", () => {
    const c = compare(
      facts(),
      facts(),
      opts({
        skippedExtensions: [{ name: "pg_net", why: "it makes requests" }],
        skippedForeign: 2,
      }),
    );
    expect(c.ok).toBe(true);
    expect(c.findings.map((f) => [f.level, f.code])).toEqual([
      ["note", "EXTENSION_NOT_IN_COPY"],
      ["note", "FOREIGN_NOT_IN_COPY"],
    ]);
  });

  it("says sizes the way people read them", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(93_800)).toBe("91.6 KB");
    expect(bytes(9_500_000)).toBe("9.1 MB");
    expect(bytes(250 * 1024 ** 3)).toBe("250 GB");
  });
});
