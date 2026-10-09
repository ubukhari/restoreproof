/**
 * The drill alone: what `init` copies into a repository as `.github/restoreproof/drill.mjs`, and
 * what `.github/workflows/restoreproof.yml` runs.
 *
 *   node .github/restoreproof/drill.mjs probe   read the server's version; say what to install
 *   node .github/restoreproof/drill.mjs drill   back up, restore into a throwaway copy, compare
 *
 * Settings come from the workflow's environment (RESTOREPROOF_*). It needs only Node.js and
 * PostgreSQL's own programs, and sends nothing anywhere.
 */
import { drillCommand, probeCommand } from "./ci.js";
import { VERSION } from "./version.js";

const deps = {
  env: process.env,
  stdout: (s: string) => void process.stdout.write(s),
  stderr: (s: string) => void process.stderr.write(s),
};

const command = process.argv[2];
const done = (code: number) => {
  process.exitCode = code;
};
if (command === "probe") probeCommand(deps).then(done, crash);
else if (command === "drill") drillCommand(deps).then(done, crash);
else if (command === "--version") process.stdout.write(`${VERSION}\n`);
else {
  process.stderr.write(`restoreproof drill ${VERSION}: usage: node drill.mjs probe | drill\n`);
  process.exitCode = 2;
}

function crash(err: unknown): void {
  process.stderr.write(
    `restoreproof: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
}
