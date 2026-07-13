# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Read this first.

## What this is

A personal **car-shopping tracker**. It tracks vehicle *profiles* (make/model/
years/price), pulls matching dealer inventory automatically from the MarketCheck
aggregator, scores listings against weighted criteria (optionally with AI using
the user's own Anthropic key), and keeps a watchlist with price/availability
tracking. Budget, search locations, and freeform categories are configurable
(one car or several); a setup wizard handles first-run. Access is allowlisted;
the default config is opinionated (the owner's two-car ≤$40K Northeast hybrid/EV
search) but fully editable.

It is a small, pragmatic app — not a framework. Favor simple, surgical changes
over architecture.

## Tech stack

- **Frontend:** React 18 + Vite 8, plain JS (no TypeScript). One big component
  file (`src/App.jsx`).
- **Backend:** Vercel **serverless functions** in `api/` (Node 22, ESM).
- **Data/auth:** Supabase — magic-link auth + `app_state` (one JSONB blob per
  user) and a server-only `user_anthropic_keys` vault (encrypted per-user
  Anthropic key). RLS + an email allowlist.
- **External APIs:** MarketCheck (dealer inventory) and Anthropic (AI scoring),
  both called only from `api/` (keys never reach the browser).
- **Deploy:** Vercel (`vercel.json`). CI for DB migrations via GitHub Actions.
- Node version: **22** (`.nvmrc`, `package.json` engines).

## Repo map — what to read, what to skip

**Read these (all hand-written, all matter):**

| Path | What it is |
|---|---|
| `src/App.jsx` | The entire UI + app logic (large; the main file). |
| `src/sync.js` | Client side of the listing sync: `fetchListings`, `fetchRawSample` (re-exports `reconcile`). |
| `src/reconcile.js` | `reconcile()` — pure, import-free (shared with server-side sync). |
| `src/score.js` | Client side of AI scoring + Anthropic-key management; `scoreSet`, model list. |
| `src/storage.js` | Supabase-backed get/set/delete of the per-user JSONB blob. |
| `src/supabaseClient.js` | Supabase client + default URL/anon key. |
| `src/Auth.jsx` | Magic-link auth gate + the "not authorized" screen. |
| `src/main.jsx`, `src/index.css` | Entry point + global styles. |
| `api/marketcheck.js` | Serverless proxy to MarketCheck (holds the API key). `buildUrl`/`normalize`. |
| `api/_auth.js` | Server-side auth + allowlist (`authorize()`). Shared module. |
| `api/me.js` | Allowlist + Anthropic-key-status check for the UI. |
| `api/_scoring.js` | Scoring prompt/schema/coercion + model allowlist (`resolveScoreModel`). |
| `api/_crypto.js` | AES-256-GCM encrypt/decrypt for the Anthropic-key vault. |
| `api/_supabaseAdmin.js` | Service-role (`SUPABASE_SECRET_KEY`) client for the key vault. |
| `api/anthropic-key.js` | Validate / store (encrypted) / remove the per-user Anthropic key. |
| `api/snapshots.js` | List/restore the automatic app-state backups (`app_state_history`). |
| `api/cron-sync.js` | Scheduled background sync (Vercel Cron; `CRON_SECRET`-gated, `CRON_SYNC_EMAILS` accounts). |
| `api/score.js` | Batch listing scoring with the user's decrypted key. |
| `supabase/migrations/*.sql` | DB schema (baseline + allowlist + anthropic-key vault). |
| `supabase/ci/shim.sql`, `supabase/config.toml` | CI migration testing + CLI config. |
| `.github/workflows/migrations.yml` | Validate + apply migrations. |
| `docs/listing-pipeline.md` | **Design doc** for the sync pipeline. Read for the "why". |
| `supabase/README.md` | How to apply migrations + CI secrets. |
| `.env.example` | Every env var, documented. |
| `vercel.json` | Build + SPA rewrite. |

**Do NOT load into context (generated / vendored / noise):**

- `node_modules/` — vendored dependencies (gitignored). Never read.
- `dist/` — Vite build output (gitignored); `dist/assets/index-*.js` are minified
  bundles. Never read; rebuild instead.
- `package-lock.json` — generated lockfile (~36K). Only consult for a specific
  dependency version; never read in full.
- `public/` — static assets (favicon).

There is **no generated source** in `src/` or `api/` — it's all authored by hand.

## Architecture (quick)

See `docs/listing-pipeline.md` for the full design. In short:

- **State model:** the whole app state (`profiles`, `criteria`, `globalReqs`,
  `listings`, `settings` {budget, taxRate, tagline, hubs}, `skipped`,
  `scoreModel`, `autoScore`, `onboarded`, `version`, `lastSynced`) is one JSONB
  blob per user in `app_state.data`. `storage.js` reads/writes it; `App.jsx`
  holds it in `data` and saves via `save()` / `saveRecalc()` / `patchListings()`.
  There is no per-listing table. Bump `VERSION` + add a `migrate()` step when the
  blob shape changes (see the v6 `settings` migration).
- **AI scoring:** `src/score.js` → `POST /api/score` decrypts the user's vaulted
  Anthropic key (`_crypto` + `_supabaseAdmin`) and scores each listing against a
  JSON schema built from the user's criteria (`_scoring.js`, model allowlisted).
  Roles/categories are freeform; budget/hubs live in `data.settings`.
- **Auth + allowlist (server-enforced):** anyone can sign up via magic link, but
  `api/_auth.js` requires the email be allowlisted — via the `ALLOWED_EMAILS`
  env var **or** the `allowed_emails` DB table (`is_allowed()` RPC). RLS on
  `app_state` enforces the same at the data layer. The UI calls `GET /api/me`
  and shows a friendly screen for non-allowlisted users (fails open on error —
  RLS/API are the real boundary).
- **Sync pipeline:** `src/sync.js` → `POST /api/marketcheck` (proxy holding
  `MARKETCHECK_API_KEY`) → MarketCheck `/v2/search/car/active` → `normalize()` →
  `reconcile()`. New VINs become **candidates** (human-approved, same as Import);
  known VINs get price-change notes + `lastSeen`. Runs on app open (12h debounce)
  and via the **↻ Sync** button on the Results tab.
- **All MarketCheck-specific field/param names live in `buildUrl()` and
  `normalize()` in `api/marketcheck.js`** — if the API shape is wrong, that's the
  only place to change.

`App.jsx` is large but navigable; in order: constants/defaults (incl.
`DEFAULT_SETTINGS`, `roleColor`, `RoleBadge`) → utilities (`calcRem`, `applyScore`)
→ import validation → `dedupInsert`/`migrate`/`freshData` → `App` component
(state + callbacks) → `DashView`/`BG` → `Wizard` → `SettingsCard`/`ProfilesTab`/
`ProfEd` → `CriteriaTab` → `HelpTab` → `ResultsTab` → `SyncStatus`/`AiPanel` →
`AiBox`/`TitleNote`/`Thumb` → `CandCard` → `LForm` → `LCard` → the `S` style
object. (The old manual `QueriesTab`/`SOURCES` and the two-car `PairCalc` were
removed.)

## Commands

```bash
npm install
npm run dev       # Vite dev server (UI only — see caveat below)
npm run build     # production build to dist/
npm run preview   # serve the built bundle
npm test          # Vitest golden tests (see test/)
```

**Tests:** Vitest tests live in `test/` and cover the deterministic core —
`buildUrl`/`parseYears`/`normalize`/`mapDealerType`/`pickPhoto`
(`api/marketcheck.js`), `reconcile` (`src/sync.js`), the scoring helpers
(`buildScoreSchema`/`buildUserPrompt`/`coerceResult`/`resolveScoreModel`,
`api/_scoring.js`), and the key crypto round-trip (`api/_crypto.js`). The
`buildUrl` test guards against request regressions (host; exact-year `year` CSV
so non-contiguous profiles exclude gap years; no `seller_type`). Fixtures are in
`test/fixtures/` — refresh
`marketcheck-active-search.json` from a real response via the **Debug raw**
button when the API shape is confirmed (see `test/README.md`). No linter is
configured. CI: `.github/workflows/test.yml` runs `npm test` + `npm run build`
on every push/PR.

### Local dev caveat (important)

`vite dev` serves the **frontend only** — it does **not** run the `api/`
serverless functions. So `/api/marketcheck`, `/api/me`, etc. will 404 locally;
the UI fails open (you'll see sync errors / it skips the allowlist check). To run
the functions locally use **`vercel dev`**, or test them on a Vercel **preview
deployment** of your branch.

## Environment variables

Defined/documented in `.env.example`. Summary:

| Var | Where | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | client (bundled) | Supabase connection. Public by design (RLS protects data). |
| `MARKETCHECK_API_KEY` | server only | MarketCheck data key. **Never** `VITE_`-prefixed. (Optional: `MARKETCHECK_HOST`, `MARKETCHECK_RADIUS` default 100, `MARKETCHECK_THROTTLE_MS`.) |
| `SUPABASE_SECRET_KEY` | server only | Supabase Secret key (`sb_secret_…`); service-role access to the `user_anthropic_keys` vault. |
| `KEY_ENCRYPTION_SECRET` | server only | ≥16 chars; AES-256-GCM key for the stored Anthropic keys. Rotating invalidates them. |
| `SCORING_MODEL` | server (optional) | Override default scoring model (`claude-sonnet-4-6`); must be allowlisted in `_scoring.js`. |
| `ALLOWED_EMAILS` | server (optional) | Comma-separated allowlist; union with the `allowed_emails` DB table. |
| `DEBUG_TOKEN` | server (optional) | ≥24-char bearer bypass for headless `/api` debugging (no DB access). |
| `CRON_SECRET` | server (optional) | ≥16 chars; authorizes the daily `/api/cron-sync` (Vercel Cron Bearer token). Unset = scheduled sync off. |
| `CRON_SYNC_EMAILS` | server (optional) | Accounts the scheduled sync runs for (comma-separated; default owner). |
| `SUPABASE_DB_URL` | GitHub Actions secret | Session-pooler URL for CI `db push`. |

**Golden rule:** only `VITE_`-prefixed vars reach the browser bundle. Anything
secret (API keys, DB URLs) must NOT start with `VITE_`. Vercel scopes env vars
per environment (Preview vs Production) — set keys in the env you're testing.

## Conventions

- **Match the existing style.** `App.jsx` is deliberately terse: `var`, function
  expressions, `Object.assign({}, ...)` for immutable updates, and inline style
  objects via the `S` map (no CSS modules / styled-components). Don't introduce
  TypeScript, a state library, or a styling system.
- Keep external-API quirks isolated in `normalize()`/`buildUrl()`.
- Migrations are **append-only** and must be **idempotent** (see existing ones).
- Don't commit secrets or `.env`. `.env.example` is the source of truth for vars.

## Debugging playbook

### Sync returns "0 found" / query errors
1. Read the **status line** under the Results header — it now shows the first
   error message (e.g. `… MarketCheck HTTP 401`). Also check the browser console
   (`console.warn("Sync query errors", …)`).
2. Tap the **Debug raw** button in the footer (works on mobile — no console
   needed). It runs one live query and shows the raw MarketCheck response,
   `topLevelKeys`, `num_found`, the request URL (key redacted), and
   `normalizedSample` in a copyable box. Equivalent: `await window.__rawSync()`
   in a desktop console, or `POST /api/marketcheck?raw=1`. Compare `rawSample`
   vs `normalizedSample` to spot field-name mismatches — fix only
   `normalize()`/`buildUrl()`.
3. Common causes:
   - `MARKETCHECK_API_KEY is not configured` → key missing for that Vercel env.
   - HTTP 401/403 → bad key or the plan lacks the active-search endpoint.
   - HTTP 4xx on every query → wrong host/param (it's `api.marketcheck.com`,
     `year` as an exact-year CSV, `price_range`/`miles_range`, `zip`+`radius`).
   - Radius > 100 on the free tier → set `MARKETCHECK_RADIUS=100`.
4. To exercise the full candidate/approve flow **without** the API or key, the
   proxy supports `?mock=1` (synthetic listings).

### Headless / agent debugging (no email login)
If `DEBUG_TOKEN` is set in the server env (a long random secret), call the API
directly with it as the Bearer token — sidesteps the magic-link flow. It grants
the **API surface only** (no DB/user-data access; RLS still applies). Example:
```bash
curl -X POST "$SITE/api/marketcheck?raw=1" \
  -H "Authorization: Bearer $DEBUG_TOKEN" -H "Content-Type: application/json" \
  -d '{"profiles":[{"id":"rav4-hybrid","name":"RAV4 Hybrid","params":{"make":"Toyota","model":"RAV4 Hybrid","years":"2019-2022","maxPrice":25000,"maxMiles":90000}}],"hubs":[{"n":"Boston MA","z":"02101"}]}'
```
Use `?mock=1` instead of `?raw=1` to avoid hitting MarketCheck. Rotate
`DEBUG_TOKEN` to revoke. For a *real user* session (to exercise data/RLS), the
Supabase-idiomatic route is a dedicated password user via
`auth.admin.createUser({ email_confirm: true })` + `signInWithPassword`.

### Auth / allowlist
- `401` from `/api/*` = not signed in / missing-invalid token. `403` = signed in
  but not allowlisted.
- Allowed if email is in `ALLOWED_EMAILS` **or** the `allowed_emails` table.
  Manage the table in Supabase; env var is a quick API-only grant (note: env-only
  grants pass the API but RLS still needs a table row to read/write data).
- Non-allowlisted users see the "Access not enabled" screen (`Auth.jsx`).

### Data not loading / saving
- `storage.js` operates as the logged-in user; RLS requires `auth.uid() =
  user_id` **and** `is_allowed()`. If a legit user sees empty data after the
  allowlist migration, confirm their email is a row in `allowed_emails`.
- Storage errors are caught and logged (`console.error("storage.* error")`) and
  return `null` — check the console.

### Migrations
- Validate locally the same way CI does: run a throwaway Postgres, apply
  `supabase/ci/shim.sql` (stubs the `auth` schema/roles), then each
  `supabase/migrations/*.sql` in order (twice, to confirm idempotency).
- CI: `.github/workflows/migrations.yml` validates on every push/PR and applies
  on merge to `main` via the IPv4 session pooler. See `supabase/README.md`.

## Making common changes

- **New migration:** add `supabase/migrations/<UTC-timestamp>_<name>.sql`
  (idempotent). CI validates it; merge to `main` applies it.
- **New env var:** document it in `.env.example`; set it in Vercel for the right
  environment (and `VITE_`-prefix only if it's safe for the browser).
- **New default profile / criterion:** edit `DEFAULT_PROFILES` /
  `DEFAULT_CRITERIA` near the top of `App.jsx` (and bump `VERSION` + add a
  `migrate()` step if the blob shape changes).

## Deploy

Vercel builds from `main` (`npm run build` → `dist/`). The SPA rewrite in
`vercel.json` sends non-file routes to `index.html`; functions in `api/` take
precedence and are not rewritten. DB migrations auto-apply via CI on merge to
`main`.
