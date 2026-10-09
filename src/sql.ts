/**
 * The queries the drill runs, on the source before and on the throwaway copy after. They read the
 * system catalogs and count rows; they write nothing. On the source they run in one READ ONLY
 * transaction, so every count comes from the same snapshot.
 *
 * Each row is `kind`, `name`, `detail`, separated by \x1f; rows are separated by \0 (psql's `-0`),
 * so no name or definition can break the parse. Definitions travel as md5 hashes: the facts never
 * hold a row of data or a function body, only what is needed to say "the copy has the same".
 */

export const FIELD = "\x1f";

/** psql arguments for the facts and probe queries: quiet, unaligned, tuples only, \x1f and \0. */
export const PSQL_ARGS = [
  "-X",
  "-q",
  "-A",
  "-t",
  "-F",
  FIELD,
  "-0",
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  "-",
];

/** A string as an SQL literal: single quotes doubled. */
export function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** A name as an SQL identifier: double quotes doubled. */
export function ident(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** `schema.table` → `"schema"."table"`, from the two parts. */
export function qualified(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`;
}

function schemaArray(schemas: readonly string[]): string {
  return schemas.length ? `ARRAY[${schemas.map(literal).join(", ")}]::text[]` : `ARRAY[]::text[]`;
}

/** What the drill needs to know about the source before it dumps it. */
export const PROBE_SQL = `
SELECT 'version', current_setting('server_version_num'), current_setting('server_version');
SELECT 'role', (r.rolsuper OR r.rolbypassrls)::text, ''
  FROM pg_roles r WHERE r.rolname = current_user;
SELECT 'size', pg_database_size(current_database())::text, '';
SELECT 'schema', n.nspname, ''
  FROM pg_namespace n
 WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
 ORDER BY 2;
SELECT 'extension', e.extname, n.nspname
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname <> 'plpgsql'
 ORDER BY 2;
SELECT DISTINCT 'role_used', r::text, ''
  FROM pg_policies, unnest(roles) AS r
 WHERE r::text <> 'public';
SELECT DISTINCT 'role_used', usename::text, ''
  FROM pg_user_mappings
 WHERE usename::text <> 'public';
SELECT 'rls_blocked', n.nspname || '.' || c.relname, n.nspname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity
   AND NOT pg_has_role(c.relowner, 'USAGE')
   AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls));
`;

/** True when the catalog row `oid` of catalog `cat` belongs to an extension. */
const memberOf = (cat: string, oid: string) =>
  `EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${cat}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

/**
 * The schema of everything in `schemas` that is not part of an extension: tables and their RLS
 * flags, columns, constraints, indexes, views, functions, triggers, policies, sequences, enums and
 * domains; the extensions; and the exact row count of every leaf table (partitions, not their
 * parents), through `query_to_xml`, so that every count comes from the transaction's one snapshot.
 */
export function factsSql(schemas: readonly string[], opts: { readOnly: boolean }): string {
  const S = schemaArray(schemas);
  const inScope = (nsp: string) => `${nsp}.nspname = ANY (${S})`;
  const body = `
SELECT 'table', n.nspname || '.' || c.relname,
       'kind=' || c.relkind::text || ' rls=' || c.relrowsecurity::text || ' force=' || c.relforcerowsecurity::text || ' persistence=' || c.relpersistence::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'rows', n.nspname || '.' || c.relname,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r' AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname,
       md5(format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' ||
           coalesce(pg_get_expr(ad.adbin, ad.adrelid), '') || '|' || a.attidentity::text || '|' ||
           a.attgenerated::text || '|' || coalesce(nullif(co.collname, 'default'), ''))
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  LEFT JOIN pg_collation co ON co.oid = a.attcollation
 WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
   AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'constraint', n.nspname || '.' || c.relname || '.' || con.conname, md5(pg_get_constraintdef(con.oid))
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE con.contype <> 'n' AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'index', n.nspname || '.' || i.relname, md5(pg_get_indexdef(i.oid))
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = i.relnamespace
 WHERE t.relkind IN ('r', 'p', 'm') AND ${inScope("n")} AND NOT ${memberOf("pg_class", "t.oid")};
SELECT CASE c.relkind WHEN 'v' THEN 'view' ELSE 'matview' END, n.nspname || '.' || c.relname,
       md5(pg_get_viewdef(c.oid))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('v', 'm') AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END,
       n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prokind = 'a' THEN '' ELSE md5(pg_get_functiondef(p.oid)) END
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE ${inScope("n")} AND NOT ${memberOf("pg_proc", "p.oid")};
SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, md5(pg_get_triggerdef(t.oid))
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'policy', n.nspname || '.' || c.relname || '.' || p.polname,
       md5(p.polcmd::text || '|' || p.polpermissive::text || '|' ||
           coalesce((SELECT string_agg(CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END, ',' ORDER BY 1)
                       FROM unnest(p.polroles) AS r), '') || '|' ||
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE ${inScope("n")};
SELECT 'sequence', n.nspname || '.' || c.relname, ''
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'S' AND ${inScope("n")} AND NOT ${memberOf("pg_class", "c.oid")};
SELECT 'enum', n.nspname || '.' || t.typname, md5(string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder))
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE ${inScope("n")} AND NOT ${memberOf("pg_type", "t.oid")}
 GROUP BY n.nspname, t.typname;
SELECT 'domain', n.nspname || '.' || t.typname,
       md5(format_type(t.typbasetype, t.typtypmod) || '|' || t.typnotnull::text || '|' || coalesce(t.typdefault, '') || '|' ||
           coalesce((SELECT string_agg(pg_get_constraintdef(k.oid), ',' ORDER BY k.conname) FROM pg_constraint k WHERE k.contypid = t.oid), ''))
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE t.typtype = 'd' AND ${inScope("n")} AND NOT ${memberOf("pg_type", "t.oid")};
SELECT 'extension', e.extname, e.extversion
  FROM pg_extension e
 WHERE e.extname <> 'plpgsql';
SELECT 'meta', 'server_version', current_setting('server_version');
SELECT 'meta', 'server_version_num', current_setting('server_version_num');
`;
  // row_security off: a count RLS would filter fails instead of coming back short, as pg_dump does
  return opts.readOnly
    ? `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL row_security = off;\n${body}\nCOMMIT;\n`
    : body;
}

/** Rows of psql's output under PSQL_ARGS: \0 between rows, \x1f between fields. */
export function parseRows(stdout: string): string[][] {
  return stdout
    .split("\0")
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.length > 0)
    .map((r) => r.split(FIELD));
}
