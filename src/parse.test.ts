/** The parsers and the SQL builders, on recorded and synthetic output. */
import { describe, expect, it } from "vitest";
import { countKinds, majorOf, parseFacts, parseProbe } from "./facts.js";
import { aptPackages, scopeFor } from "./scope.js";
import { FIELD, PROBE_SQL, factsSql, ident, literal } from "./sql.js";
import { dumpedFrom, filterToc, parseToc } from "./toc.js";
import { dumpArgs } from "./drill.js";
import { parseToolVersion } from "./pg.js";

const rows = (...r: string[][]) => r.map((x) => x.join(FIELD)).join("\0") + "\0";

/** The shape of `pg_restore -l` from pg_dump 17 on a small Supabase-like database. */
const TOC = `;
; Archive created at 2026-10-09 13:30:18 PDT
;     dbname: source
;     TOC Entries: 120
;     Compression: gzip
;     Dump Version: 1.16-0
;     Format: CUSTOM
;     Integer: 4 bytes
;     Offset: 8 bytes
;     Dumped from database version: 17.9 (Homebrew)
;     Dumped by pg_dump version: 17.9 (Homebrew)
;
;
; Selected TOC Entries:
;
7; 2615 16391 SCHEMA - auth restoreproof
10; 2615 16385 SCHEMA - extensions restoreproof
3; 3079 16404 EXTENSION - pg_graphql
4512; 0 0 COMMENT - EXTENSION pg_graphql
2; 3079 16386 EXTENSION - pgcrypto
4513; 0 0 COMMENT - EXTENSION pgcrypto
9; 3079 16389 EXTENSION - uuid-ossp
4514; 0 0 COMMENT - EXTENSION "uuid-ossp"
4; 3079 16420 EXTENSION - pg_net
5; 2328 16500 FOREIGN DATA WRAPPER - stripe_wrapper -
6; 1417 16501 SERVER - stripe_server -
8; 1418 16502 USER MAPPING - USER MAPPING postgres SERVER stripe_server -
230; 1259 16503 FOREIGN TABLE stripe customers -
220; 1259 16420 TABLE auth users -
4400; 0 16420 TABLE DATA auth users -
4300; 2606 16430 CONSTRAINT auth users users_pkey -
4301; 2606 16431 FK CONSTRAINT public profiles profiles_id_fkey -
4302; 3256 16432 POLICY public profiles own profile -
`;

describe("the archive's table of contents", () => {
  it("parses entries and the version it was dumped from", () => {
    const { header, entries } = parseToc(TOC);
    expect(dumpedFrom(header)).toBe("17.9");
    expect(entries.map((e) => e.type)).toEqual([
      "SCHEMA",
      "SCHEMA",
      "EXTENSION",
      "COMMENT",
      "EXTENSION",
      "COMMENT",
      "EXTENSION",
      "COMMENT",
      "EXTENSION",
      "FOREIGN DATA WRAPPER",
      "SERVER",
      "USER MAPPING",
      "FOREIGN TABLE",
      "TABLE",
      "TABLE DATA",
      "CONSTRAINT",
      "FK CONSTRAINT",
      "POLICY",
    ]);
  });

  it("leaves out unavailable extensions with their comments, and every foreign-data object", () => {
    const f = filterToc(TOC, (name) => name !== "pgcrypto");
    expect(f.extensions).toEqual(["pg_graphql", "pgcrypto", "uuid-ossp", "pg_net"]);
    expect(f.skippedExtensions).toEqual(["pg_graphql", "uuid-ossp", "pg_net"]);
    // the comment names a quoted extension in quotes, and goes with it
    expect(f.list).not.toContain("uuid-ossp");
    expect(f.skippedForeign).toBe(4);
    expect(f.list).toContain("EXTENSION - pgcrypto");
    expect(f.list).toContain("COMMENT - EXTENSION pgcrypto");
    expect(f.list).not.toContain("pg_graphql");
    expect(f.list).not.toContain("pg_net");
    expect(f.list).not.toMatch(/FOREIGN|SERVER|USER MAPPING/);
    expect(f.list).toContain("TABLE DATA auth users");
    expect(f.list).toContain("POLICY public profiles own profile");
  });
});

describe("psql's output", () => {
  it("parses the probe", () => {
    const p = parseProbe(
      rows(
        ["version", "170006", "17.6 (Ubuntu 17.6-1.pgdg24.04+1)"],
        ["role", "true", ""],
        ["size", "9512345", ""],
        ["schema", "auth", ""],
        ["schema", "public", ""],
        ["extension", "pgcrypto", "extensions"],
        ["role_used", "authenticated", ""],
        ["role_used", "authenticated", ""],
        ["rls_blocked", "public.secrets", "public"],
      ),
    );
    expect(p).toEqual({
      versionNum: 170006,
      version: "17.6",
      major: 17,
      privileged: true,
      size: 9512345,
      schemas: ["auth", "public"],
      extensions: [{ name: "pgcrypto", schema: "extensions" }],
      rolesUsed: ["authenticated"],
      rlsBlocked: [{ table: "public.secrets", schema: "public" }],
    });
    expect(majorOf(90624)).toBe(9);
    expect(majorOf(150014)).toBe(15);
  });

  it("parses facts, keeping definitions as hashes and rows as numbers", () => {
    const f = parseFacts(
      rows(
        ["table", "public.users", "kind=r rls=true force=false persistence=p"],
        ["rows", "public.users", "1204"],
        ["column", "public.users.email", "9f86d081884c7d659a2feaa0c55ad015"],
        ["policy", "public.users.own", "abc"],
        ["extension", "pgcrypto", "1.3"],
        ["meta", "server_version", "17.6 (Debian)"],
        ["meta", "server_version_num", "170006"],
        ["something new", "x", "y"],
      ),
    );
    expect(f.rows).toEqual({ "public.users": 1204 });
    expect(f.extensions).toEqual({ pgcrypto: "1.3" });
    expect(f.version).toBe("17.6");
    expect(f.versionNum).toBe(170006);
    expect(countKinds(f.objects)).toEqual({ table: 1, column: 1, policy: 1 });
  });

  it("survives names with quotes, spaces and newlines, because rows end in \\0", () => {
    const f = parseFacts(rows(["rows", 'odd."ta\nble"', "3"]));
    expect(f.rows).toEqual({ 'odd."ta\nble"': 3 });
  });
});

describe("the SQL", () => {
  it("quotes literals and identifiers", () => {
    expect(literal("it's")).toBe("'it''s'");
    expect(ident('my"schema')).toBe('"my""schema"');
  });

  it("reads the source in one READ ONLY snapshot with row security off, and the copy without", () => {
    const sql = factsSql(["public", "o'brien"], { readOnly: true });
    expect(
      sql.startsWith(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL row_security = off;",
      ),
    ).toBe(true);
    expect(sql).toContain("ARRAY['public', 'o''brien']::text[]");
    expect(sql).toContain("query_to_xml(format('SELECT count(*) AS c FROM %I.%I'");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b/);
    expect(factsSql(["public"], { readOnly: false })).not.toContain("BEGIN");
    expect(PROBE_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b/);
  });
});

describe("what goes into the backup", () => {
  it("leaves Supabase's platform schemas and logs out, and keeps the customer's", () => {
    const s = scopeFor(
      "supabase",
      [
        "auth",
        "extensions",
        "graphql",
        "net",
        "public",
        "realtime",
        "storage",
        "supabase_functions",
        "vault",
        "app",
      ],
      [],
    );
    expect(s.schemas).toEqual([
      "auth",
      "extensions",
      "public",
      "storage",
      "supabase_functions",
      "app",
    ]);
    expect(s.excludedSchemas).toEqual(["graphql", "net", "realtime", "vault"]);
    expect(s.excludedTableData).toEqual([
      "storage.buckets_vectors",
      "storage.vector_indexes",
      "supabase_functions.hooks",
    ]);
    expect(scopeFor("neon", ["public", "app"], ["app"])).toEqual({
      schemas: ["public"],
      excludedSchemas: ["app"],
      excludedTableData: [],
    });
  });

  it("dumps in custom format with no owners, grants or subscriptions, names quoted exactly", () => {
    const args = dumpArgs("/tmp/x.dump", {
      schemas: ["public"],
      excludedSchemas: ["graphql", 'we"ird'],
      excludedTableData: ["storage.vector_indexes"],
    });
    expect(args).toEqual([
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--no-subscriptions",
      "--lock-wait-timeout=120000",
      "--file=/tmp/x.dump",
      '--exclude-schema="graphql"',
      '--exclude-schema="we""ird"',
      '--exclude-table-data="storage"."vector_indexes"',
    ]);
  });

  it("installs the server of the source's major and the packages its extensions need", () => {
    expect(
      aptPackages(17, [
        "pgcrypto",
        "vector",
        "postgis",
        "postgis_topology",
        "pg_cron",
        "pg_graphql",
      ]),
    ).toEqual(["postgresql-17", "postgresql-17-pgvector", "postgresql-17-postgis-3"]);
  });

  it("reads PostgreSQL's version lines", () => {
    expect(parseToolVersion("pg_dump (PostgreSQL) 17.9 (Homebrew)")).toEqual({
      major: 17,
      version: "17.9",
    });
    expect(parseToolVersion("pg_dump (PostgreSQL) 18beta1")).toEqual({ major: 18, version: "18" });
    expect(parseToolVersion("nope")).toBeNull();
  });
});
