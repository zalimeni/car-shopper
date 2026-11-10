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
- `20260616190000_user_anthropic_keys.sql` — the server-only vault for each
  user's encrypted Anthropic key (RLS on, no client policies).
- `20260713220500_app_state_history.sql` — `app_state_history` and the trigger
  that keeps the latest 30 snapshots per user (at most one per hour, plus one
  before every delete). Server-only.
- `20260713223000_app_state_rev.sql` — the `rev` counter for compare-and-swap
  writes (`save_app_state()`).
- `20261107120000_demo_snapshot.sql` — the one-row public demo snapshot
  (anyone can read it; only the service role writes it).
- `20261107190000_tighten_grants_and_rls.sql` — revokes the default
  anon/authenticated grants on the server-only tables, keeps SELECT only on
  `demo_snapshot`, and wraps the `app_state` policies' `auth.uid()` /
  `is_allowed()` calls in `(select …)` (the Performance Advisor's
  `auth_rls_initplan` lint). `is_allowed()` now ignores letter case.

- `20261110120000_save_app_state_and_realtime.sql` — `save_app_state(data,
  expected_rev)`, the one call the browser saves with (compare-and-swap on
  `rev`, SECURITY INVOKER so RLS applies), and `app_state` added to the
  `supabase_realtime` publication.

All are idempotent and ordered by filename, so applying the full set against an
existing database is safe.

## CI

`.github/workflows/migrations.yml` runs on changes under `supabase/`:

- **validate** (every push / PR, no secrets): `supabase db start` runs the
  Supabase CLI's local database (Postgres 15, with the real `auth` schema,
  roles and Realtime publication) and applies every migration. Each migration
  is then applied a second time with `psql` to prove it is idempotent. Then
  `supabase test db` runs the pgTAP tests in `tests/`: acting as the `anon`
  and `authenticated` roles (with JWT claims set the way PostgREST sets them),
  they check that each user sees only their own row, a user not on the
  allowlist sees nothing, the server-only tables refuse both roles, the demo
  snapshot is read-only, `save_app_state()` does its compare-and-swap, and
  `app_state` is published to Realtime. Run it locally the same way (needs
  Docker):

  ```bash
  supabase db start
  for f in supabase/migrations/*.sql; do
    psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -q -f "$f"
  done
  supabase test db
  ```
  The CLI version is pinned in the workflow (`supabase/setup-cli`).
- **apply** (merge to `main` only): `supabase db push --db-url "$SUPABASE_DB_URL"`
  against the real project. Dormant until the secret below is set; without it the
  job logs a skip and passes.

To enable auto-apply, under **Settings → Secrets and variables → Actions** add one
**secret**:

- `SUPABASE_DB_URL` — the **session-mode pooler** connection string. From
  Dashboard → Connect → **Session pooler**, e.g.
  `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
  (IPv4, which GitHub runners require — the direct host is IPv6-only without the
  add-on; port **5432** = session mode, needed for DDL — transaction mode/6543
  won't work). URL-encode any special characters in the password.

The DB password (inside that URL) is the right credential for migrations — it
authenticates the direct Postgres connection that runs the DDL. API keys
(`anon`/`service_role`, `sb_publishable_*`/`sb_secret_*`) are data-API
credentials and cannot run migrations.

## Signing in from an iPhone Home Screen bookmark

iOS gives a Home Screen web app its own storage, separate from Safari, and email
links always open in Safari — so tapping the sign-in link signs Safari in and
leaves the Home Screen app signed out. Two ways around it, both on the sign-in
screen:

- **Paste the link (works as is):** in Mail, long-press the sign-in link → **Copy
  Link**, then paste it into the app ("Paste link"). The app verifies the link's
  one-time token itself (`verifyOtp({ token_hash })` — `src/authLink.js`). Don't
  open the link first: that uses it up. No Supabase changes needed.
- **Type a code (optional):** needs the "Magic Link" email template to include
  `{{ .Token }}` — and Supabase only allows editing templates once the project
  uses **custom SMTP** (Authentication → SMTP; e.g. Gmail with an app password,
  or Resend). Then paste the body of
  [`templates/magic_link.html`](templates/magic_link.html) into Authentication →
  Emails → Magic Link. Code length follows Authentication → Providers → Email →
  Email OTP length (default 6; the app accepts 6–10 digits).
