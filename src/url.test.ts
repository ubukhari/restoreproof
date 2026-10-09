import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { pgEnv } from "./pg.js";
import {
  checkConnection,
  explainConnectError,
  isNeonPooled,
  isSupabaseDirect,
  parseDatabaseUrl,
  providerOf,
} from "./url.js";

// synthetic hosts and passwords only
const SUPA_DIRECT = "postgresql://postgres:s3cr%40t@db.abcdefghijklmnop.supabase.co:5432/postgres";
const SUPA_SESSION =
  "postgresql://postgres.abcdefghijklmnop:s3cr%40t@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
const SUPA_TX =
  "postgresql://postgres.abcdefghijklmnop:s3cr%40t@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
const NEON =
  "postgresql://app_owner:pw@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
const NEON_POOLED =
  "postgresql://app_owner:pw@ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";

describe("the database URL", () => {
  it("becomes libpq environment variables, password decoded, never an argument", () => {
    const c = parseDatabaseUrl(SUPA_DIRECT);
    expect(c.env).toEqual({
      PGHOST: "db.abcdefghijklmnop.supabase.co",
      PGPORT: "5432",
      PGUSER: "postgres",
      PGPASSWORD: "s3cr@t",
      PGDATABASE: "postgres",
    });
    const n = parseDatabaseUrl(NEON);
    expect(n.env["PGSSLMODE"]).toBe("require");
    expect(n.env["PGCHANNELBINDING"]).toBe("require");
    expect(n.port).toBe(5432);
  });

  it("ignores parameters libpq does not read (Prisma's), and says which", () => {
    const c = parseDatabaseUrl(
      "postgres://u:p@db.example.test:5433/app?schema=public&pgbouncer=true&sslmode=verify-full",
    );
    expect(c.ignored).toEqual(["schema", "pgbouncer"]);
    expect(c.env["PGSSLMODE"]).toBe("verify-full");
  });

  it("refuses anything but a single-host postgres URI, without repeating it", () => {
    for (const bad of [
      "mysql://u:hunter2@h/db",
      "host=h user=u password=hunter2",
      "postgres://u:hunter2@/db",
    ]) {
      try {
        parseDatabaseUrl(bad);
        expect.unreachable(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        expect((e as CliError).code).toBe("BAD_DATABASE_URL");
        expect(JSON.stringify((e as CliError).toJSON())).not.toContain("hunter2");
      }
    }
  });

  it("names the provider from the host", () => {
    expect(providerOf("db.abc.supabase.co")).toBe("supabase");
    expect(providerOf("aws-0-us-east-1.pooler.supabase.com")).toBe("supabase");
    expect(providerOf("ep-x-1.us-east-2.aws.neon.tech")).toBe("neon");
    expect(providerOf("my-db.abc.eu-west-1.rds.amazonaws.com")).toBe("postgres");
    expect(isSupabaseDirect("db.abcdefghijklmnop.supabase.co")).toBe(true);
    expect(isNeonPooled("ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech")).toBe(true);
    expect(isNeonPooled("ep-cool-name-123456.eu-central-1.aws.neon.tech")).toBe(false);
  });
});

describe("the connection strings providers say pg_dump cannot use", () => {
  it("refuses Supabase's transaction pooler and Neon's pooled host before connecting", () => {
    expect(() => checkConnection(parseDatabaseUrl(SUPA_TX))).toThrow(/SUPABASE_TRANSACTION_POOLER/);
    expect(() => checkConnection(parseDatabaseUrl(NEON_POOLED))).toThrow(/NEON_POOLED/);
    expect(() => checkConnection(parseDatabaseUrl(SUPA_SESSION))).not.toThrow();
    expect(() => checkConnection(parseDatabaseUrl(SUPA_DIRECT))).not.toThrow();
    expect(() => checkConnection(parseDatabaseUrl(NEON))).not.toThrow();
  });

  it("explains Supabase's IPv6-only direct host when the network cannot reach it", () => {
    const e = explainConnectError(
      parseDatabaseUrl(SUPA_DIRECT),
      'psql: error: connection to server at "db.abcdefghijklmnop.supabase.co" (2a05:d018::1), port 5432 failed: Network is unreachable',
      true,
    );
    expect(e?.code).toBe("SUPABASE_DIRECT_IPV6");
    expect(e?.cause).toContain("GitHub's hosted runners have no IPv6");
    expect(e?.fix).toContain("Session pooler");
    expect(
      explainConnectError(parseDatabaseUrl(SUPA_SESSION), "Network is unreachable", true),
    ).toBeNull();
    expect(
      explainConnectError(
        parseDatabaseUrl(NEON),
        "FATAL:  password authentication failed for user",
        false,
      )?.code,
    ).toBe("DATABASE_AUTH_FAILED");
  });
});

describe("the environment PostgreSQL's programs get", () => {
  it("drops every PG* variable of the caller's shell and sets only ours", () => {
    const env = pgEnv(
      { PATH: "/bin", PGSERVICE: "prod", PGPASSFILE: "/home/x/.pgpass", PGHOST: "elsewhere" },
      { PGHOST: "h", PGPASSWORD: "p" },
    );
    expect(env).toEqual({ PATH: "/bin", PGHOST: "h", PGPASSWORD: "p", PGCONNECT_TIMEOUT: "30" });
  });
});
