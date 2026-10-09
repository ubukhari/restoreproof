/**
 * The workflow `init` writes into a repository, and the header of the drill it vendors beside it.
 *
 * Every step is in the file, in plain shell, so the person adding it can read what will touch their
 * database before it ever runs. The only code that is not in the file is the drill, which `init`
 * copies into `.github/restoreproof/drill.mjs` at the version they ran: nothing is fetched from us
 * at backup time.
 *
 * Actions used, both GitHub's own, at majors that run on Node 24 (read 9 Oct 2026):
 * `actions/checkout@v7` and `actions/upload-artifact@v7`.
 */
import { usage } from "./errors.js";
import { INSTALL, REPO } from "./install.js";
import type { Provider } from "./url.js";
import { VERSION } from "./version.js";

export const WORKFLOW_PATH = ".github/workflows/restoreproof.yml";
export const DRILL_PATH = ".github/restoreproof/drill.mjs";
export const DEFAULT_CRON = "17 4 * * 1";
export const DEFAULT_KEEP_DAYS = 28;
export const DEFAULT_SECRET = "RESTOREPROOF_DATABASE_URL";

export interface WorkflowOptions {
  provider: Provider | "auto";
  cron: string;
  keepDays: number;
  /** the repository secret holding the database URL */
  secret: string;
}

/** Five cron fields, each of digits, `*`, `/`, `,` and `-` (GitHub's schedule syntax, no names). */
export function checkCron(cron: string): string {
  const c = cron.trim().replace(/\s+/g, " ");
  if (!/^([\d*/,-]+ ){4}[\d*/,-]+$/.test(c))
    throw usage(
      `--cron "${cron}" is not five cron fields`,
      'e.g. `--cron "17 4 * * 1"` (Mondays 04:17 UTC) or `--cron "17 4 * * *"` (daily)',
    );
  return c;
}

export function checkSecret(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name) || /^GITHUB_/i.test(name))
    throw usage(
      `--secret "${name}" is not a repository secret name`,
      "Use letters, digits and underscores, not starting with GITHUB_, e.g. SUPABASE_DB_URL.",
    );
  return name;
}

export function checkKeepDays(raw: string | number): number {
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1 || v > 400)
    throw usage(
      `--keep-days takes 1 to 400 days, got "${raw}"`,
      "GitHub keeps artifacts 1 to 90 days in a public repository and up to 400 in a private one.",
    );
  return v;
}

/** What the cron means in words, for the comment beside it. */
export function describeCron(cron: string): string {
  if (cron === DEFAULT_CRON) return "Mondays 04:17 UTC";
  const [min, hour, dom, mon, dow] = cron.split(" ");
  if (
    /^\d+$/.test(min ?? "") &&
    /^\d+$/.test(hour ?? "") &&
    dom === "*" &&
    mon === "*" &&
    dow === "*"
  )
    return `daily at ${hour!.padStart(2, "0")}:${min!.padStart(2, "0")} UTC`;
  return "UTC";
}

/** The connection string to use, by provider: the one line most first runs fail on. */
export const WHICH_URL: Record<Provider | "auto", string[]> = {
  supabase: [
    "Supabase: the Session pooler string (Connect > Session pooler: *.pooler.supabase.com, port",
    "5432). The direct db.<ref>.supabase.co host is IPv6 only, and GitHub's runners have no IPv6;",
    "port 6543 is the transaction pooler, which cannot take a whole-database dump.",
  ],
  neon: [
    'Neon: the direct connection string, with no "-pooler" in the host (Connect > Connection',
    "pooling off). Neon says to avoid pg_dump over a pooled connection.",
  ],
  postgres: ["Any postgres:// URL this runner can reach, for a role that can read every table."],
  auto: [
    "Supabase: the Session pooler string (Connect > Session pooler, port 5432); the direct",
    "  db.<ref>.supabase.co host is IPv6 only, and GitHub's runners have no IPv6.",
    'Neon: the direct string, with no "-pooler" in the host.',
    "Others: any postgres:// URL this runner can reach, for a role that can read every table.",
  ],
};

export function renderWorkflow(o: WorkflowOptions): string {
  const which = WHICH_URL[o.provider].map((l) => `#   ${l}`).join("\n");
  const secretNote =
    o.secret === DEFAULT_SECRET
      ? `# Setup, once: add the repository secret ${DEFAULT_SECRET} (Settings > Secrets and variables >\n# Actions, or \`gh secret set ${DEFAULT_SECRET}\`), holding the database's connection string:`
      : `# Setup, once: the repository secret ${o.secret} holds the database's connection string:`;
  return `# restoreproof ${VERSION}: a backup of this project's Postgres database, restored into a throwaway
# copy and checked table by table, every time it runs. ${REPO}
#
${secretNote}
${which}
#
# Optional secrets:
#   RESTOREPROOF_PASSPHRASE   encrypts the backup (gpg, AES-256) before it is stored. Required in a
#                             public repository, where anyone can download a run's artifacts.
#   RESTOREPROOF_S3_URL       s3://bucket/prefix: also copy each backup to your own S3, R2, B2 or
#                             MinIO bucket, with RESTOREPROOF_S3_ACCESS_KEY_ID,
#                             RESTOREPROOF_S3_SECRET_ACCESS_KEY, and for R2, B2 or MinIO,
#                             RESTOREPROOF_S3_ENDPOINT (and RESTOREPROOF_S3_REGION if it needs one).
#
# What runs: the steps below and .github/restoreproof/drill.mjs, copied here by
# \`${INSTALL} init\`. Nothing is fetched from agentwares and nothing is sent to it: the backup
# stays in this repository's artifacts (${o.keepDays} days) and, if you add one, your bucket.
name: restoreproof

on:
  schedule:
    - cron: "${o.cron}" # ${describeCron(o.cron)}; GitHub may start it late, or drop it under load
  workflow_dispatch:

permissions:
  contents: read
  actions: read

concurrency:
  group: restoreproof
  cancel-in-progress: false

jobs:
  restore-test:
    name: Back up, restore and compare
    runs-on: ubuntu-24.04
    timeout-minutes: 120
    defaults:
      run:
        shell: bash
    env:
      RESTOREPROOF_DATABASE_URL: \${{ secrets.${o.secret} }}
      RESTOREPROOF_PROVIDER: ${o.provider} # auto, supabase, neon or postgres
      RESTOREPROOF_MAX_ROW_DRIFT: "10" # % a table's restored rows may differ from its live count
      RESTOREPROOF_MAX_SHRINK: "50" # % fewer live rows than at the last good run that fails the test
      RESTOREPROOF_EXCLUDE_SCHEMAS: "" # schemas to leave out of the backup, comma-separated
      RESTOREPROOF_S3_URL: \${{ secrets.RESTOREPROOF_S3_URL }}
    steps:
      - name: Check out the drill
        uses: actions/checkout@v7
        with:
          sparse-checkout: .github/restoreproof
          persist-credentials: false

      - name: Read the last good run's facts and the repository's visibility
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          echo "RESTOREPROOF_VISIBILITY=$(gh repo view "$GITHUB_REPOSITORY" --json visibility --jq .visibility || echo UNKNOWN)" >> "$GITHUB_ENV"
          workflow=$(basename "\${GITHUB_WORKFLOW_REF%%@*}")
          run=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$workflow" --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty' || true)
          if [ -n "$run" ]; then
            gh run download "$run" --repo "$GITHUB_REPOSITORY" --name restoreproof-facts --dir "$RUNNER_TEMP/previous" || echo "Run $run kept no facts."
          else
            echo "No earlier successful run: nothing to compare with yet."
          fi

      - name: Read the database's PostgreSQL version
        id: probe
        run: node .github/restoreproof/drill.mjs probe

      - name: Install PostgreSQL \${{ steps.probe.outputs.major }} from the PostgreSQL apt repository
        env:
          PACKAGES: \${{ steps.probe.outputs.packages }}
        run: |
          sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
          sudo apt-get install -y --no-install-recommends $PACKAGES

      - name: Back up, restore into a throwaway copy, compare
        id: drill
        env:
          RESTOREPROOF_PG_BIN: /usr/lib/postgresql/\${{ steps.probe.outputs.major }}/bin
          RESTOREPROOF_PREVIOUS: \${{ runner.temp }}/previous/facts.json
          RESTOREPROOF_OUT: \${{ runner.temp }}/restoreproof
        run: node .github/restoreproof/drill.mjs drill

      - name: Encrypt the backup, or refuse to publish it
        id: seal
        if: \${{ !cancelled() && steps.drill.outputs.backup != '' }}
        env:
          BACKUP: \${{ steps.drill.outputs.backup }}
          RESTOREPROOF_PASSPHRASE: \${{ secrets.RESTOREPROOF_PASSPHRASE }}
        run: |
          file="$BACKUP"
          if [ -n "$RESTOREPROOF_PASSPHRASE" ]; then
            gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --symmetric --cipher-algo AES256 --output "$BACKUP.gpg" "$BACKUP" <<< "$RESTOREPROOF_PASSPHRASE"
            rm -f "$BACKUP"
            file="$BACKUP.gpg"
            echo "Encrypted. To read it: gpg --decrypt --output backup.dump $(basename "$file")"
          fi
          echo "file=$file" >> "$GITHUB_OUTPUT"
          if [ -n "$RESTOREPROOF_PASSPHRASE" ] || [ "$RESTOREPROOF_VISIBILITY" = "PRIVATE" ] || [ "$RESTOREPROOF_VISIBILITY" = "INTERNAL" ]; then
            echo "artifact=true" >> "$GITHUB_OUTPUT"
          elif [ -n "$RESTOREPROOF_S3_URL" ]; then
            echo "This repository is $RESTOREPROOF_VISIBILITY: the unencrypted backup goes to your bucket only, not to the run's artifacts."
          else
            echo "::error title=restoreproof::This repository is $RESTOREPROOF_VISIBILITY, and anyone who can read it can download a run's artifacts. Add the RESTOREPROOF_PASSPHRASE secret to encrypt the backup, or a bucket (RESTOREPROOF_S3_URL)."
            exit 1
          fi

      - name: Keep the backup as an artifact
        if: \${{ !cancelled() && steps.seal.outputs.artifact == 'true' }}
        uses: actions/upload-artifact@v7
        with:
          name: restoreproof-backup-\${{ github.run_number }}
          path: \${{ steps.seal.outputs.file }}
          retention-days: ${o.keepDays}
          compression-level: 0
          if-no-files-found: error

      - name: Copy the backup to your bucket
        if: \${{ !cancelled() && steps.seal.outputs.file != '' && env.RESTOREPROOF_S3_URL != '' }}
        env:
          FILE: \${{ steps.seal.outputs.file }}
          S3_ENDPOINT: \${{ secrets.RESTOREPROOF_S3_ENDPOINT }}
          AWS_ACCESS_KEY_ID: \${{ secrets.RESTOREPROOF_S3_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.RESTOREPROOF_S3_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: \${{ secrets.RESTOREPROOF_S3_REGION || (secrets.RESTOREPROOF_S3_ENDPOINT && 'auto') || 'us-east-1' }}
          AWS_REQUEST_CHECKSUM_CALCULATION: when_required
          AWS_RESPONSE_CHECKSUM_VALIDATION: when_required
        run: |
          key="\${RESTOREPROOF_S3_URL%/}/$(date -u +%Y%m%dT%H%MZ)-run$GITHUB_RUN_NUMBER-$(basename "$FILE")"
          args=()
          if [ -n "$S3_ENDPOINT" ]; then args+=(--endpoint-url "$S3_ENDPOINT"); fi
          aws s3 cp "\${args[@]}" --only-show-errors "$FILE" "$key"
          echo "Copied the backup to your bucket."

      - name: Keep the facts (counts and hashes, no data)
        if: \${{ !cancelled() && steps.drill.outputs.facts != '' }}
        uses: actions/upload-artifact@v7
        with:
          name: restoreproof-facts
          path: \${{ steps.drill.outputs.facts }}
          retention-days: 90
          if-no-files-found: ignore
`;
}

/** The comment the vendored drill starts with. */
export function drillHeader(): string {
  return [
    `// restoreproof ${VERSION}: the drill .github/workflows/restoreproof.yml runs.`,
    `// Generated from ${REPO} (MIT). It reads your database with pg_dump and psql,`,
    "// restores the backup into a throwaway PostgreSQL on the runner, compares the two, and sends",
    "// nothing anywhere. No dependencies. To update it, run `" + INSTALL + " init --force`.",
    "",
  ].join("\n");
}
