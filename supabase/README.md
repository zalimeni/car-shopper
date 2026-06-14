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

- `20260614180900_user_allowlist.sql` — server-enforced user allowlist:
  `allowed_emails` table, `is_allowed()` helper, and `app_state` RLS policies
  requiring allowlist membership. See the file header for details.

## Note

The `app_state` table predates these migrations (it was created when Supabase
storage was first wired up), so there's no baseline migration for it here. The
allowlist migration rebuilds `app_state`'s RLS policies but assumes the table
exists. Ask if you want a baseline migration added for from-scratch setup.
