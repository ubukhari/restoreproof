/**
 * restoreproof's self-test: `.github/workflows/selftest.yml` in the public repo, run on GitHub's own
 * runners, weekly and on demand. It is generated here from the workflow `init` writes, so what runs
 * there is what a customer commits, with one declared change: every `secrets.NAME` init's workflow
 * reads becomes a test value written in the file (SELFTEST_VALUES). The "database" is a throwaway
 * postgres service container loaded with examples/synthetic-source.sql, and the "bucket" an S3 mock
 * beside it; none of the values is a secret.
 *
 * Three jobs:
 *
 * - `restore-test`: init's job, every line. Before init's steps it checks this repository out beside
 *   the workspace and runs `init`, failing unless this file is what renderSelftest makes of the
 *   workflow init wrote and the committed `.github/restoreproof/drill.mjs` is the drill init wrote
 *   (checkSelftest, through scripts/selftest.mjs); then it loads the source and makes the bucket.
 *   After init's steps it decrypts the backup, lists it with pg_restore, reads it back from the
 *   bucket, and checks that the last good run's facts were fetched when there was one.
 * - `fetch-backup`: fetches the encrypted artifact with `gh run download`, checks it is the file the
 *   first job sealed, and decrypts it with the passphrase.
 * - `restore-fails`: init's checkout, probe and install steps, then the drill with an extension the
 *   source uses withheld from the copy. It passes only when the drill exits 1 and reports
 *   RESTORE_FAILED, as a failing run reports it.
 *
 * The sync (scripts/sync-oss-repos.sh) commits the drill init writes at `.github/restoreproof/` in the
 * public repo, since init's first step checks that directory out.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DRILL_PATH, WORKFLOW_PATH } from "./workflow.js";

export const SELFTEST_PATH = ".github/workflows/selftest.yml";
export const SELFTEST_CRON = "41 5 * * 2";

const SOURCE_IMAGE = "postgres:17";
const S3_IMAGE = "motoserver/moto:5.2.3";
const SOURCE_PORT = 15432;
const S3_PORT = 15000;
const BUCKET = "restoreproof-selftest";
const S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`;
const PASSPHRASE = "selftest-passphrase-not-a-secret";
const ACCESS_KEY_ID = "selftest-access-key-id";
const SECRET_ACCESS_KEY = "selftest-secret-access-key";

/** The extension the failure job withholds: auth.users in the synthetic source defaults to its function. */
export const SELFTEST_WITHHELD = "uuid-ossp";

/**
 * What stands in for each secret init's workflow reads. The URL is the service container's, the
 * passphrase and keys are written here in the open, and the region is left empty so that the
 * bucket step takes the R2 and MinIO path (`auto`).
 */
export const SELFTEST_VALUES: Readonly<Record<string, string>> = {
  RESTOREPROOF_DATABASE_URL: `postgresql://postgres:selftest@127.0.0.1:${SOURCE_PORT}/source?sslmode=disable`,
  RESTOREPROOF_PASSPHRASE: PASSPHRASE,
  RESTOREPROOF_S3_URL: `s3://${BUCKET}/backups`,
  RESTOREPROOF_S3_ENDPOINT: S3_ENDPOINT,
  RESTOREPROOF_S3_ACCESS_KEY_ID: ACCESS_KEY_ID,
  RESTOREPROOF_S3_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
  RESTOREPROOF_S3_REGION: "",
};

/** The one change made to init's lines: `secrets.NAME` becomes the quoted test value. */
export function withTestValues(text: string): string {
  return text.replace(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const value = Object.hasOwn(SELFTEST_VALUES, name) ? SELFTEST_VALUES[name] : undefined;
    if (value === undefined)
      throw new Error(
        `the workflow reads secrets.${name}, which the self-test has no test value for; add one to SELFTEST_VALUES`,
      );
    return `'${value}'`;
  });
}

export interface InitParts {
  /** the job's own keys, `name:` to the end of `env:`, without `steps:` */
  head: string;
  /** `defaults:` and `env:` */
  settings: string;
  /** each step, ending in a newline */
  steps: string[];
}

const JOB = "\n  restore-test:\n";
const STEPS = "\n    steps:\n";

/** init's job, cut where the self-test adds to it. Throws when its layout is not the one expected. */
export function initParts(init: string): InitParts {
  const at = init.indexOf(JOB);
  const job = init.slice(at + JOB.length);
  const s = job.indexOf(STEPS);
  const d = job.indexOf("\n    defaults:\n");
  if (at < 0 || s < 0 || d < 0 || d > s || !job.startsWith("    name: "))
    throw new Error(
      "init's workflow is not laid out as the self-test expects: one restore-test job",
    );
  const steps = job
    .slice(s + STEPS.length)
    .trimEnd()
    .split(/\n\n(?= {6}- )/)
    .map((x) => x + "\n");
  if (!steps.every((x) => x.startsWith("      - name: ")))
    throw new Error(
      "init's steps are not laid out as the self-test expects: each starts `- name:`",
    );
  return { head: job.slice(0, s + 1), settings: job.slice(d + 1, s + 1), steps };
}

function step(steps: readonly string[], name: string): string {
  const found = steps.find((x) => x.startsWith(`      - name: ${name}`));
  if (!found) throw new Error(`init's workflow has no step "${name}"`);
  return found;
}

const HEADER = `# restoreproof's self-test, on GitHub's own runners: the workflow \`restoreproof init\` writes, run
# against a synthetic database, weekly and on demand.
#
# Generated by src/selftest.ts from the workflow init writes, so do not edit it here: its first
# check fails when this file is not what init writes today. The only change to init's lines is that
# each \`secrets.NAME\` is a test value written in the open, since the database is a throwaway
# ${SOURCE_IMAGE} service container loaded with examples/synthetic-source.sql (shaped like a small
# Supabase project; no one's data) and the bucket an S3 mock (${S3_IMAGE}) beside it.
# None of them is a secret. Besides GitHub it reaches Docker Hub for the two images, and apt for
# PostgreSQL, as init's workflow does.
#
#   restore-test   init's job: probe, install the server's major, back up, restore into a
#                  throwaway copy, compare, encrypt, keep the artifact, copy it to the bucket,
#                  keep the facts. Then read the backup back, decrypted, and from the bucket.
#   fetch-backup   gh run download the encrypted artifact, check it, decrypt it
#   restore-fails  the same source with ${SELFTEST_WITHHELD} withheld from the copy: passes only when
#                  the drill exits 1 and reports RESTORE_FAILED, as a failing run does
name: selftest

on:
  schedule:
    - cron: "${SELFTEST_CRON}" # Tuesdays 05:41 UTC
  workflow_dispatch:

permissions:
  contents: read
  actions: read

concurrency:
  group: selftest
  cancel-in-progress: false

jobs:
`;

const SOURCE_SERVICE = `      source:
        image: ${SOURCE_IMAGE}
        env:
          POSTGRES_PASSWORD: selftest
          POSTGRES_DB: source
        ports:
          - "${SOURCE_PORT}:5432"
        options: >-
          --health-cmd "pg_isready -U postgres -d source" --health-interval 5s --health-timeout 5s
          --health-retries 30
`;

const S3_SERVICE = `      s3:
        image: ${S3_IMAGE}
        ports:
          - "${S3_PORT}:5000"
`;

const S3_ENV = `          AWS_ACCESS_KEY_ID: ${ACCESS_KEY_ID}
          AWS_SECRET_ACCESS_KEY: ${SECRET_ACCESS_KEY}
          AWS_DEFAULT_REGION: us-east-1
`;

const CHECKOUT = `      - name: "Self-test: check out this repository beside the workspace"
        uses: actions/checkout@v7
        with:
          path: selftest
          persist-credentials: false
`;

const SEED = `      - name: "Self-test: load the synthetic database into the source"
        env:
          SOURCE: \${{ job.services.source.id }}
        run: |
          docker exec -i "$SOURCE" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d source < selftest/examples/synthetic-source.sql
          echo "Loaded examples/synthetic-source.sql into a ${SOURCE_IMAGE} service container."
`;

const PRELUDE = [
  CHECKOUT,
  `      - name: "Self-test: this file is what init writes, and so is the drill"
        run: |
          git init -q "$RUNNER_TEMP/customer"
          node selftest/dist/cli.js init "$RUNNER_TEMP/customer"
          node selftest/scripts/selftest.mjs "$RUNNER_TEMP/customer" selftest
`,
  SEED,
  `      - name: "Self-test: make the bucket"
        env:
${S3_ENV}        run: |
          for i in $(seq 1 30); do
            if aws --endpoint-url ${S3_ENDPOINT} s3 mb s3://${BUCKET}; then exit 0; fi
            sleep 2
          done
          exit 1
`,
];

const EPILOGUE = [
  `      - name: "Self-test: the backup decrypts to an archive of every table, and the bucket has it"
        id: readback
        env:
          FILE: \${{ steps.seal.outputs.file }}
          TABLES: \${{ steps.drill.outputs.tables }}
          PG_BIN: /usr/lib/postgresql/\${{ steps.probe.outputs.major }}/bin
          PASSPHRASE: ${PASSPHRASE}
${S3_ENV}        run: |
          case "$FILE" in *.gpg) ;; *) echo "::error title=selftest::the backup was not encrypted: $FILE"; exit 1 ;; esac
          gpg --batch --pinentry-mode loopback --passphrase-fd 0 --decrypt --output "$RUNNER_TEMP/readback.dump" "$FILE" <<< "$PASSPHRASE"
          data=$("$PG_BIN/pg_restore" --list "$RUNNER_TEMP/readback.dump" | grep -c " TABLE DATA ")
          echo "Decrypted: a pg_dump archive with the data of $data tables; the drill compared $TABLES."
          if [ "$data" != "$TABLES" ]; then echo "::error title=selftest::the archive holds $data tables' data, the drill compared $TABLES"; exit 1; fi
          aws --endpoint-url ${S3_ENDPOINT} s3 cp --recursive --only-show-errors s3://${BUCKET}/backups/ "$RUNNER_TEMP/bucket"
          copies=("$RUNNER_TEMP"/bucket/*)
          if [ "\${#copies[@]}" != 1 ]; then echo "::error title=selftest::the bucket holds \${#copies[@]} files, not one backup"; exit 1; fi
          echo "In the bucket: $(basename "\${copies[0]}")"
          cmp "\${copies[0]}" "$FILE"
          echo "sha256=$(sha256sum "$FILE" | cut -d " " -f 1)" >> "$GITHUB_OUTPUT"
          {
            echo "### Self-test"
            echo
            echo "- The backup decrypts with the passphrase to a pg_dump archive holding the data of $data tables, every table the drill compared."
            echo "- The bucket holds the same encrypted file, byte for byte."
          } >> "$GITHUB_STEP_SUMMARY"
`,
  `      - name: "Self-test: the last good run's facts were fetched, when there was one"
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          workflow=$(basename "\${GITHUB_WORKFLOW_REF%%@*}")
          run=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$workflow" --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')
          if [ -z "$run" ]; then
            line="No earlier good run of $workflow, so these facts are the first: the next run fetches them with gh run download."
          elif [ -s "$RUNNER_TEMP/previous/facts.json" ]; then
            line="The facts of run $run, the last good one, were fetched with gh run download and compared."
          else
            echo "::error title=selftest::run $run passed, but its facts were not fetched"
            exit 1
          fi
          echo "$line"
          echo "- $line" >> "$GITHUB_STEP_SUMMARY"
`,
];

const FETCH = `  fetch-backup:
    name: Fetch the backup with gh run download, and decrypt it
    needs: restore-test
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    defaults:
      run:
        shell: bash
    steps:
      - name: "Self-test: fetch, check and decrypt the encrypted backup"
        env:
          GH_TOKEN: \${{ github.token }}
          SHA256: \${{ needs.restore-test.outputs.sealed_sha256 }}
          PASSPHRASE: ${PASSPHRASE}
        run: |
          gh run download "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" --name "restoreproof-backup-$GITHUB_RUN_NUMBER" --dir "$RUNNER_TEMP/backup"
          file=$(ls "$RUNNER_TEMP"/backup/*.gpg)
          got=$(sha256sum "$file" | cut -d " " -f 1)
          if [ "$got" != "$SHA256" ]; then echo "::error title=selftest::$file has sha256 $got; the first job sealed $SHA256"; exit 1; fi
          gpg --batch --pinentry-mode loopback --passphrase-fd 0 --decrypt --output "$RUNNER_TEMP/backup.dump" "$file" <<< "$PASSPHRASE"
          if [ "$(head -c 5 "$RUNNER_TEMP/backup.dump")" != PGDMP ]; then echo "::error title=selftest::the decrypted file is not a pg_dump archive"; exit 1; fi
          line="The artifact restoreproof-backup-$GITHUB_RUN_NUMBER came back through gh run download as the file the first job sealed, and decrypts to a pg_dump archive."
          echo "$line"
          echo "- $line" >> "$GITHUB_STEP_SUMMARY"
`;

function failureStep(): string {
  return `      - name: "Self-test: with ${SELFTEST_WITHHELD} withheld from the copy, the drill fails with RESTORE_FAILED"
        env:
          RESTOREPROOF_SKIP_EXTENSIONS: ${SELFTEST_WITHHELD}
          RESTOREPROOF_PG_BIN: /usr/lib/postgresql/\${{ steps.probe.outputs.major }}/bin
          RESTOREPROOF_OUT: \${{ runner.temp }}/restoreproof
        run: |
          got="$RUNNER_TEMP/expected-failure"
          mkdir -p "$got"
          touch "$got/output" "$got/summary.md"
          code=0
          GITHUB_OUTPUT="$got/output" GITHUB_STEP_SUMMARY="$got/summary.md" node .github/restoreproof/drill.mjs drill > "$got/stdout" 2> "$got/stderr" || code=$?
          # what the drill printed, shown with GitHub's commands off: its ::error is expected here
          token="selftest-$RANDOM$RANDOM"
          echo "::stop-commands::$token"
          cat "$got/stdout" "$got/stderr"
          echo "::$token::"
          fail() { echo "::error title=selftest::$1"; exit 1; }
          [ "$code" = 1 ] || fail "the drill exited $code, not 1"
          grep -qx "ok=false" "$got/output" || fail "the drill did not set ok=false"
          grep -q "^::error title=restoreproof RESTORE_FAILED::" "$got/stdout" || fail "the drill did not report RESTORE_FAILED"
          grep -q "did not restore" "$got/summary.md" || fail "the drill's summary does not say the backup did not restore"
          {
            echo "### Self-test: the failure path"
            echo
            echo "With ${SELFTEST_WITHHELD} withheld from the copy, the drill exited 1 and reported RESTORE_FAILED, as it must. Its summary, as a failing run shows it:"
            echo
            sed "s/^/> /" "$got/summary.md"
          } >> "$GITHUB_STEP_SUMMARY"
`;
}

/** The self-test, from the workflow `init` wrote (its text, as written). */
export function renderSelftest(init: string): string {
  const parts = initParts(init);
  const steps = parts.steps.map(withTestValues);
  const services = `    services:\n${SOURCE_SERVICE}`;
  const restoreTest = [
    "  restore-test:\n",
    `${services}${S3_SERVICE}`,
    "    outputs:\n      sealed_sha256: ${{ steps.readback.outputs.sha256 }}\n",
    "    # below, init's job line for line, with the self-test's own steps (Self-test: ...) around its steps\n",
    withTestValues(parts.head),
    "    steps:\n",
    [...PRELUDE, ...steps, ...EPILOGUE].join("\n"),
  ].join("");
  const restoreFails = [
    "  restore-fails:\n",
    `    name: A backup that does not restore fails with RESTORE_FAILED\n`,
    "    runs-on: ubuntu-24.04\n",
    "    timeout-minutes: 60\n",
    services,
    withTestValues(parts.settings),
    "    steps:\n",
    [
      CHECKOUT,
      SEED,
      ...[
        "Check out the drill",
        "Read the database's PostgreSQL version",
        "Install PostgreSQL",
      ].map((name) => withTestValues(step(parts.steps, name))),
      failureStep(),
    ].join("\n"),
  ].join("");
  return `${HEADER}${restoreTest}\n${FETCH}\n${restoreFails}`;
}

export interface SelftestCheck {
  ok: boolean;
  lines: string[];
}

/** Where two texts first differ, as two numbered lines. */
function firstDifference(want: string, got: string): string[] {
  const a = want.split("\n");
  const b = got.split("\n");
  const i = a.findIndex((line, n) => line !== b[n]);
  const at = i < 0 ? a.length : i;
  return [
    `  line ${at + 1}, from init: ${a[at] ?? "(end)"}`,
    `  line ${at + 1}, this repo: ${b[at] ?? "(end)"}`,
  ];
}

/**
 * The self-test's first check: `repo`'s selftest.yml is what renderSelftest makes of the workflow
 * `init` wrote into `customer`, and `repo`'s vendored drill is the one it wrote beside it.
 */
export function checkSelftest(customer: string, repo: string): SelftestCheck {
  const read = (dir: string, rel: string): string | null => {
    const file = path.join(dir, rel);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  const lines: string[] = [];
  let ok = true;
  const init = read(customer, WORKFLOW_PATH);
  const selftest = read(repo, SELFTEST_PATH);
  const drill = read(customer, DRILL_PATH);
  const committed = read(repo, DRILL_PATH);
  if (init === null || drill === null)
    return {
      ok: false,
      lines: [
        `::error title=selftest::init wrote no ${WORKFLOW_PATH} or ${DRILL_PATH} in ${customer}`,
      ],
    };
  const want = renderSelftest(init);
  if (selftest === want)
    lines.push(`${SELFTEST_PATH} is init's workflow, with test values for its secrets.`);
  else {
    ok = false;
    lines.push(
      `::error title=selftest::${SELFTEST_PATH} is not what init writes today: regenerate it (src/selftest.ts) instead of editing it`,
      ...(selftest === null ? [`  ${SELFTEST_PATH} is missing`] : firstDifference(want, selftest)),
    );
  }
  if (committed === drill)
    lines.push(`${DRILL_PATH} is the drill init writes (${Buffer.byteLength(drill)} bytes).`);
  else {
    ok = false;
    lines.push(
      `::error title=selftest::${DRILL_PATH} in this repository is not the drill init writes; the sync writes it from dist/`,
      ...(committed === null ? [`  ${DRILL_PATH} is missing`] : firstDifference(drill, committed)),
    );
  }
  return { ok, lines };
}
