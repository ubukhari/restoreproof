#!/usr/bin/env node
/**
 * The self-test's first check (.github/workflows/selftest.yml): that the run is the workflow `init`
 * writes and the drill it vendors, not a hand-made variant of them. The job runs `init` into an
 * empty repository first, then:
 *
 *   node scripts/selftest.mjs <the repository init wrote into> <this repository>
 *
 * It exits 1, naming the first line that differs, when this repository's selftest.yml is not what
 * src/selftest.ts makes of init's workflow, or its .github/restoreproof/drill.mjs is not init's.
 */
import { checkSelftest } from "../dist/index.js";

const [customer, repo] = process.argv.slice(2);
if (!customer || !repo) {
  console.error("usage: node scripts/selftest.mjs <dir init wrote into> <this repository>");
  process.exit(2);
}
const result = checkSelftest(customer, repo);
for (const line of result.lines) console.log(line);
process.exitCode = result.ok ? 0 : 1;
