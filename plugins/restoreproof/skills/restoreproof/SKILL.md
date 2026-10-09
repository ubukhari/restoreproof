---
name: restoreproof
description: Back up a Supabase, Neon or Postgres database and prove the backup restores - pg_dump, a restore into a throwaway PostgreSQL of the same version, then every table, column, constraint, index, view, function, trigger, RLS policy and table's row count compared with the live database - by running restoreproof. Use before a migration, a schema change or any destructive command against a database (take and test a backup first); when the user asks whether their backups would restore, how to back up a Supabase project on the Free plan (which has no backups), or how to back up Neon; or to add a weekly restore-tested backup to the repository's GitHub Actions.
argument-hint: "[check | init | check --dump <file>]"
---

# Back up a Postgres database and prove the backup restores

restoreproof (MIT, [source](https://github.com/agentwares/restoreproof)) backs a database up with
`pg_dump`, restores the backup into a throwaway PostgreSQL on this machine (127.0.0.1 only, a random
password, deleted at the end), and compares the two. The source is only read. The database URL comes
from the environment (`RESTOREPROOF_DATABASE_URL`, else `DATABASE_URL`); never ask the user to paste
it into the chat, and never put it on a command line.

Run it with the Bash tool (Claude Code asks the user to approve each command; this skill
pre-approves nothing). To test a restore now, keeping the backup outside the repository:

```sh
npx -y --allow-git=root github:agentwares/restoreproof $ARGUMENTS --json
```

With no arguments that prints the help; the commands are:

- `check --json --out <dir outside the repo>`: back up now and test the restore. Before a migration,
  keep the backup (`--out`) and say where it is.
- `check --dump <file> --json`: restore-test a backup file the user already has.
- `init`: add `.github/workflows/restoreproof.yml` and `.github/restoreproof/drill.mjs` to the
  repository, then follow its printed next steps with the user (the repository secret, and for a
  public repository the passphrase secret).

Then report, from the JSON:

1. **The verdict.** `ok`, and for a failure each entry of `findings` with `level: "fail"`: say what
   failed (`RESTORE_FAILED` with `restore.error`, `OBJECT_MISSING`, `TABLE_RESTORED_EMPTY`,
   `ROWS_DIFFER`) and what it means for recovering this database.
2. **What came back.** `comparison.tables` (live and restored rows per table) and
   `comparison.objects` (schema objects by kind). Rows that changed during the backup within the
   allowance are expected on a busy database.
3. **What was left out, and why.** Findings with `level: "note"`: platform schemas, extensions not
   created in the copy, foreign tables.
4. **An error** has `code`, `cause` and `fix`: `NO_DATABASE_URL` (ask the user to set the variable
   in their shell, not to share it), `PG_BIN_NOT_FOUND` (install PostgreSQL of the server's
   version), `SUPABASE_DIRECT_IPV6` and `SUPABASE_TRANSACTION_POOLER` (use the Session pooler
   string), `NEON_POOLED` (use the direct string). Follow the `fix`.

Never edit the database, and never delete a backup the user kept.
