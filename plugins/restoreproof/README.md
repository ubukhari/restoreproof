# restoreproof

Back up a Postgres database and prove the backup restores, inside Claude Code.

- `/restoreproof:restoreproof` runs `npx -y --allow-git=root github:agentwares/restoreproof`. It
  either tests a restore now (`check`: a backup, a restore into a throwaway PostgreSQL, and a
  comparison table by table), or adds the weekly restore-tested backup to this repository's
  GitHub Actions (`init`). Then it explains what came back and what did not.

## What it runs, reads and sends

- **Runs** one command at a time, through the Bash tool. The skill and plugin pre-approve
  nothing, so Claude Code asks you before each command runs.
- **Fetches** restoreproof with `npx`, from where that command names. Nothing else.
- **Reads** the database named by `RESTOREPROOF_DATABASE_URL` (or `DATABASE_URL`) in your shell,
  with pg_dump and one READ ONLY transaction of catalog queries and counts. The URL is never an
  argument and never printed. It needs PostgreSQL's own programs installed, of the server's
  version or newer.
- **Writes** a throwaway PostgreSQL in a temporary directory, deleted when the test ends, and the
  backup, deleted too unless you ask to keep it. `init` writes two files into the repository.
- **Sends nothing** to us. No account, no LLM calls of its own. What the command prints (table
  names, row counts, verdicts; never a row of data) goes to Claude like any command's output.

Source, the full CLI, the workflow it writes and its documentation:
[github.com/agentwares/restoreproof](https://github.com/agentwares/restoreproof). MIT licensed, by
agentwares.
