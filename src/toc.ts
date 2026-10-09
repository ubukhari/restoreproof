/**
 * The archive's table of contents (`pg_restore -l`), and the list the restore follows
 * (`pg_restore -L`). The list leaves out:
 *
 * - extensions the copy does not have or must not run (src/scope.ts), with their comments;
 * - foreign-data wrappers, servers, user mappings and foreign tables: they point at other systems,
 *   and a backup holds none of their rows.
 *
 * Everything else restores as dumped, and fails the test if it cannot.
 */

export interface TocEntry {
  line: string;
  /** e.g. "TABLE", "TABLE DATA", "EXTENSION", "FK CONSTRAINT" */
  type: string;
  rest: string;
}

const FOREIGN = /^(FOREIGN DATA WRAPPER|SERVER|USER MAPPING|FOREIGN TABLE)\b/;
const TYPES = [
  "MATERIALIZED VIEW DATA",
  "FOREIGN DATA WRAPPER",
  "PUBLICATION TABLE",
  "PUBLICATION TABLES IN SCHEMA",
  "SEQUENCE OWNED BY",
  "DEFAULT ACL",
  "EVENT TRIGGER",
  "FK CONSTRAINT",
  "FOREIGN TABLE",
  "MATERIALIZED VIEW",
  "ROW SECURITY",
  "SEQUENCE SET",
  "TABLE ATTACH",
  "INDEX ATTACH",
  "TABLE DATA",
  "USER MAPPING",
  "BLOB METADATA",
  "LARGE OBJECTS",
];

export function parseToc(text: string): { header: string[]; entries: TocEntry[] } {
  const header: string[] = [];
  const entries: TocEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(";")) {
      header.push(line);
      continue;
    }
    const m = /^\d+; \d+ \d+ (.+)$/.exec(line);
    if (!m) continue;
    const rest = m[1]!;
    const type = TYPES.find((t) => rest.startsWith(t + " ")) ?? rest.slice(0, rest.indexOf(" "));
    entries.push({ line, type, rest: rest.slice(type.length + 1) });
  }
  return { header, entries };
}

/** "17.6" from the header's "Dumped from database version: 17.6 (…)". */
export function dumpedFrom(header: readonly string[]): string | null {
  for (const h of header) {
    const m = /Dumped from database version:\s*(\d+(?:\.\d+)?)/.exec(h);
    if (m) return m[1]!;
  }
  return null;
}

export interface Filtered {
  list: string;
  skippedExtensions: string[];
  skippedForeign: number;
  /** extensions the archive creates */
  extensions: string[];
}

/** The `-L` list without the entries named above. */
export function filterToc(text: string, skipExtension: (name: string) => boolean): Filtered {
  const { header, entries } = parseToc(text);
  const keep: string[] = [...header];
  const skippedExtensions: string[] = [];
  const extensions: string[] = [];
  let skippedForeign = 0;
  for (const e of entries) {
    if (e.type === "EXTENSION") {
      const name = e.rest.replace(/^- /, "").trim().split(" ")[0] ?? "";
      extensions.push(name);
      if (skipExtension(name)) {
        skippedExtensions.push(name);
        continue;
      }
    }
    if (e.type === "COMMENT") {
      // a name that needs quoting is quoted here ("uuid-ossp"), and not on the EXTENSION line
      const m = /^- EXTENSION (\S+)/.exec(e.rest);
      if (m && skipExtension(m[1]!.replace(/^"(.*)"$/, "$1").replace(/""/g, '"'))) continue;
    }
    if (FOREIGN.test(e.type)) {
      skippedForeign++;
      continue;
    }
    keep.push(e.line);
  }
  return { list: keep.join("\n") + "\n", skippedExtensions, skippedForeign, extensions };
}
