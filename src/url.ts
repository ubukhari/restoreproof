/**
 * The database URL, turned into libpq's environment variables so that `pg_dump`, `pg_restore` and
 * `psql` read it from their environment and never from their argument list (which other users of a
 * machine can see in `ps`). Nothing here prints the URL or any part of it but the host's provider.
 *
 * Also the provider (Supabase, Neon or another Postgres), read from the host, and the connection
 * strings each provider documents as unusable for `pg_dump`, refused before anything connects.
 */
import { fail } from "./errors.js";

export type Provider = "supabase" | "neon" | "postgres";
export const PROVIDERS: readonly Provider[] = ["supabase", "neon", "postgres"];

/** libpq's environment variable for each URI query parameter it reads; any other is ignored. */
const PARAM_ENV: Record<string, string> = {
  host: "PGHOST",
  hostaddr: "PGHOSTADDR",
  port: "PGPORT",
  dbname: "PGDATABASE",
  user: "PGUSER",
  password: "PGPASSWORD",
  options: "PGOPTIONS",
  application_name: "PGAPPNAME",
  sslmode: "PGSSLMODE",
  sslrootcert: "PGSSLROOTCERT",
  sslcert: "PGSSLCERT",
  sslkey: "PGSSLKEY",
  sslcrl: "PGSSLCRL",
  sslnegotiation: "PGSSLNEGOTIATION",
  channel_binding: "PGCHANNELBINDING",
  connect_timeout: "PGCONNECT_TIMEOUT",
  target_session_attrs: "PGTARGETSESSIONATTRS",
  gssencmode: "PGGSSENCMODE",
  require_auth: "PGREQUIREAUTH",
  sslsni: "PGSSLSNI",
};

export interface Connection {
  /** libpq environment variables: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, … */
  env: Record<string, string>;
  host: string;
  port: number;
  /** URI parameters libpq does not read (Prisma's `schema`, `pgbouncer`, …), ignored */
  ignored: string[];
}

/** Parse a `postgres://` or `postgresql://` URI. Throws BAD_DATABASE_URL, naming no part of it. */
export function parseDatabaseUrl(raw: string): Connection {
  const value = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(value))
    throw fail(
      "BAD_DATABASE_URL",
      "the database URL does not start with postgres:// or postgresql://",
      "Use the connection string your provider shows, in URI form: postgresql://user:password@host:5432/dbname.",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail(
      "BAD_DATABASE_URL",
      "the database URL is not a valid URI (a URI with several hosts is not supported)",
      "Use a single-host URI, and percent-encode special characters in the password (@ as %40, # as %23, / as %2F).",
    );
  }
  const env: Record<string, string> = {};
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host) env["PGHOST"] = decodeURIComponent(host);
  if (url.port) env["PGPORT"] = url.port;
  if (url.username) env["PGUSER"] = decodeURIComponent(url.username);
  if (url.password) env["PGPASSWORD"] = decodeURIComponent(url.password);
  const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (db) env["PGDATABASE"] = db;
  const ignored: string[] = [];
  for (const [key, val] of url.searchParams) {
    const name = PARAM_ENV[key];
    if (name) env[name] = val;
    else ignored.push(key);
  }
  if (!env["PGHOST"])
    throw fail(
      "BAD_DATABASE_URL",
      "the database URL names no host",
      "Use the full connection string, with the host your provider shows.",
    );
  return { env, host: env["PGHOST"]!, port: Number(env["PGPORT"] ?? 5432), ignored };
}

/** The provider a host belongs to. */
export function providerOf(host: string): Provider {
  const h = host.toLowerCase();
  if (h.endsWith(".supabase.co") || h.endsWith(".supabase.com")) return "supabase";
  if (h.endsWith(".neon.tech") || h.endsWith(".neon.build") || h.endsWith(".neon.com"))
    return "neon";
  return "postgres";
}

/** `db.<ref>.supabase.co`: Supabase's direct connection, IPv6 unless the IPv4 add-on is bought. */
export function isSupabaseDirect(host: string): boolean {
  return /^db\.[a-z0-9]+\.supabase\.co$/i.test(host);
}

/** `*.pooler.supabase.com`: Supavisor; port 6543 is transaction mode, 5432 session mode. */
export function isSupabasePooler(host: string): boolean {
  return /\.pooler\.supabase\.com$/i.test(host);
}

/** Neon's pooled endpoint: the first label of the host ends in `-pooler`. */
export function isNeonPooled(host: string): boolean {
  return /^[^.]+-pooler\./i.test(host) && providerOf(host) === "neon";
}

/**
 * Refuse the connection strings the providers document as unusable for `pg_dump`, before anything
 * connects: Supabase's transaction pooler and Neon's pooled endpoint.
 */
export function checkConnection(conn: Connection): void {
  if (isSupabasePooler(conn.host) && conn.port === 6543)
    throw fail(
      "SUPABASE_TRANSACTION_POOLER",
      "this is Supabase's transaction pooler (port 6543), which does not support prepared statements or a whole-database dump",
      "Use the Session pooler string instead: Connect > Session pooler in the Supabase dashboard, the same host on port 5432.",
    );
  if (isNeonPooled(conn.host))
    throw fail(
      "NEON_POOLED",
      'this is Neon\'s pooled connection string ("-pooler" in the host); Neon says to avoid pg_dump over a pooled connection',
      'Use the direct connection string: the same host without "-pooler" (Connection pooling off in the Connect dialog).',
    );
}

/**
 * What a connection failure means, for the hosts whose failures have one well-known cause. The
 * message from libpq is passed in; the URL never is.
 */
export function explainConnectError(conn: Connection, stderr: string, ci: boolean) {
  if (
    isSupabaseDirect(conn.host) &&
    /Network is unreachable|No route to host|could not translate host name|ENETUNREACH|Cannot assign requested address/i.test(
      stderr,
    )
  )
    return fail(
      "SUPABASE_DIRECT_IPV6",
      `Supabase's direct connection (db.<ref>.supabase.co) is IPv6 unless the project has the IPv4 add-on, and ${
        ci ? "GitHub's hosted runners have" : "this network has"
      } no IPv6`,
      "Use the Session pooler string: Connect > Session pooler in the Supabase dashboard (host *.pooler.supabase.com, port 5432), which is IPv4 on every plan.",
      false,
    );
  if (/password authentication failed|authentication failed/i.test(stderr))
    return fail(
      "DATABASE_AUTH_FAILED",
      "the database refused the user name or password in the URL",
      "Copy the connection string again from the provider's dashboard; a password with @, #, / or : must be percent-encoded.",
    );
  return null;
}
