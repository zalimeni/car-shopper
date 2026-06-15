# Supabase migrations

SQL migrations for the Supabase project, named `<timestamp>_<name>.sql` per the
Supabase CLI convention.

## Apply

**CLI (recommended):**

```bash
supabase link --project-ref dispkandrvmycwccavvl   # one-time
supabase db push                                    # applies pending migrations
```

**Dashboard (no CLI):** open each migration in `migrations/` and run it in
Dashboard → SQL editor. The migrations are idempotent, so re-running is safe.

## Migrations

- `20260614170000_baseline_app_state.sql` — baseline schema: the per-user
  `app_state` table + per-user RLS. Idempotent (`if not exists`), so it's a
  no-op on the existing database and lets a fresh project be built from zero.
- `20260614180900_user_allowlist.sql` — server-enforced user allowlist:
  `allowed_emails` table, `is_allowed()` helper, and `app_state` RLS policies
  tightened to also require allowlist membership. See the file header for details.

Both are idempotent and ordered by filename, so applying the full set against an
existing database is safe.

## CI

`.github/workflows/migrations.yml` runs on changes under `supabase/`:

- **validate** (every push / PR, no secrets): applies the CI shim
  (`ci/shim.sql`, which stubs the Supabase `auth` schema + roles) and then every
  migration — twice — against a throwaway Postgres to prove they run cleanly and
  are idempotent.
- **apply** (merge to `main` only): assembles the session-pooler URL and runs
  `supabase db push --db-url ...` against the real project. Dormant until the
  secret below is set; without it the job logs a skip and passes.

To enable auto-apply, under **Settings → Secrets and variables → Actions** add:

- **Secret** `SUPABASE_DB_PASSWORD` — the project's database password (CI
  URL-encodes it).
- **Variable** `SUPABASE_DB_REGION` — the project's region, i.e. the `aws-0-<REGION>`
  part of the pooler host (e.g. `us-east-1`). Find it in Dashboard → Connect →
  Session pooler.
- (optional) **Variable** `SUPABASE_PROJECT_REF` — defaults to the project ref in
  `supabaseClient.js`.

CI builds the **session-mode pooler** URL (IPv4, which GitHub runners require;
the direct host is IPv6-only without the add-on; port 5432 = session mode, needed
for DDL). The DB password is the right credential for migrations — it
authenticates the direct Postgres connection that runs the DDL. API keys
(`anon`/`service_role`, `sb_publishable_*`/`sb_secret_*`) are data-API
credentials and cannot run migrations.
