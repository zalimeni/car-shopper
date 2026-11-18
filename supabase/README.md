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
- `20261107120000_demo_snapshot.sql` — a one-row public demo table, since
  dropped (`20261118163000_drop_demo_snapshot.sql`).
- `20261107190000_tighten_grants_and_rls.sql` — revokes the default
  anon/authenticated grants on the server-only tables and wraps the `app_state` policies' `auth.uid()` /
  `is_allowed()` calls in `(select …)` (the Performance Advisor's
  `auth_rls_initplan` lint). `is_allowed()` now ignores letter case.
- `20261111120000_access_and_key_vault.sql` — `allowed_emails` gets `is_admin`
  and `scheduled_sync` (owner seeded with both) and `my_access()` (allowed +
  admin in one call); `user_api_keys`, the one server-only vault for every
  user's Anthropic and MarketCheck keys (existing Anthropic keys copied in);
  backups no longer keep `settings.marketcheckKeys` (the trigger strips it,
  old snapshots are scrubbed); and deleting a user no longer fails on the
  backup trigger.
- `20261118120000_listing_photos.sql` — the private Storage bucket
  `listing-photos` (2 MB, image types only) for copies of watchlist cars'
  dealer photos, at `<user_id>/<VIN>.<ext>`. Policies on `storage.objects`: an
  allowlisted user may read and delete only their own folder; the server
  uploads (and the daily cron sweeps unreferenced objects) with the service
  role. No Dashboard step is needed: the migration creates the bucket. Storage
  objects don't cascade when a user is deleted — the sweep removes the folder
  of any user with no `app_state` row (it runs only when `CRON_SECRET` is set).
- `20261118163000_drop_demo_snapshot.sql` — drops the public demo table: the
  demo (`/?demo`) runs only on the anonymized fixture bundled with the app.

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

## Two-factor authentication (TOTP)

Email sign-in alone means anyone who gets into a user's inbox gets the
account. Users can add an authenticator app in **Settings → Two-factor
authentication** (Supabase Auth MFA, TOTP only; phone MFA is a paid add-on).
After that, every email sign-in also asks for a 6-digit code, and an
email-only (aal1) session is refused by the API (`api/_auth.js`, 401
`mfa_required`) and by RLS (`20261118150000_mfa_aal2.sql`). It's opt-in for
users and **required for admins**: the Admin tab needs an
aal2 session, so an admin sets up an app before using them.

One-time Dashboard check: **Authentication → Multi-Factor (MFA)** — make sure
**TOTP (App Authenticator)** is enabled (it is by default on hosted projects).
Leave the limit on factors per user at 2 or more so people can add a backup app.

**No recovery codes.** Supabase doesn't issue them, so the app nudges everyone to
add a second app (another phone, or a password manager) as a backup. If someone
loses every app:

1. **Another admin** opens **Admin → 2FA · reset** on that person's row. That
   deletes their factors (`auth.admin.mfa.deleteFactor`, service role); they
   sign in by email alone and set up a new app in Settings.
2. **The only admin locked out** (e.g. the owner lost their phone): in the
   Dashboard, **Authentication → Users**, open the user, and delete their MFA
   factors (or in the SQL editor:
   `delete from auth.mfa_factors where user_id = (select id from auth.users where email = '…');`).
   Then sign in by email, and set up an app again in Settings (needed for the
   Admin tab). A safer setup is two admins, each with two-factor on.

The scheduled sync and backup restore use the service role, which isn't
subject to RLS, so two-factor doesn't affect them.

## Key encryption v2

Every key in `user_api_keys` is AES-256-GCM. **v2** derives the key with
HKDF-SHA256 from `KEY_ENCRYPTION_SECRET` and binds each ciphertext to its
row's owner and provider as additional authenticated data, so a ciphertext
copied into another user's row fails to decrypt. v2 values start with `v2:`.
The old **v1** format (from `user_anthropic_keys`: SHA-256 of the secret, no
AAD) is no longer read: every key was re-encrypted, the old table is dropped
(`20261118170000_drop_user_anthropic_keys.sql`), and MarketCheck keys no longer
live in the app-state blob. Checks (all 0):

```sql
select count(*) from public.user_api_keys where ciphertext not like 'v2:%';
select count(*) from public.app_state where data #> '{settings,marketcheckKeys}' is not null;
```

Rotating `KEY_ENCRYPTION_SECRET` still invalidates every stored key (users
re-enter theirs).

- `20261110120000_save_app_state_and_realtime.sql` — `save_app_state(data,
  expected_rev)`, the one call the browser saves with (compare-and-swap on
  `rev`, SECURITY INVOKER so RLS applies), and `app_state` added to the
  `supabase_realtime` publication.
- `20261118130000_pg_cron_scheduled_sync.sql` — the scheduled sync runs from
  the database: `pg_cron` + `pg_net`, `allowed_emails.last_scheduled_sync` /
  `last_scheduled_sync_result`, the `dispatch_scheduled_sync()` dispatcher and
  its 15-minute job, and `scheduled_sync_dispatcher_ready()`. See below.
- `20261118150000_mfa_aal2.sql` — two-factor enforcement: `mfa_ok()` (aal2, or
  no verified factor), a RESTRICTIVE policy with it on `app_state` and
  `storage.objects` (every command, every bucket), and `my_access_mfa()`
  (allowed + admin + has_mfa in one call, for `api/_auth.js`). See
  "Two-factor authentication" below.
- `20261118170000_drop_user_anthropic_keys.sql` — drops the old
  `user_anthropic_keys` table (its rows were copied into `user_api_keys` and
  re-encrypted as v2).
- `20261118170100_strict_save_app_state.sql` — `save_app_state()` no longer
  overwrites when `expected_rev` is null: that's a conflict when a row exists
  (still an insert at rev 1 when none does).

All are idempotent and ordered by filename, so applying the full set against an
existing database is safe.

## CI

`.github/workflows/migrations.yml` runs on changes under `supabase/`:

- **validate** (every push / PR, no secrets): `supabase db start` runs the
  Supabase CLI's local database (Postgres 17, with the real `auth` schema,
  roles and Realtime publication) and applies every migration. Each migration
  is then applied a second time with `psql` to prove it is idempotent. Then
  `supabase test db` runs the pgTAP tests in `tests/`: acting as the `anon`
  and `authenticated` roles (with JWT claims set the way PostgREST sets them),
  they check that each user sees only their own row, the scheduled-sync dispatcher
  is scheduled, locked away from clients and a no-op without its Vault secrets, a user not on the
  allowlist sees nothing, the server-only tables refuse both roles, `save_app_state()` does its compare-and-swap, and
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

## Scheduled sync from the database (pg_cron + pg_net)

The pg_cron job `scheduled-sync-dispatch` runs `public.dispatch_scheduled_sync(2)`
every 15 minutes. It picks up to two accounts that are due (Daily sync on in
the Admin tab, last attempt 23 h 50 min ago or more, never-synced first),
stamps `allowed_emails.last_scheduled_sync`, and POSTs `{ "email": … }` to
`/api/cron-sync` with pg_net, so each account syncs in its own function
invocation, about 24 h apart and spread over the day. A failing account is
retried the next day, not every tick.

The migration holds no URL or secret: the dispatcher reads them from Supabase
Vault and does nothing until both exist. Until then the daily Vercel cron syncs
the due accounts itself, as before; once they exist it does only the keepalive
and the key-vault sweep (it asks `scheduled_sync_dispatcher_ready()`).

**One-time setup** (Dashboard → SQL editor, after the migration is applied and
`CRON_SECRET` is set in Vercel's Production env):

```sql
select vault.create_secret('https://<your-app-domain>/api/cron-sync', 'cron_sync_url');
select vault.create_secret('<the same value as CRON_SECRET>', 'cron_secret');
```

Use the production domain (a Preview URL is behind Vercel's deployment
protection). To change a value later: `select vault.update_secret(id, '<new>')
from vault.secrets where name = 'cron_secret';` (same for `cron_sync_url`).
Remember to update `cron_secret` whenever `CRON_SECRET` is rotated in Vercel.

**Check it's working:**

```sql
-- the job, and its recent runs (each returns how many accounts it dispatched)
select jobid, schedule, command, active from cron.job where jobname = 'scheduled-sync-dispatch';
select start_time, status, return_message from cron.job_run_details
  where jobid = (select jobid from cron.job where jobname = 'scheduled-sync-dispatch')
  order by start_time desc limit 10;
-- the HTTP responses from /api/cron-sync (pg_net keeps them ~6 hours)
select id, created, status_code, error_msg, left(content, 300) from net._http_response
  order by created desc limit 10;
-- per account: last attempt and outcome ("dispatched" = the request never
-- reached the function; "started" = it ran out of time or crashed)
select email, last_scheduled_sync, last_scheduled_sync_result from public.allowed_emails
  where scheduled_sync order by last_scheduled_sync;
-- is the database in charge (what the daily Vercel run asks)?
select public.scheduled_sync_dispatcher_ready();
```

The Admin tab shows the same last run + outcome under each email. To sync an
account again right away, clear its stamp
(`update public.allowed_emails set last_scheduled_sync = null where email = '…'`);
the next tick picks it up. To pause the dispatcher:
`select cron.alter_job((select jobid from cron.job where jobname = 'scheduled-sync-dispatch'), active := false);`
(the daily Vercel run then takes over as the fallback).

## Signing in from an iPhone Home Screen bookmark

iOS gives a Home Screen web app its own storage, separate from Safari, and email
links always open in Safari — so tapping the sign-in link signs Safari in and
leaves the Home Screen app signed out. The way around it is on the sign-in
screen:

- **Paste the link (works as is):** in Mail, long-press the sign-in link → **Copy
  Link**, then paste it into the app ("Paste link"). The app verifies the link's
  one-time token itself (`verifyOtp({ token_hash })` — `src/authLink.js`). Don't
  open the link first: that uses it up. No Supabase changes needed.

The app has no typed-code sign-in (that would need the email template to carry
`{{ .Token }}`, and Supabase only allows editing templates with **custom
SMTP**, which isn't set up). If custom SMTP is ever added,
[`templates/magic_link.html`](templates/magic_link.html) is an optional branded
Magic Link body with the paste tip (Authentication → Emails → Magic Link).

## Postgres version

CI and local development use Postgres 17 (`[db] major_version` in
`config.toml`). The hosted project must run the same major version.

- To see the hosted version, open Dashboard → Project Settings →
  Infrastructure, or run `select version();` in the SQL editor.
- To upgrade the hosted project, use **Upgrade project** on that
  Infrastructure page. The upgrade is in place, and the database is
  unavailable while it runs. Do it at a quiet time.
