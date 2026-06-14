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
