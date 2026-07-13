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
  [MarketCheck](https://www.marketcheck.com/apis) (via a serverless proxy that
  keeps the API key server-side). New VINs become **candidates** for review;
  known VINs get price-change and last-seen updates. Sync is the refresh.
- **Watchlist** — approve candidates to a scored, sortable watchlist with
  VIN dedup (lowest price wins), salt-belt flagging (🧂), photo thumbnails,
  reject-with-reason, staleness ("needs check") tracking, and a non-scoring
  Carfax title note.
- **AI scoring (optional)** — bring your own Anthropic API key (stored
  encrypted server-side, never shown again) to score listings 1–10 per
  criterion with rationales and an overall summary. Pick the model
  (Sonnet / Opus / Haiku); optionally auto-score on every sync.
- **Configurable for any search** — budget, search locations (ZIPs), and the
  vehicles you want are all editable. Roles/categories are freeform, so you can
  shop one car or several, of whatever types.
- **Setup wizard** — a guided first run (budget, locations, profiles, rules)
  for new users; re-runnable without wiping data.

The default setup is opinionated (the owner's): a two-car, ≤$40K Northeast
hybrid/EV search (RAV4 Hybrid/Prime + Bolt EUV/EV + Volt; hubs in Boston MA and
Durham NC). The wizard and Settings make all of that yours.

## Tabs

- **Dashboard** — counts, top picks grouped by category, stale-listing alerts,
  global-requirements summary.
- **Profiles** — vehicle profiles (make/model/powertrain/years/trims, price &
  mileage caps, must-haves, dealbreakers), the global-requirements checklist,
  and a **Settings** card (budget, header tagline, search locations).
- **Criteria** — weighted scoring criteria; editing a weight recalculates every
  composite score.
- **Results** — sync, review candidates (approve / skip → restorable Skipped
  list), the watchlist, AI-scoring controls, and validated JSON import/export.
- **Help** — in-app usage guide.

> What filters the search vs. what only guides scoring: **make / model /
> powertrain / years / max price / max miles** are the MarketCheck query.
> **Trims, must/nice-to-have, dealbreakers, and global requirements** only feed
> AI scoring.

## Getting started

Requires Node 22 (see `.nvmrc`).

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # vitest (api/ logic)
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
| `MARKETCHECK_API_KEY` | server | dealer sync | From marketcheck.com/apis. Optional: `MARKETCHECK_HOST`, `MARKETCHECK_RADIUS` (mi, free tier ≤100), `MARKETCHECK_THROTTLE_MS`. |
| `SUPABASE_SECRET_KEY` | server | AI key vault | Supabase **Secret key** (`sb_secret_…`) — bypasses RLS to read/write the server-only key vault. |
| `KEY_ENCRYPTION_SECRET` | server | AI key vault | ≥16 chars; AES-256-GCM key for encrypting each user's Anthropic key at rest. Rotating it invalidates stored keys (users re-enter). |
| `SCORING_MODEL` | server | — | Overrides the default scoring model (`claude-sonnet-4-6`); must be one of the allowlisted models. |
| `ALLOWED_EMAILS` | server | access control | **The email allowlist.** Comma-separated. Defaults to the owner's email. |
| `DEBUG_TOKEN` | server | — | Optional ≥24-char bypass token for headless `/api` debugging (no DB access). Unset = disabled. |

## Auth & access control

The app is gated by **Supabase email magic-link auth**. Beyond signing in, a
user must be **allowlisted** to be served by the API or to read/write data.
Access is granted if the signed-in email is **either**:

1. in the **`ALLOWED_EMAILS`** env var (comma-separated), or
2. in the **`public.allowed_emails`** table (checked via the `is_allowed()`
   RPC, which also backs Row Level Security).

Either one suffices. The env var is convenient for granting access without a DB
write and applies even before the allowlist migration is run. Anyone can sign
up via magic-link, but non-allowlisted accounts see an "access not enabled"
screen and the API/RLS reject them.

## Data storage

Per-user state is a single JSON blob — one row per user in the `app_state`
table (`src/storage.js` wraps it with an async `get/set/delete`). Signing in
with the same email on any device loads the same data. **Export Listings**
(footer) gives a manual JSON backup; **Import** (Results) restores/seeds.
A DB trigger also keeps automatic rolling snapshots of the blob (up to 30 per
user, at most one per hour of activity) in `app_state_history`; the footer
**Backups** panel lists and restores them.

Each user's Anthropic API key (for AI scoring) is stored **encrypted** in a
separate, server-only `user_anthropic_keys` table — RLS-locked with no client
policies, reachable only by the serverless functions via `SUPABASE_SECRET_KEY`.
The plaintext key never returns to the browser (the UI shows only status +
last 4).

### Supabase setup

The project URL and publishable (anon) key are baked into
`src/supabaseClient.js` (public by design; RLS protects the data). To use a
different project, set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

Apply the SQL in `supabase/migrations/` (via the Supabase CLI `supabase db
push`, or paste into the SQL editor) — it creates `app_state` + RLS, the
`allowed_emails` allowlist + `is_allowed()`, and the encrypted
`user_anthropic_keys` vault. Then under **Authentication → URL Configuration**
set the Site URL to your deployed URL and add `http://localhost:3000` (and any
preview URLs) to the redirect allowlist so magic links return correctly.

## Deployment

Deployed on **Vercel**; every push to `main` is a production deploy (other
branches get previews). `vercel.json` sets the build command, output dir, a
catch-all SPA rewrite, and per-function `maxDuration` (the AI `/api/score`
function gets 60s). Set the env vars above in the Vercel project settings.

To set up from scratch: **Add New Project → Import** this repo (Vite is
auto-detected), then add the environment variables.

## Architecture

```
src/
  App.jsx           single-file React UI (components, logic, inline styles)
  Auth.jsx          Supabase magic-link gate + allowlist check
  storage.js        async get/set/delete over the app_state row
  supabaseClient.js configured Supabase client
  sync.js           dealer-sync client (calls /api/marketcheck) + reconcile()
  score.js          AI-scoring client + Anthropic-key management
  main.jsx          React entry (wraps App in AuthGate)
  index.css         minimal global reset
api/                Vercel serverless functions (server-side secrets)
  _auth.js          shared auth + allowlist gate
  _crypto.js        AES-256-GCM encrypt/decrypt for the key vault
  _supabaseAdmin.js service-role client for the key vault
  _scoring.js       scoring prompt/schema/coercion + model allowlist
  marketcheck.js    MarketCheck proxy (buildUrl/normalize) — holds the API key
  me.js             auth + key-status check for the client
  anthropic-key.js  set/validate/remove the per-user Anthropic key
  score.js          batch listing scoring with the user's key
supabase/migrations/  app_state, allowlist, anthropic-key vault
test/               vitest suites for the api/ logic + fixtures
```

CI (GitHub Actions): `test.yml` runs tests + build on every push/PR;
`migrations.yml` validates the SQL against a throwaway Postgres (and applies it
to the project on `main` if `SUPABASE_DB_URL` is configured).

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

Backlog:

- [ ] Scheduled background sync (cron) with notifications — see
  `docs/listing-pipeline.md`
- [ ] Component decomposition (`App.jsx` is large)
- [ ] Normalized per-listing tables for history/dedup
- [ ] Realtime sync across open devices; mobile PWA
