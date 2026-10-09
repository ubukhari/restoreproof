/**
 * The verdict: the facts of the source against the facts of the restored copy, and against the
 * last good run when there is one. A pure function, so every rule is tested on fixtures.
 *
 * Fails the test:
 * - an object of the source missing from the copy, or with a different definition (only compared
 *   when both run the same major version, since catalog output can differ across majors);
 * - a table with rows in the source that restored empty;
 * - a table whose restored rows differ from the live count by more than max(10, drift%): the live
 *   count is taken in one snapshot just after the dump, so rows written during the dump explain a
 *   small difference, and only a small one;
 * - a live database with `shrink`% fewer rows than at the last good run.
 *
 * Warns: rows that changed during the backup within the allowance; tables gone since the last good
 * run; a backup much smaller than the last good one; extensions left out of the copy.
 */
import { createHash } from "node:crypto";
import { OBJECT_KINDS, majorOf, sum, type Facts } from "./facts.js";

export type Level = "fail" | "warn" | "note";

export interface Finding {
  level: Level;
  code: string;
  /** the finding, naming the tables and objects it is about */
  message: string;
  /**
   * the same without any table, object or extension name or per-table count: what a public
   * repository's run summary shows, since anyone can read it
   */
  summary: string;
}

export interface TableCheck {
  table: string;
  live: number;
  restored: number | null;
  verdict: "match" | "changed" | "differs" | "empty" | "missing";
}

export interface Previous {
  at: string;
  rows: number;
  /** table names, or their hashes (hashName) when that run was in a public repository */
  tables: string[];
  tablesHashed?: boolean;
  backupBytes: number;
}

/** A table name as a public repository's facts file keeps it: a short SHA-256. */
export function hashName(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

export interface CompareOptions {
  /** percent a table may differ from its live count; default 10 */
  maxRowDrift: number;
  /** percent fewer live rows than the last good run that fails; default 50; 100 turns it off */
  maxShrink: number;
  backupBytes: number;
  previous?: Previous | null;
  /** extensions left out of the copy, and why */
  skippedExtensions?: { name: string; why: string }[];
  skippedForeign?: number;
}

export interface Comparison {
  ok: boolean;
  findings: Finding[];
  tables: TableCheck[];
  objects: {
    source: number;
    restored: number;
    missing: number;
    changed: number;
    byKind: Record<string, number>;
  };
  rows: { live: number; restored: number };
  sameMajor: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The most rows a table may differ by: max(10, drift% of its live count). */
export function allowance(live: number, driftPct: number): number {
  return Math.max(10, Math.floor((live * driftPct) / 100));
}

export function compare(source: Facts, restored: Facts, opts: CompareOptions): Comparison {
  const findings: Finding[] = [];
  const sameMajor = majorOf(source.versionNum) === majorOf(restored.versionNum);

  // schema objects
  let missing = 0;
  let changed = 0;
  const missingByKind: Record<string, string[]> = {};
  const changedByKind: Record<string, string[]> = {};
  const byKind: Record<string, number> = {};
  for (const [key, def] of Object.entries(source.objects)) {
    const kind = key.slice(0, key.indexOf(" "));
    const name = key.slice(kind.length + 1);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (!(key in restored.objects)) {
      missing++;
      (missingByKind[kind] ??= []).push(name);
    } else if (sameMajor && restored.objects[key] !== def) {
      changed++;
      (changedByKind[kind] ??= []).push(name);
    }
  }
  for (const kind of OBJECT_KINDS) {
    const m = missingByKind[kind];
    if (m?.length)
      findings.push({
        level: "fail",
        code: "OBJECT_MISSING",
        message: `${plural(m.length, kind)} of the source ${m.length === 1 ? "is" : "are"} not in the restored copy: ${list(m)}`,
        summary: `${plural(m.length, kind)} of the source ${m.length === 1 ? "is" : "are"} not in the restored copy`,
      });
    const c = changedByKind[kind];
    if (c?.length)
      findings.push({
        level: "fail",
        code: "OBJECT_CHANGED",
        message: `${plural(c.length, kind)} restored with a different definition: ${list(c)}`,
        summary: `${plural(c.length, kind)} restored with a different definition`,
      });
  }
  if (!sameMajor)
    findings.push({
      level: "note",
      code: "OTHER_MAJOR",
      message: `the copy runs PostgreSQL ${majorOf(restored.versionNum)} and the source ${majorOf(source.versionNum)}, so objects were compared by name, not definition`,
      summary: `the copy runs PostgreSQL ${majorOf(restored.versionNum)} and the source ${majorOf(source.versionNum)}, so objects were compared by name, not definition`,
    });

  // rows
  const tables: TableCheck[] = [];
  for (const [table, live] of Object.entries(source.rows)) {
    const got = table in restored.rows ? restored.rows[table]! : null;
    let verdict: TableCheck["verdict"];
    if (got === null) verdict = "missing";
    else if (got === live) verdict = "match";
    else if (got === 0 && live > 0) verdict = "empty";
    else if (Math.abs(got - live) > allowance(live, opts.maxRowDrift)) verdict = "differs";
    else verdict = "changed";
    tables.push({ table, live, restored: got, verdict });
  }
  tables.sort((a, b) => a.table.localeCompare(b.table));
  const pick = (v: TableCheck["verdict"]) => tables.filter((t) => t.verdict === v);
  const empty = pick("empty");
  if (empty.length)
    findings.push({
      level: "fail",
      code: "TABLE_RESTORED_EMPTY",
      message: `${plural(empty.length, "table")} with rows in the source restored empty: ${list(empty.map((t) => `${t.table} (${t.live.toLocaleString("en-US")} rows)`))}`,
      summary: `${plural(empty.length, "table")} with rows in the source restored empty`,
    });
  const differs = pick("differs");
  if (differs.length)
    findings.push({
      level: "fail",
      code: "ROWS_DIFFER",
      message: `${plural(differs.length, "table")} restored with more rows missing or extra than writes during the backup explain (over max(10, ${opts.maxRowDrift}%)): ${list(differs.map((t) => `${t.table} ${t.live.toLocaleString("en-US")} → ${t.restored!.toLocaleString("en-US")}`))}`,
      summary: `${plural(differs.length, "table")} restored with more rows missing or extra than writes during the backup explain (over max(10, ${opts.maxRowDrift}%))`,
    });
  const moved = pick("changed");
  if (moved.length)
    findings.push({
      level: "warn",
      code: "ROWS_CHANGED_DURING_BACKUP",
      message: `${plural(moved.length, "table")} changed between the backup and the count, within the allowance: ${list(moved.map((t) => `${t.table} ${t.live.toLocaleString("en-US")} → ${t.restored!.toLocaleString("en-US")}`))}`,
      summary: `${plural(moved.length, "table")} changed between the backup and the count, within the allowance`,
    });

  const liveRows = sum(Object.values(source.rows));
  const restoredRows = sum(tables.map((t) => t.restored ?? 0));

  // against the last good run
  const prev = opts.previous;
  if (prev) {
    if (opts.maxShrink < 100 && prev.rows > 0 && liveRows < prev.rows * (1 - opts.maxShrink / 100))
      findings.push({
        level: "fail",
        code: "DATABASE_SHRANK",
        message: `the database has ${liveRows.toLocaleString("en-US")} rows, ${Math.round((1 - liveRows / prev.rows) * 100)}% fewer than the ${prev.rows.toLocaleString("en-US")} at the last good run (${prev.at.slice(0, 10)}); if that was not intended, the last good run's backup still has them`,
        summary: `the database has ${Math.round((1 - liveRows / prev.rows) * 100)}% fewer rows than at the last good run (${prev.at.slice(0, 10)}); if that was not intended, the last good run's backup still has them`,
      });
    const names = Object.keys(source.rows);
    const now = new Set(prev.tablesHashed ? names.map(hashName) : names);
    const gone = prev.tables.filter((t) => !now.has(t));
    if (gone.length)
      findings.push({
        level: "warn",
        code: "TABLES_GONE",
        message: `${plural(gone.length, "table")} of the last good run (${prev.at.slice(0, 10)}) ${gone.length === 1 ? "is" : "are"} gone${prev.tablesHashed ? "" : `: ${list(gone)}`}`,
        summary: `${plural(gone.length, "table")} of the last good run (${prev.at.slice(0, 10)}) ${gone.length === 1 ? "is" : "are"} gone`,
      });
    if (prev.backupBytes > 0 && opts.backupBytes < prev.backupBytes / 2)
      findings.push({
        level: "warn",
        code: "BACKUP_SHRANK",
        message: `the backup is ${bytes(opts.backupBytes)}, under half the ${bytes(prev.backupBytes)} of the last good run (${prev.at.slice(0, 10)})`,
        summary: `the backup is under half the size of the last good run's (${prev.at.slice(0, 10)})`,
      });
  }

  for (const s of opts.skippedExtensions ?? [])
    findings.push({
      level: "note",
      code: "EXTENSION_NOT_IN_COPY",
      message: `extension ${s.name} was not created in the copy: ${s.why}`,
      summary: `extension ${s.name} was not created in the copy: ${s.why}`,
    });
  if (opts.skippedForeign)
    findings.push({
      level: "note",
      code: "FOREIGN_NOT_IN_COPY",
      message: `${plural(opts.skippedForeign, "foreign-data object")} (wrappers, servers, user mappings, foreign tables) left out of the copy: they point at other systems, and a backup holds none of their rows`,
      summary: `${plural(opts.skippedForeign, "foreign-data object")} left out of the copy: they point at other systems, and a backup holds none of their rows`,
    });

  return {
    ok: !findings.some((f) => f.level === "fail"),
    findings,
    tables,
    objects: {
      source: Object.keys(source.objects).length,
      restored: Object.keys(restored.objects).length,
      missing,
      changed,
      byKind,
    },
    rows: { live: liveRows, restored: restoredRows },
    sameMajor,
  };
}

/** Up to eight names, then "and N more". */
export function list(items: readonly string[], max = 8): string {
  const head = items.slice(0, max).join(", ");
  return items.length > max ? `${head} and ${items.length - max} more` : head;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
