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
