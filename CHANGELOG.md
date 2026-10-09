# Changelog

## 0.1.0 (2026-10-09)

First release.

- `restoreproof init` writes `.github/workflows/restoreproof.yml` and a dependency-free
  `.github/restoreproof/drill.mjs` into a repository. Each run, weekly by default:
  - reads the database's PostgreSQL version, and installs it from the PostgreSQL apt repository;
  - backs up with `pg_dump` (custom format, no owners or grants);
  - restores into a throwaway `initdb` cluster on the runner (127.0.0.1 only, a random password);
  - compares every table, column, constraint, index, view, function, trigger, RLS policy,
    sequence, enum and domain, and every table's rows against one READ ONLY snapshot;
  - keeps the backup as an artifact, encrypted with `RESTOREPROOF_PASSPHRASE` and never uploaded
    unencrypted from a public repository, or in the customer's own S3, R2, B2 or MinIO bucket;
  - fails the job when the backup does not restore or comes back short, or when the database
    lost over half its rows since the last good run.
- `restoreproof check` runs the same test from a laptop, with the URL read only from the
  environment; `check --dump <file>` restore-tests a backup someone already has.
- Supabase: platform schemas left out as `supabase db dump` does; `auth`, `storage` and the
  customer's schemas kept. The transaction pooler and the IPv6-only direct host are refused or
  explained. Neon: the pooled host is refused.
- `restoreproof mcp`: `restoreproof_test_restore` and `restoreproof_write_workflow`, with all four
  tool annotations. Neither takes a connection string.
- `restoreproof demo`: a recorded run on a synthetic database.
