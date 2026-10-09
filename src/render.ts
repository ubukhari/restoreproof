/**
 * The drill's result, for a terminal, for a GitHub step summary, and as the facts file the next
 * run compares with. With `redact` (a public repository, whose run summaries and artifacts anyone
 * can read) nothing names a table or gives a per-table count: totals and verdicts only.
 */
import { bytes, hashName, type Finding, type Previous, type TableCheck } from "./compare.js";
import type { DrillResult } from "./drill.js";
import type { Problem } from "./errors.js";
import { HANDOFF_DETAIL, HANDOFF_LINE, HANDOFF_URL } from "./handoff.js";

const n = (v: number) => v.toLocaleString("en-US");
const s = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

export interface RenderOptions {
  redact?: boolean;
  /** check mode: whether the backup file was kept, and where */
  kept?: string | null;
}

function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function verdictWord(r: DrillResult): string {
  return r.ok ? "PASSED" : "FAILED";
}

function findingText(f: Finding, redact: boolean): string {
  return redact ? f.summary : f.message;
}

/** The object counts by kind, e.g. "12 tables, 54 columns, 3 policies". */
export function kinds(byKind: Record<string, number>): string {
  const order = [
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
  ];
  const plural: Record<string, string> = {
    index: "indexes",
    matview: "materialized views",
    policy: "policies",
  };
  return order
    .filter((k) => byKind[k])
    .map((k) => {
      const v = byKind[k]!;
      const name = k === "matview" ? "materialized view" : k;
      return `${n(v)} ${v === 1 ? name : (plural[k] ?? `${name}s`)}`;
    })
    .join(", ");
}

/** Tables to show: every one up to 40; beyond that, all that did not match plus the 20 largest. */
export function tablesToShow(tables: readonly TableCheck[]): {
  rows: TableCheck[];
  hidden: number;
} {
  if (tables.length <= 40) return { rows: [...tables], hidden: 0 };
  const off = tables.filter((t) => t.verdict !== "match");
  const big = [...tables]
    .filter((t) => t.verdict === "match")
    .sort((a, b) => b.live - a.live)
    .slice(0, 20);
  const rows = [...off, ...big].sort((a, b) => a.table.localeCompare(b.table));
  return { rows, hidden: tables.length - rows.length };
}

const VERDICT: Record<TableCheck["verdict"], string> = {
  match: "",
  changed: "changed during the backup",
  differs: "DIFFERS",
  empty: "RESTORED EMPTY",
  missing: "MISSING",
};

export function renderText(r: DrillResult, opts: RenderOptions = {}): string {
  const redact = !!opts.redact;
  const out: string[] = [];
  out.push(`restoreproof ${r.version} · restore test ${verdictWord(r)} · ${when(r.at)}`, "");
  if (r.source)
    out.push(
      `  source    PostgreSQL ${r.source.version}${r.provider ? ` (${r.provider})` : ""}, ${bytes(r.source.bytes)}${r.variable ? `, read through ${r.variable}` : ""}`,
    );
  if (r.backup)
    out.push(
      r.mode === "live"
        ? `  backup    ${bytes(r.backup.bytes)} in ${r.backup.seconds} s (${r.backup.tool}, custom format)`
        : `  backup    ${r.backup.tool}${r.backup.bytes ? `, ${bytes(r.backup.bytes)}` : ""}`,
    );
  out.push(
    `  restored  ${r.restore.ok ? `in ${r.restore.seconds} s` : "FAILED"} into ${r.restore.into}`,
  );
  const c = r.comparison;
  if (c) {
    out.push(
      `  checked   ${s(c.rows.live, "row")} in ${s(c.tables.length, "table")} against the live database${c.ok ? ": all match" : ""}`,
    );
    out.push(
      ...hang(
        `${s(c.objects.source, "schema object")}: ${kinds(c.objects.byKind)}`,
        "            ",
      ),
    );
  }
  if (r.restored)
    out.push(
      `  restored  ${s(r.restored.tables, "table")} and ${s(r.restored.rows, "row")} came back`,
    );
  if (r.previous) out.push(`  compared  with the last good run, ${r.previous.at.slice(0, 10)}`);

  if (c && !redact && c.tables.length) {
    const { rows, hidden } = tablesToShow(c.tables);
    const w = Math.min(48, Math.max(...rows.map((t) => t.table.length), 5));
    const lw = Math.max(...rows.map((t) => n(t.live).length), 4);
    out.push("", `  ${"table".padEnd(w)}  ${"live".padStart(lw)} → restored`);
    for (const t of rows)
      out.push(
        `  ${t.table.padEnd(w)}  ${n(t.live).padStart(lw)} → ${t.restored === null ? "—" : n(t.restored)}${VERDICT[t.verdict] ? `  ${VERDICT[t.verdict]}` : ""}`,
      );
    if (hidden) out.push(`  … and ${s(hidden, "more table")} that match`);
  }
  if (r.restored && !redact && r.restored.tables) {
    const names = Object.keys(r.restored.rowsByTable).sort();
    const w = Math.min(48, Math.max(...names.map((t) => t.length), 5));
    out.push("", `  ${"table".padEnd(w)}  restored rows`);
    for (const t of names.slice(0, 40))
      out.push(`  ${t.padEnd(w)}  ${n(r.restored.rowsByTable[t]!)}`);
    if (names.length > 40) out.push(`  … and ${s(names.length - 40, "more table")}`);
  }

  const groups: [Finding["level"], string][] = [
    ["fail", "FAILED"],
    ["warn", "warnings"],
    ["note", "notes"],
  ];
  for (const [level, title] of groups) {
    const fs = r.findings.filter((f) => f.level === level);
    if (!fs.length) continue;
    out.push("", `  ${title}`);
    for (const f of fs)
      for (const [i, para] of findingText(f, redact).split("\n").entries())
        out.push(...hang(para, i === 0 ? "    - " : "      ", "      "));
  }
  if (opts.kept !== undefined && r.mode === "live")
    out.push(
      "",
      opts.kept
        ? `  The backup is kept at ${opts.kept}.`
        : "  The backup was deleted; pass --out <dir> to keep it.",
    );
  out.push("", HANDOFF_LINE, wrap(HANDOFF_DETAIL), HANDOFF_URL, "");
  return out.join("\n");
}

/** Words wrapped at `width`: the first line after `first`, the others after `rest`. */
function hang(text: string, first: string, rest = first, width = 100): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const w of text.split(" ")) {
    if (!empty && line.length + 1 + w.length > width) {
      lines.push(line);
      line = rest + w;
    } else line = empty ? line + w : `${line} ${w}`;
    empty = false;
  }
  lines.push(line);
  return lines;
}

function wrap(text: string, width = 100): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

const md = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, "<br>");

/** The GitHub step summary. */
export function renderMarkdown(r: DrillResult, opts: RenderOptions = {}): string {
  const redact = !!opts.redact;
  const out: string[] = [];
  out.push(`## restoreproof: the restore test ${r.ok ? "passed" : "FAILED"}`, "");
  out.push("| | |", "| --- | --- |");
  if (r.source)
    out.push(
      `| Source | PostgreSQL ${r.source.version}${r.provider ? ` (${r.provider})` : ""}, ${bytes(r.source.bytes)} |`,
    );
  if (r.backup)
    out.push(
      `| Backup | ${bytes(r.backup.bytes)} in ${r.backup.seconds} s, ${r.backup.tool}, custom format |`,
    );
  out.push(
    `| Restored | ${r.restore.ok ? `in ${r.restore.seconds} s` : "**failed**"} into ${r.restore.into} |`,
  );
  const c = r.comparison;
  if (c) {
    out.push(
      `| Tables and rows | ${s(c.tables.length, "table")}, ${s(c.rows.live, "row")} live, ${s(c.rows.restored, "row")} restored |`,
    );
    out.push(
      `| Schema objects | ${s(c.objects.source, "object")}: ${kinds(c.objects.byKind)}; ${c.objects.missing} missing, ${c.objects.changed} changed |`,
    );
  }
  if (r.previous) out.push(`| Compared with | the last good run, ${r.previous.at.slice(0, 10)} |`);
  out.push(`| Run | ${when(r.at)}, restoreproof ${r.version} |`);
  for (const [level, title] of [
    ["fail", "Failed"],
    ["warn", "Warnings"],
    ["note", "Notes"],
  ] as const) {
    const fs = r.findings.filter((f) => f.level === level);
    if (!fs.length) continue;
    out.push("", `### ${title}`, "");
    for (const f of fs)
      out.push(
        `- ${level === "fail" ? "**" : ""}${md(findingText(f, redact))}${level === "fail" ? "**" : ""}`,
      );
  }
  if (c && !redact && c.tables.length) {
    const { rows, hidden } = tablesToShow(c.tables);
    out.push(
      "",
      "### Rows by table",
      "",
      "| Table | Live | Restored | |",
      "| --- | ---: | ---: | --- |",
    );
    for (const t of rows)
      out.push(
        `| ${md(t.table)} | ${n(t.live)} | ${t.restored === null ? "—" : n(t.restored)} | ${VERDICT[t.verdict]} |`,
      );
    if (hidden) out.push("", `${s(hidden, "more table")} match and are not listed.`);
  }
  if (redact)
    out.push(
      "",
      "This repository is public, so this summary names no table and gives no per-table count. Run `restoreproof check` where you keep the database URL to see them.",
    );
  out.push(
    "",
    "---",
    "",
    `${HANDOFF_LINE} ${HANDOFF_DETAIL} [I would pay for it](${HANDOFF_URL})`,
    "",
  );
  return out.join("\n");
}

export function renderJson(r: DrillResult): string {
  return JSON.stringify(r, null, 2) + "\n";
}

export { hashName };

export function renderError(p: Problem, json: boolean): string {
  if (json) return JSON.stringify({ error: p }, null, 2) + "\n";
  return `restoreproof: ${p.code}\n  ${p.cause.split("\n").join("\n  ")}\n  fix: ${p.fix}\n`;
}

export interface FactsFile {
  tool: "restoreproof";
  version: string;
  at: string;
  ok: boolean;
  provider: string | null;
  redacted: boolean;
  source: { version: string; bytes: number } | null;
  backupBytes: number;
  rows: number;
  /** table names, or their hashes when redacted */
  tables: string[];
  /** per-table live counts, only when not redacted */
  rowsByTable?: Record<string, number>;
}

/** What the next run compares with: counts and names (or hashes), never data. */
export function factsFile(r: DrillResult, redact: boolean): FactsFile {
  const c = r.comparison;
  const names = c ? c.tables.map((t) => t.table) : [];
  return {
    tool: "restoreproof",
    version: r.version,
    at: r.at,
    ok: r.ok,
    provider: r.provider,
    redacted: redact,
    source: r.source ? { version: r.source.version, bytes: r.source.bytes } : null,
    backupBytes: r.backup?.bytes ?? 0,
    rows: c?.rows.live ?? 0,
    tables: redact ? names.map(hashName) : names,
    ...(redact || !c
      ? {}
      : { rowsByTable: Object.fromEntries(c.tables.map((t) => [t.table, t.live])) }),
  };
}

/**
 * The last good run's facts, as compare() takes them. When that run was redacted, its table names
 * are hashes, compared as hashes, and a gone table is reported without its name.
 */
export function previousFrom(text: string): Previous | null {
  let f: Partial<FactsFile>;
  try {
    f = JSON.parse(text) as Partial<FactsFile>;
  } catch {
    return null;
  }
  if (
    f.tool !== "restoreproof" ||
    typeof f.at !== "string" ||
    typeof f.rows !== "number" ||
    !Array.isArray(f.tables)
  )
    return null;
  return {
    at: f.at,
    rows: f.rows,
    tables: f.tables.filter((t): t is string => typeof t === "string"),
    backupBytes: typeof f.backupBytes === "number" ? f.backupBytes : 0,
    tablesHashed: !!f.redacted,
  };
}
