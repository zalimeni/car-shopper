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
  writes (`src/storage.js`).
- `20261107120000_demo_snapshot.sql` — the one-row public demo snapshot
  (anyone can read it; only the service role writes it).
- `20261107190000_tighten_grants_and_rls.sql` — revokes the default
  anon/authenticated grants on the server-only tables, keeps SELECT only on
  `demo_snapshot`, and wraps the `app_state` policies' `auth.uid()` /
  `is_allowed()` calls in `(select …)` (the Performance Advisor's
  `auth_rls_initplan` lint). `is_allowed()` now ignores letter case.
- `20261110120000_access_and_key_vault.sql` — `allowed_emails` gets `is_admin`
  and `scheduled_sync` (owner seeded with both) and `my_access()` (allowed +
  admin in one call); `user_api_keys`, the one server-only vault for every
  user's Anthropic and MarketCheck keys (existing Anthropic keys copied in);
  backups no longer keep `settings.marketcheckKeys` (the trigger strips it,
  old snapshots are scrubbed); and deleting a user no longer fails on the
  backup trigger.

## Access: invite-only, allowlisted

Nobody can create an account by signing in: the app calls `signInWithOtp`
with `shouldCreateUser: false`, and the project has sign-ups turned off. An
admin adds an email in the Admin tab and sends an invite
(`auth.admin.inviteUserByEmail`, which works with sign-ups off). The
`allowed_emails` table is the only allowlist: RLS on `app_state` and every
`/api` function check it, and its `is_admin` / `scheduled_sync` flags decide
who sees the Admin tab and who the daily sync runs for.

One-time Dashboard settings (hosted project; `config.toml` covers the local
CLI stack):

1. **Authentication → Sign In / Providers → User Signups:** turn off **Allow new
   users to sign up**. Leave the Email provider on.
2. **Same page:** **Allow anonymous sign-ins** off (the default).
3. **Authentication → URL Configuration:** the **Site URL** is the deployed app
   (invite emails link there).

Before deploying the version that dropped `ALLOWED_EMAILS`, make sure everyone
who should keep access has a row in `allowed_emails` (env-only grants are gone).

## Key encryption v2 (migration plan)

Every key in `user_api_keys` is AES-256-GCM. **v2** (written by the current
code) derives the key with HKDF-SHA256 from `KEY_ENCRYPTION_SECRET` and binds
each ciphertext to its row's owner and provider as additional authenticated
data, so a ciphertext copied into another user's row fails to decrypt. v2
values start with `v2:`. **v1** (the old `user_anthropic_keys` format: SHA-256
of the secret, no AAD) can still be read.

1. **Deploy** this version. The migration copies the v1 Anthropic keys into
   `user_api_keys` unchanged; MarketCheck keys move in from each user's app
   state the next time they open the app (or at the next scheduled sync, or a
   backup restore) and are written as v2.
2. **Re-encrypt.** Each v1 key is rewritten as v2 the first time the server
   reads it, and the daily cron (`/api/cron-sync`, needs `CRON_SECRET`)
   rewrites every remaining v1 row. No user action is needed.
3. **Verify** in the SQL editor:
   ```sql
   select count(*) from public.user_api_keys where ciphertext not like 'v2:%';
   select count(*) from public.app_state where data #> '{settings,marketcheckKeys}' is not null;
   ```
   Both should reach 0 (the second once every user with MarketCheck keys has
   opened the app or been synced).
4. **Clean up** in a later change: delete the v1 branch of `decrypt()` in
   `api/_crypto.js` (and `encryptV1ForTests`), and add a migration that drops
   `public.user_anthropic_keys`.

Rotating `KEY_ENCRYPTION_SECRET` still invalidates every stored key (users
re-enter theirs).

All are idempotent and ordered by filename, so applying the full set against an
existing database is safe.

## CI

`.github/workflows/migrations.yml` runs on changes under `supabase/`:

- **validate** (every push / PR, no secrets): applies the CI shim
  (`ci/shim.sql`, which stubs the Supabase `auth` schema + roles) and then every
  migration — twice — against a throwaway Postgres to prove they run cleanly and
  are idempotent. Then `ci/rls_checks.sql` acts as the `anon` and
  `authenticated` roles (with JWT claims set the way PostgREST sets them) and
  checks the RLS policies and grants: each user sees only their own row, a user
  not on the allowlist sees nothing, the server-only tables refuse both roles,
  and the demo snapshot is read-only. Run it locally the same way:

  ```bash
  psql "$PGURL" -f supabase/ci/shim.sql
  for f in supabase/migrations/*.sql; do psql "$PGURL" -v ON_ERROR_STOP=1 -f "$f"; done
  psql "$PGURL" -v ON_ERROR_STOP=1 -f supabase/ci/rls_checks.sql
  ```
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
