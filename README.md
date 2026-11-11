# car-shopper

Personal used-car search dashboard. It pulls dealer inventory for the vehicles
you're hunting, tracks them on a scored watchlist (price changes, staleness,
sold-detection), and can score each listing with AI against your own criteria.

Frontend is React + Vite; a handful of Vercel serverless functions (`api/`)
hold the secret keys and talk to MarketCheck and Anthropic. Auth and per-user
data live in Supabase.

> Vibe-coded with Claude, then cleaned up and deployed.

## What it does

- **Dealer-inventory sync** — pulls active listings matching your profiles from
  [MarketCheck](https://www.marketcheck.com/apis), nationwide, through a
  serverless proxy. New VINs become **candidates** for review; known VINs get
  price-change and last-seen updates. Sync runs when you tap **↻ Sync**, plus
  an optional daily scheduled sync.
- **Watchlist** — approve candidates to a scored, sortable watchlist with
  VIN dedup (lowest price wins), salt-belt flagging (🧂), photo thumbnails,
  reject-with-reason, staleness ("needs check") tracking, and a non-scoring
  Carfax title note.
- **AI scoring (optional)** — bring your own Anthropic API key (stored
  encrypted server-side, never shown again) to score listings 1–10 per
  criterion with rationales and an overall summary. Pick the model
  (Sonnet / Opus / Haiku); optionally auto-score on every sync.
- **Configurable for any search** — budget, home base (for distance and
  salt-belt flags), and the vehicles you want are all editable. Roles/categories are freeform, so you can
  shop one car or several, of whatever types.
- **Setup wizard** — a guided first run (budget, home base, profiles, rules)
  for new users; re-runnable, and it keeps your listings.
- **Price Check** — judges an asking price against comparable cars in your own
  data, optionally widened by a live MarketCheck search and an AI verdict.
- **Demo mode** — `/?demo` runs the app with no sign-in over a scrubbed,
  read-only copy of the owner's data.

The default setup matches the search that I built this app to assist with, but the setup wizard and Settings allow you to customize everything to your own search.

## Tabs

- **Dashboard** — counts, top picks grouped by category, stale-listing alerts,
  global-requirements summary.
- **Profiles** — vehicle profiles (make/model/powertrain/years, price &
  mileage caps, trim / drivetrain / color chips, must-haves, dealbreakers, an
  optional AI price baseline) and the global-requirements checklist. New profiles start in a wizard that
  explores the market first.
- **Criteria** — weighted scoring criteria; editing a weight recalculates every
  composite score.
- **Results** — sync, review candidates (approve / skip → restorable Skipped
  list), the watchlist, AI-scoring controls, and validated JSON import/export.
- **Compare** — a sortable side-by-side table of watchlist cars.
- **Price** — Price Check (see above).
- **Settings** — budget, home base, salt-belt handling, tagline, MarketCheck
  keys, the Anthropic key.
- **Help** — in-app usage guide. (Admins also get an **Admin** tab for the
  allowlist.)

> What filters the search vs. what happens on your device vs. what only guides
> scoring: **make / model / powertrain / years / max price / max miles** (and
> salt-belt states, when excluded) are the MarketCheck query. **Trim,
> drivetrain and color chips** hide candidates on your device. **Preferred
> trims, must/nice-to-have, dealbreakers, and global requirements** only feed
> AI scoring.

## Getting started

Requires Node 24 (see `.nvmrc`).

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # vitest: unit tests + jsdom render tests (test/)
npm run build    # production build to dist/
npm run preview  # serve the production build locally
```

The frontend runs without the serverless functions; sync and AI scoring just
won't work until they're deployed (or run via `vercel dev`) with the env vars
below.

## Environment variables

Client vars are prefixed `VITE_` and bundled into the browser (safe — protected
by RLS). Everything else is **server-only** (used in `api/`, never shipped to
the client). See `.env.example`.

| Variable | Scope | Required for | Notes |
|---|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | client | auth + storage | Defaults baked into `src/supabaseClient.js`; override to point at another project. |
| `MARKETCHECK_API_KEY` | server | dealer sync | Shared key, used only by accounts with no MarketCheck keys of their own (never a fallback for those that have some). From marketcheck.com/apis. Optional: `MARKETCHECK_HOST`, `MARKETCHECK_RADIUS` (Price Check's live comps only; free tier ≤100 mi), `MARKETCHECK_THROTTLE_MS`, and the others in `.env.example`. |
| `SUPABASE_SECRET_KEY` | server | AI key vault | Supabase **Secret key** (`sb_secret_…`) — bypasses RLS to read/write the server-only key vault. |
| `KEY_ENCRYPTION_SECRET` | server | AI key vault | ≥16 chars; AES-256-GCM key for encrypting each user's Anthropic key at rest. Rotating it invalidates stored keys (users re-enter). |
| `SCORING_MODEL` | server | — | Overrides the default scoring model (`claude-sonnet-5-5`); must be one of the allowlisted models. |
| `ALLOWED_EMAILS` | server | access control | **The email allowlist.** Comma-separated. Defaults to the owner's email. |
| `ADMIN_EMAILS` | server | Admin tab | Who may manage the allowlist and publish the demo. Defaults to the owner's email. |
| `SITE_URL` | server | — | Invite-email redirect target. Defaults to the request host. |
| `DEBUG_TOKEN` | server | — | Optional ≥24-char bypass token for headless `/api` debugging (no DB access). Unset = disabled. |
| `CRON_SECRET` | server | scheduled sync | ≥16 chars; authorizes the daily `/api/cron-sync` invocations (Vercel Cron sends it as the Bearer token). Unset = scheduled sync disabled. |
| `CRON_SYNC_EMAILS` | server | — | Which accounts the scheduled sync runs for (comma-separated). Defaults to the owner. |

## Auth & access control

The app is gated by **Supabase email auth**: tap the magic link, paste it into
the app (how an iPhone Home Screen web app signs in), or type its one-time code
(needs custom SMTP — see `supabase/README.md`). Beyond signing in, a user must
be **allowlisted** to be served by the API or to read/write data.
Access is granted if the signed-in email is **either**:

1. in the **`ALLOWED_EMAILS`** env var (comma-separated), or
2. in the **`public.allowed_emails`** table (checked via the `is_allowed()`
   RPC, which also backs Row Level Security).

Either one suffices for the API. The env var is convenient for granting API
access without a DB write, but RLS reads only the table, so a user also needs
a table row to load or save data. Anyone can sign up via magic-link, but
non-allowlisted accounts see an "access not enabled" screen and the API/RLS
reject them. Admins manage the table from the in-app Admin tab.

CI checks these rules: pgTAP tests (`supabase/tests/`, run by `supabase test
db` against the Supabase CLI's local database) sign in as different users
(and as `anon`) and assert what each can and can't read or write.

## Data storage

Per-user state is a single JSON blob — one row per user in the `app_state`
table (`src/storage.js` wraps it with an async `get/set`). Signing in
with the same email on any device loads the same data. **Export Listings**
(footer) gives a manual JSON backup; **Import** (Results) restores/seeds.
A DB trigger also keeps automatic rolling snapshots of the blob (up to 30 per
user, at most one per hour of activity) in `app_state_history`; the footer
**Backups** panel lists and restores them. Every save is one call to the
`save_app_state()` database function, a compare-and-swap on a `rev` counter,
so two open devices can't silently overwrite each other — the losing session
reloads the latest data and says so. Open sessions also subscribe to their
row with Supabase Realtime, so a save on one device shows up on the others
within seconds.

Each user's Anthropic API key (for AI scoring) is stored **encrypted** in a
separate, server-only `user_anthropic_keys` table — RLS-locked with no client
policies and no `anon`/`authenticated` grants, reachable only by the
serverless functions via `SUPABASE_SECRET_KEY`. The plaintext key never
returns to the browser (the UI shows only status + last 4). MarketCheck keys
you add in Settings are different: they are stored in your own app-state
blob and sent with each sync request.

### Supabase setup

The project URL and publishable (anon) key are baked into
`src/supabaseClient.js` (public by design; RLS protects the data). To use a
different project, set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

Apply the SQL in `supabase/migrations/` (via the Supabase CLI `supabase db
push`, or paste into the SQL editor) — it creates `app_state` + RLS, the
`allowed_emails` allowlist + `is_allowed()`, the encrypted
`user_anthropic_keys` vault, the backup history + trigger, and the public
demo snapshot (see `supabase/README.md`). Then under **Authentication → URL Configuration**
set the Site URL to your deployed URL and add `http://localhost:3000` (and any
preview URLs) to the redirect allowlist so magic links return correctly.

## Deployment

Deployed on **Vercel**; every push to `main` is a production deploy (other
branches get previews). `vercel.json` sets the build command, output dir, a
SPA rewrite (not for `/api/*`), a 60 s `maxDuration` for the functions that
call MarketCheck or Anthropic, the daily cron, and security headers
(Content-Security-Policy, `frame-ancestors 'none'`, `nosniff`,
Referrer-Policy). Set the env vars above in the Vercel project settings.

To set up from scratch: **Add New Project → Import** this repo (Vite is
auto-detected), then add the environment variables.

## Architecture

```
src/
  App.jsx           single-file React UI (components, logic, inline styles)
  Auth.jsx          Supabase email-auth gate + allowlist check
  storage.js        get/set over the app_state row (save_app_state RPC) + Realtime watch
  supabaseClient.js configured Supabase client
  sync.js           dealer-sync client (calls /api/marketcheck) + reconcile()
  syncPlan.js       what a sync does and costs (shared with the scheduled sync)
  score.js          AI-scoring client + Anthropic-key management
  demo*.js, Demo.jsx  demo mode (/?demo)
  *.js              pure, tested helpers (colors, trims, travel, quota, …)
  main.jsx          React entry (wraps App in AuthGate, or DemoShell)
api/                Vercel serverless functions (server-side secrets)
  _auth.js          shared auth + allowlist gate
  _crypto.js        AES-256-GCM encrypt/decrypt for the key vault
  _supabaseAdmin.js service-role client for the server-only tables
  _scoring.js       scoring prompt/schema/coercion + model allowlist
  marketcheck.js    MarketCheck proxy (buildUrl/normalize, one sync step per request)
  cron-sync.js      daily scheduled sync + Supabase keepalive (Vercel Cron)
  me.js             auth + key-status check for the client
  anthropic-key.js  set/validate/remove the per-user Anthropic key
  score.js          batch listing scoring with the user's key
  …                 allowlist, snapshots, pricecheck, pricecomps, baseline, profile-suggest
supabase/
  migrations/       schema, RLS, grants, triggers (append-only, idempotent)
  tests/            pgTAP tests: RLS, grants, save_app_state (supabase test db)
test/               vitest unit + jsdom render tests, fixtures
```

`AGENTS.md` has the full file map.

CI (GitHub Actions): `test.yml` runs tests + build on every push/PR;
`migrations.yml` starts the Supabase CLI's local database (Postgres 17),
applies the SQL twice, runs the pgTAP tests, and applies it to the project on
`main` if `SUPABASE_DB_URL` is configured.

## Roadmap

Shipped:

- ✅ Supabase storage + email magic-link auth + allowlist; cross-device sync
- ✅ Continuous deployment on Vercel with serverless functions
- ✅ Automated dealer-inventory sync (MarketCheck) with candidate review,
  price/availability refresh, skip-and-restore, and VIN dedup
- ✅ AI scoring with a per-user encrypted Anthropic key, model selection, and
  auto-score-on-sync
- ✅ Configurable budget / locations / freeform categories + setup wizard

- ✅ One-click archiving of listings unseen in sync for 14+ days (restorable)
- ✅ Realtime sync across open devices (Supabase Realtime on the user's row)
- ✅ Scheduled background sync (Vercel Cron, opt-in per account) — price
  changes land as review flags and new finds land in the candidate queue on
  next open

Backlog:

- [ ] Component decomposition (`App.jsx` is large)
- [ ] Normalized per-listing tables for history/dedup
- [ ] Offline support (service worker)
