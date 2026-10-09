/**
 * The probe and the facts, parsed from psql's output (src/sql.ts). Facts are what the drill
 * compares: definitions as hashes, rows as counts, and never a row of data.
 */
import { parseRows } from "./sql.js";

export interface Probe {
  /** e.g. 170006 */
  versionNum: number;
  /** e.g. "17.6" or "17.6 (Debian 17.6-1.pgdg120+1)" */
  version: string;
  major: number;
  /** superuser or BYPASSRLS: pg_dump reads past row-level security */
  privileged: boolean;
  /** bytes, pg_database_size */
  size: number;
  /** every schema but pg_* and information_schema */
  schemas: string[];
  extensions: { name: string; schema: string }[];
  /** roles named by policies or user mappings: the copy needs them to exist */
  rolesUsed: string[];
  /** tables row-level security would hide from this role, so pg_dump would fail on them */
  rlsBlocked: { table: string; schema: string }[];
}

export function majorOf(versionNum: number): number {
  // 170006 → 17; 90624 (9.6) → 9, which no supported path uses
  return Math.floor(versionNum / 10000);
}

export function parseProbe(stdout: string): Probe {
  const p: Probe = {
    versionNum: 0,
    version: "",
    major: 0,
    privileged: false,
    size: 0,
    schemas: [],
    extensions: [],
    rolesUsed: [],
    rlsBlocked: [],
  };
  for (const [kind, a = "", b = ""] of parseRows(stdout)) {
    if (kind === "version") {
      p.versionNum = Number(a);
      p.version = b.split(" ")[0] ?? b;
      p.major = majorOf(p.versionNum);
    } else if (kind === "role") p.privileged = a === "true";
    else if (kind === "size") p.size = Number(a);
    else if (kind === "schema") p.schemas.push(a);
    else if (kind === "extension") p.extensions.push({ name: a, schema: b });
    else if (kind === "role_used" && !p.rolesUsed.includes(a)) p.rolesUsed.push(a);
    else if (kind === "rls_blocked") p.rlsBlocked.push({ table: a, schema: b });
  }
  return p;
}

/** The kinds of schema object compared by definition. */
export const OBJECT_KINDS = [
  "table",
  "column",
  "constraint",
  "index",
  "view",
  "matview",
  "function",
  "procedure",
  "aggregate",
  "trigger",
  "policy",
  "sequence",
  "enum",
  "domain",
] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export interface Facts {
  version: string;
  versionNum: number;
  /** `kind name` → definition hash (or detail, for tables) */
  objects: Record<string, string>;
  /** leaf table `schema.name` → exact row count */
  rows: Record<string, number>;
  /** extension name → version */
  extensions: Record<string, string>;
}

export function parseFacts(stdout: string): Facts {
  const f: Facts = { version: "", versionNum: 0, objects: {}, rows: {}, extensions: {} };
  for (const [kind = "", name = "", detail = ""] of parseRows(stdout)) {
    if (kind === "rows") f.rows[name] = Number(detail);
    else if (kind === "extension") f.extensions[name] = detail;
    else if (kind === "meta") {
      if (name === "server_version") f.version = detail.split(" ")[0] ?? detail;
      if (name === "server_version_num") f.versionNum = Number(detail);
    } else if ((OBJECT_KINDS as readonly string[]).includes(kind))
      f.objects[`${kind} ${name}`] = detail;
  }
  return f;
}

/** How many objects of each kind, e.g. { table: 12, column: 80, … }. */
export function countKinds(objects: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(objects)) {
    const kind = key.slice(0, key.indexOf(" "));
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

export function sum(values: Iterable<number>): number {
  let n = 0;
  for (const v of values) n += v;
  return n;
}
