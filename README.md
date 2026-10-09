# restoreproof

A backup of your Postgres database that is restored and checked every time it runs. For Supabase
(whose Free plan has no backups), Neon, or any other Postgres, in your own GitHub Actions.

```sh
npx --allow-git=root github:agentwares/restoreproof init
```

That writes two files into your repository: a workflow, and the drill it runs. Every week the
workflow backs the database up with `pg_dump`, restores the backup into a throwaway PostgreSQL of
the same version on the runner, and compares the two: every table, column, constraint, index,
view, function, trigger and row-level security policy, and every table's rows. If the backup does
not restore, or comes back short, the job fails.

No account, and nothing hosted by us. The backup stays in your repository's artifacts (encrypted
with your passphrase) or in your own bucket; nothing is sent to us, and nothing is fetched from us
when it runs.

## Why a restore test

A `pg_dump` that exits 0 is not a backup you can restore. Version skew, an extension the new
server lacks, a role a policy names, row-level security hiding rows from the dumping role, or a
schema left out can each make it fail when you need it. Only restoring finds out. And each
provider's own GitHub Actions recipe stops at the dump (read 9 October 2026):

| Provider | What it keeps                                                                                                                        | Its own Actions recipe                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Supabase | Free: no backups. Pro: 7 days of daily backups; Team 14. Point-in-time recovery from about $100 a month. Never the files in Storage. | [Dumps daily and commits the dump to your repository](https://supabase.com/docs/guides/deployment/ci/backups). No restore. |
| Neon     | A restore window of 6 hours on Free, up to 7 days on Launch, up to 30 on Scale.                                                      | [Dumps nightly to S3](https://neon.com/docs/manage/backups-aws-s3-backup-part-2). No restore.                              |

## What it prints

A recorded run, on the **synthetic** database in
[`examples/synthetic-source.sql`](examples/synthetic-source.sql) (shaped like a small Supabase
project: auth and storage schemas, RLS policies calling `auth.uid()`, a partitioned table),
restored into a throwaway PostgreSQL 17 (`restoreproof demo` replays it):

```text
restoreproof 0.1.0 · restore test PASSED · 2026-10-09 20:37 UTC

  source    PostgreSQL 17.9 (supabase), 9.1 MB, read through RESTOREPROOF_DATABASE_URL
  backup    91.5 KB in 0.1 s (pg_dump 17.9, custom format)
  restored  in 0.1 s into PostgreSQL 17.9, a throwaway cluster on 127.0.0.1 with no other connections
  checked   5,925 rows in 9 tables against the live database: all match
            92 schema objects: 11 tables, 37 columns, 17 constraints, 14 indexes, 1 view, 1
            materialized view, 2 functions, 1 trigger, 3 policies, 3 sequences, 1 enum, 1 domain

  table                                   live → restored
  auth.users                               400 → 400
  public.events_2026_09                  1,500 → 1,500
  public.events_2026_10                  1,500 → 1,500
  public.notes                           2,000 → 2,000
  public.profiles                          400 → 400
  public.settings                            2 → 2
  storage.buckets                            1 → 1
  storage.objects                          120 → 120
  supabase_migrations.schema_migrations      2 → 2

  notes
    - the rows of supabase_functions.hooks are left out of the backup by design, as platform data
      Supabase writes for itself (its own restore guide leaves out the Storage vector tables); their
      definitions are checked
    - 1 Supabase platform schema(s) left out of the backup, as `supabase db dump` does: graphql

An email when a weekly restore test fails or does not run is not built.
It would email the people you name when a test fails, when the backup shrinks, or when no test has
run for eight days, from outside GitHub's scheduler. Today GitHub emails one person when a scheduled
run fails, and nobody when it never runs. agentcheck's free hourly watch covers MCP servers only. If
you would pay for this one, say so with one click:
https://agentwares-agentcheck.vercel.app/restoreproof?ref=restoreproof#watch
```

In GitHub Actions the same report is the run's summary. In a public repository the summary names
no table and gives no per-table count, since anyone can read it.

## Usage

```sh
npx --allow-git=root github:agentwares/restoreproof init      # write the workflow and the drill into this repository
npx --allow-git=root github:agentwares/restoreproof check     # the same test, once, from this machine
npx --allow-git=root github:agentwares/restoreproof demo      # the recorded run above; no database, no network
npx --allow-git=root github:agentwares/restoreproof mcp       # a local MCP server for agents
```

### `init`: the weekly test, in your own GitHub Actions

It writes [`.github/workflows/restoreproof.yml`](examples/restoreproof.yml) and
`.github/restoreproof/drill.mjs`. Then:

1. Add the repository secret `RESTOREPROOF_DATABASE_URL`
   (`gh secret set RESTOREPROOF_DATABASE_URL`, which asks for the value without echoing it):
   - **Supabase:** the **Session pooler** string (Connect > Session pooler, port 5432). The direct
     `db.<ref>.supabase.co` host is IPv6 only unless you bought the IPv4 add-on, and GitHub's
     runners have no IPv6. Port 6543 is the transaction pooler, which cannot take a whole-database
     dump.
   - **Neon:** the direct string, with no `-pooler` in the host. Neon says to avoid `pg_dump`
     over a pooled connection.
   - **Any other Postgres:** a URL the runner can reach, for a role that can read every table.
2. In a public repository, also add `RESTOREPROOF_PASSPHRASE`. Anyone who can read a repository
   can download its runs' artifacts, so the workflow never uploads an unencrypted backup from a
   public repository: it fails and says so.
3. Commit both files, push, and run it once: `gh workflow run restoreproof.yml`.

Options: `--cron "17 4 * * *"` (daily; the default is Mondays 04:17 UTC), `--keep-days 28` (how
long GitHub keeps each backup), `--secret NAME` (an existing secret with the URL), `--provider`,
`--force` (replace files that differ) and `--dry-run`.

**What the workflow does**, all in the file you commit:

1. Reads the database's PostgreSQL version, and installs that version from the PostgreSQL apt
   repository, with the packages its extensions need (`pgvector`, PostGIS).
2. Dumps with `pg_dump --format=custom --no-owner --no-privileges`. On Supabase it leaves out the
   platform schemas `supabase db dump` leaves out (GraphQL, Vault, Realtime, `pg_net`, `pg_cron`
   and others) and keeps `auth`, `storage`, `public` and your own.
3. Counts every table in one READ ONLY snapshot of the live database, and reads its schema.
4. Restores into a throwaway cluster made with `initdb` on the runner: 127.0.0.1 only, a random
   password, and no extension that schedules work or makes requests. Then it compares.
5. Keeps the backup as an artifact for `--keep-days` (encrypted with `gpg` when
   `RESTOREPROOF_PASSPHRASE` is set), and copies it to your own S3, R2, B2 or MinIO bucket when
   `RESTOREPROOF_S3_URL` is set. It also keeps a small facts file (counts and names, no data) that
   the next run compares with.

**It fails the job when:**

- the backup does not restore, with `pg_restore`'s message;
- an object of the source is missing from the copy, or restored with another definition;
- a table with rows restores empty;
- a table's rows differ from its live count by more than rows written during the backup explain
  (`max(10, 10%)`; `RESTOREPROOF_MAX_ROW_DRIFT`);
- the database has lost more than half its rows since the last good run
  (`RESTOREPROOF_MAX_SHRINK`): last week's backup still has them.

**Not in any Postgres backup, this one included:** the files in Supabase Storage (their metadata
is), Vault's root key, and `pg_cron`'s schedule.

### `check`: once, from your machine

```sh
read -s RESTOREPROOF_DATABASE_URL && export RESTOREPROOF_DATABASE_URL
npx --allow-git=root github:agentwares/restoreproof check --out ~/backups
```

The URL comes only from the environment (`RESTOREPROOF_DATABASE_URL`, then `DATABASE_URL`, or the
variable `--url-env` names), never from an argument, and is never printed. It needs PostgreSQL's
own programs, of the server's major version or newer (`brew install postgresql@17`, or
`postgresql-17` from the PostgreSQL apt repository); `RESTOREPROOF_PG_BIN` points at them if they
are elsewhere. The backup is deleted afterwards unless `--out` keeps it. Keep it out of your git
checkout.

`check --dump backup.dump` restore-tests a backup you already have: a `pg_dump` archive (custom,
tar or directory) or a `.sql` file.

`--json` prints the result as JSON. Errors carry `code`, `cause`, `fix` and `retryable`.

## An email when a weekly restore test fails or does not run is not built

It would email the people you name when a test fails, when the backup shrinks, or when no test has
run for eight days, from outside GitHub's scheduler. Today GitHub emails one person (whoever
created the workflow or last changed its schedule) when a scheduled run fails, and nobody when it
never runs: GitHub may drop a scheduled run under load, and turns off a public repository's
schedules after 60 days without activity. If you would pay for that, say so with one click at
[agentcheck](https://agentwares-agentcheck.vercel.app/restoreproof?ref=restoreproof#watch).

## Inside Claude Code, and for agents

- **Plugin:** `/plugin marketplace add agentwares/restoreproof`, then
  `/plugin install restoreproof@restoreproof`. The skill runs the CLI and pre-approves nothing.
- **MCP:** `restoreproof mcp` serves two tools over stdio:
  - `restoreproof_test_restore` backs up now and proves the restore. Call it before a migration
    or a destructive command, with `keep_backup_in`. It takes the name of an environment
    variable, never a URL, so a connection string never passes through a model.
  - `restoreproof_write_workflow` adds the weekly workflow; it never overwrites a file that
    differs.

  Both set all four tool annotations.

## What it sends, and to whom

Nothing to us. The drill connects to your database and nothing else. The workflow also uses
GitHub's API (to read the last good run's facts and the repository's visibility), the PostgreSQL
apt repository, and your bucket if you name one. No telemetry, no account, no LLM calls.

## License

MIT, by agentwares.
