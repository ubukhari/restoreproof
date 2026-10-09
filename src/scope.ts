/**
 * What goes into the backup, per provider, and what the throwaway copy leaves out.
 *
 * Supabase runs platform services inside the database. Their schemas belong to extensions or to
 * services that recreate them (GraphQL, Vault, Realtime, pg_net, pg_cron, the pooler, analytics),
 * so the backup leaves them out, as `supabase db dump` does. It keeps what is the customer's: their
 * own schemas, `public`, and the `auth` and `storage` tables (users, identities, buckets and the
 * metadata of stored objects), plus `supabase_migrations` and `supabase_functions` (database
 * webhooks). Supabase's own restore guide leaves out the data of two Storage vector tables; so does
 * this.
 */
import type { Provider } from "./url.js";

/** Supabase schemas the backup leaves out: extension-owned or recreated by the platform. */
export const SUPABASE_EXCLUDED_SCHEMAS = [
  "graphql",
  "graphql_public",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "net",
  "cron",
  "realtime",
  "_realtime",
  "_analytics",
  "_supavisor",
  "pgbouncer",
  "pgtle",
] as const;

/** Tables whose rows the Supabase backup leaves out (definitions stay). */
export const SUPABASE_EXCLUDED_TABLE_DATA = [
  "storage.buckets_vectors",
  "storage.vector_indexes",
  "supabase_functions.hooks",
] as const;

/**
 * Extensions never created in the throwaway copy, whatever the source has: they schedule work,
 * make HTTP requests or need a server key, and a restored copy must not act. Objects that need them
 * are reported, not run.
 */
export const NEVER_IN_COPY = [
  "pg_cron",
  "pg_net",
  "http",
  "pgsodium",
  "supabase_vault",
  "pgaudit",
  "pg_stat_monitor",
  "dblink",
  "postgres_fdw",
  "wrappers",
] as const;

/** Debian package (from the PostgreSQL apt repository) for an extension that is not in core. */
export const APT_PACKAGES: Record<string, (major: number) => string> = {
  vector: (m) => `postgresql-${m}-pgvector`,
  postgis: (m) => `postgresql-${m}-postgis-3`,
  postgis_topology: (m) => `postgresql-${m}-postgis-3`,
  postgis_raster: (m) => `postgresql-${m}-postgis-3`,
  postgis_tiger_geocoder: (m) => `postgresql-${m}-postgis-3`,
  address_standardizer: (m) => `postgresql-${m}-postgis-3`,
  pgrouting: (m) => `postgresql-${m}-pgrouting`,
  hypopg: (m) => `postgresql-${m}-hypopg`,
  pg_partman: (m) => `postgresql-${m}-partman`,
  pg_repack: (m) => `postgresql-${m}-repack`,
  rum: (m) => `postgresql-${m}-rum`,
  orafce: (m) => `postgresql-${m}-orafce`,
  pg_hint_plan: (m) => `postgresql-${m}-pg-hint-plan`,
  pgtap: (m) => `postgresql-${m}-pgtap`,
  ip4r: (m) => `postgresql-${m}-ip4r`,
  h3: (m) => `postgresql-${m}-h3`,
  pg_uuidv7: (m) => `postgresql-${m}-pg-uuidv7`,
};

/** The apt packages the throwaway copy needs: the server of `major`, then extension packages. */
export function aptPackages(major: number, extensions: readonly string[]): string[] {
  const pkgs = new Set<string>([`postgresql-${major}`]);
  for (const e of extensions) {
    if ((NEVER_IN_COPY as readonly string[]).includes(e)) continue;
    const pkg = APT_PACKAGES[e];
    if (pkg) pkgs.add(pkg(major));
  }
  return [...pkgs];
}

export interface Scope {
  /** schemas in the backup and in the comparison */
  schemas: string[];
  /** schemas pg_dump is told to leave out */
  excludedSchemas: string[];
  /** tables whose rows pg_dump leaves out */
  excludedTableData: string[];
}

/**
 * The backup's schemas: every non-system schema of the source, less the provider's platform
 * schemas and any the customer names (RESTOREPROOF_EXCLUDE_SCHEMAS).
 */
export function scopeFor(
  provider: Provider,
  schemas: readonly string[],
  extraExcluded: readonly string[],
): Scope {
  const excluded = new Set<string>(extraExcluded);
  const tableData: string[] = [];
  if (provider === "supabase") {
    for (const s of SUPABASE_EXCLUDED_SCHEMAS) excluded.add(s);
    tableData.push(...SUPABASE_EXCLUDED_TABLE_DATA);
  }
  const kept = schemas.filter((s) => !excluded.has(s));
  return {
    schemas: kept,
    excludedSchemas: schemas.filter((s) => excluded.has(s)),
    excludedTableData: tableData.filter((t) => kept.includes(t.slice(0, t.indexOf(".")))),
  };
}

/** A comma- or space-separated list from an environment variable. */
export function listFrom(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
