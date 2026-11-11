# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Read this first.

## What this is

A personal **car-shopping tracker**. It tracks vehicle *profiles* (make/model/
years/price), pulls matching dealer inventory automatically from the MarketCheck
aggregator, scores listings against weighted criteria (optionally with AI using
the user's own Anthropic key), and keeps a watchlist with price/availability
tracking. Budget, home base, and freeform categories are configurable
(one car or several); a setup wizard handles first-run. Access is allowlisted;
sign-in is invite-only; the default config is opinionated (the owner's two-car ≤$40K Durham-based hybrid/EV
search) but fully editable.

It is a small, pragmatic app — not a framework. Favor simple, surgical changes
over architecture.

## Tech stack

- **Frontend:** React 18 + Vite 8, plain JS (no TypeScript). One big component
  file (`src/App.jsx`).
- **Backend:** Vercel **serverless functions** in `api/` (Node 24, ESM).
- **Data/auth:** Supabase — invite-only email auth (magic link, pasted link, or
  one-time code — see `supabase/README.md`) + `app_state` (one JSONB blob per
  user) and a server-only `user_api_keys` vault (each user's encrypted
  Anthropic and MarketCheck keys). RLS + the `allowed_emails` allowlist.
- **External APIs:** MarketCheck (dealer inventory) and Anthropic (AI scoring),
  both called only from `api/`. Keys never reach the browser: the user's own
  keys live encrypted in `user_api_keys` (`api/_keys.js` is the only place that
  decrypts them), the shared `MARKETCHECK_API_KEY` in the server env. The
  browser sees labels + last 4 only. (Blobs from before the vault may still
  hold `settings.marketcheckKeys`; the app, the cron and a backup restore move
  them into the vault and drop the blob's copy.)
- **Deploy:** Vercel (`vercel.json`). CI for DB migrations via GitHub Actions.
- Node version: **24** (`.nvmrc`, `package.json` engines, CI).

## Repo map — what to read, what to skip

**Read these (all hand-written, all matter):**

| Path | What it is |
|---|---|
| `src/App.jsx` | The entire UI + app logic (large; the main file). |
| `src/sync.js` | Client side of the listing sync: `fetchListings`, `fetchRawSample` (re-exports `reconcile`). |
| `src/reconcile.js` | `reconcile()` — pure, import-free (shared with server-side sync). |
| `src/score.js` | Client side of AI scoring + Anthropic-key management; `scoreSet`, model list. |
| `src/keys.js` | Client for the MarketCheck keys in the vault (list / add / rename / reorder / remove / the one-time import from an old blob). |
| `src/storage.js` | Supabase-backed get/set of the per-user JSONB blob: `set()` is one `save_app_state()` RPC (compare-and-swap on `rev`, in the database); `watchState()` is the Realtime subscription to the user's own row. |
| `src/supabaseClient.js` | Supabase client + default URL/anon key. |
| `src/Auth.jsx` | Email auth gate: tap the magic link, **paste** it (`src/authLink.js` — how an iOS Home Screen web app signs in, since links open in Safari), or type the one-time code (needs custom SMTP + template) — plus the "not authorized" screen. |
| `src/main.jsx`, `src/index.css` | Entry point + global styles. |
| `src/locations.js` | Home-base picker logic: parse/search `public/locations.txt` (city or ZIP suggestions with coordinates). Pure, tested. |
| `src/syncPlan.js` | **What a sync does and costs.** Per active profile: a full refresh (due after 3 days, an edit, or a manual Sync) or a new-listings pass; then a VIN lookup of watchlist cars the searches didn't return (the only "gone" signal); then a NeoVIN VIN decode for cars with no color (≤10 a sync, each VIN once — `settings.mcColors`). `planSync`, `runSync` (orchestration with an injected step runner — shared by the browser and the scheduled sync), `estimateCost`, `nextProfileMeta` (`settings.mcProfiles`). Pure, tested. |
| `src/queryPlan.js` | Profile field → MarketCheck value helpers (`mapPowertrain`, `parseYears`). Profiles are no longer merged: nationwide, merging widens filters. |
| `src/regions.js` | Salt-belt states and the `state=` list a search sends (salt belt excluded, or every state when flagging). Pure. |
| `src/airports.js`, `src/travel.js` | Major-airport list + `travelFacts`: miles from the home base ("ship or fly" past 500), nearest airport ("fly-in friendly" within 50 mi), salt-belt flag. Flags only — never filters. Used by cards and AI scoring. Pure, tested. |
| `src/colors.js` | Per-profile exterior-color filter (`params.excludeColors`, `params.includeUnlistedColor` default on), applied on our side to candidates — matches MarketCheck's normalized `baseColor` (`base_ext_color`; filled from the VIN decoder when a listing has none), keyword fallback for older listings. The editor's choices come from a facet (counts per color, plus how many list none) fetched when a profile is saved with new search filters (`refreshProfileFacets` → a `count` step) and refreshed by every full refresh (facet on its page 1, no extra call). Global `settings.defaultExcludeColors` seeds new profiles. Pure, tested. |
| `src/trims.js` | Per-profile trim + drivetrain chips — same model as colors, from the same facet call. Trims are MarketCheck's `version` (what cards show; tells "Limited XT" from "Limited"), three states: ☆ neutral / ★ preferred (`params.preferTrims`, mirrored into `params.trims` for the scorer) / hidden (`params.excludeTrims`); drivetrains hide-only (`params.excludeDrivetrains`). Choices = facet ∪ trims seen on synced cars. (Replaced the old fuzzy `trimInclude`/`trimExclude` text; migrate v9 dropped it.) Pure, tested. |
| `src/tags.js` | Freeform listing tags (`listing.tags`): add/remove (case-insensitive, adopts an existing tag's spelling), `allTags` for suggestions + the Results/Compare tag filter. AI scoring sees them; editing never marks a score stale. Pure, tested. |
| `src/compareCols.js` | Compare table column layout: user order (drag a header) + pins (sticky on the left), stored in `settings.compareCols`. `layoutColumns`/`moveColumn`/`togglePin`. Pure, tested. |
| `src/profileWizard.js` | The new-profile wizard's arithmetic over one Explore answer (a `count` step: facets + `stats=price,miles` percentiles): `shareUnder` (≈ share of cars under a cap), `capChoices` (25/50/75/90th-percentile quick picks), `estimateMatches`, years as a From–To range minus skipped years (`rangeYears`/`yearOptions`/`yearChoices`/`formatYears`). UI: `ProfileWizard` in `App.jsx`. Pure, tested. |
| `src/demo.js`, `src/demoRuntime.js`, `src/Demo.jsx` | **Demo mode** (`/?demo`, no sign-in). `demo.js` (pure, tested): `buildDemoSnapshot` (scrub secrets + unchecked notes, hold back the newest queued cars as a sync `pool`), `prepareDemo` (shift every date so it reads as today; swap in a demo MarketCheck key + made-up quota, `demoQuota`), `simulateSync`, `demoScore` (copies the nearest already-scored car's scores, nudged for price/mileage), and the market/AI stand-ins `demoCount` (a `count` step from the demo's cars + stored `mcProfiles` breakdowns), `demoMarketComps`, `demoPriceAssessment`, `demoBaseline`, `demoSuggestion`. `demoRuntime.js`: `DEMO` flag, loads `public.demo_snapshot`, `installFetchGuard` (answers every `/api` call locally + toasts), `demoFetchListings` / `demoScoreSet` (paced with fake network time — `setDemoDelay(0)` in tests). In demo, `score.js` (`scoreSet`, `getKeyStatus`, `getScorePrompt`, `generateBaseline`, `generatePriceAssessment`, `suggestProfile`) and `sync.js` (`postStep`, `fetchPriceComps`) hand off to `demoRuntime.js`, which reads the visitor's live state via `registerDemoData` — a new client API call needs the same hand-off. `Demo.jsx`: banner, welcome / "how this app uses Supabase" modal, toasts, admins' `DemoPublishModal`. |
| `src/tutorial.js`, `src/Tutorial.jsx` | **Guided tutorial** (dim overlay + spotlight + card). `tutorial.js` (pure, tested): `STEPS` (tab, `data-tour` target, text; `action: "click"` steps wait for the tapped control to finish; `costly` ones only explain when signed in), `placeCard`, `startTutorial()` (an event). `Tutorial.jsx` is mounted once in `App`. Launched from Help (signed in) and the demo's welcome (first visit) + banner. |
| `public/demo/`, `scripts/demo-fixture/` | **The demo's data**: `snapshot.json` (a curated, anonymized fixture in the demo-snapshot shape) + `cars/car-NN.webp` thumbnails. Regenerate with `scripts/demo-fixture/` (see its README): `build.mjs` picks ~35 cars from an export by rule and synthesizes VINs, dealers and free text (no owner data in the script); `thumb.py` cuts each car out of its dealer photo onto a studio backdrop. `test/demoFixture.test.js` fails on anything sensitive (contacts, keys, links, real VIN checks, stray build inputs). |
| `src/markdown.js` | Safe Markdown parser for listing notes (text → typed tree, never HTML; http(s)-only links) + the `MEMO_MAX` (4,000-char) limit. Pure, tested. Rendered by `MarkdownView` / `ListingMemo` in `App.jsx`. |
| `src/quota.js` | MarketCheck quota bookkeeping for the header gauge + modal: per-key snapshots (from syncs / live searches — never its own calls), capacity across keys (used in order), sync-cost estimates. Pure, tested. |
| `public/locations.txt` | Flat file (`ST|City|ZIP|lat|lon`, ~41k rows) behind the location picker; lazy-loaded, not bundled. Built by `scripts/build-locations.mjs` from GeoNames (CC BY 4.0). |
| `api/marketcheck.js` | Serverless proxy to MarketCheck (holds the API key). One sync step per request (`runStep`: full / new / count / vins / local) over a `createSession` (key failover, throttle, time budget). `buildUrl`/`normalize`. |
| `api/_auth.js` | Server-side auth + allowlist: `authorize()` → `{ user, admin }` from one `my_access()` RPC. Shared module. |
| `api/allowlist.js`, `src/admin.js` | Admin tab (admins only, `allowed_emails.is_admin`): list / add / remove emails, send an invite (the only way to get an account), toggle Admin / Daily sync per row. |
| `api/me.js` | Allowlist + admin + key-status check for the UI (key metadata only). |
| `api/_scoring.js` | Scoring prompt/schema/coercion + model allowlist (`resolveScoreModel`). |
| `api/_crypto.js` | AES-256-GCM for the key vault: v2 = HKDF key + AAD `<user_id>:<provider>`, `v2:` prefix; reads legacy v1. Tested. |
| `api/_keys.js` | The key vault (`user_api_keys`): the only module that decrypts. `getAnthropicKey`, `getMarketcheckKeys`, `keyMeta`, add/rename/reorder/remove, `importBlobKeys`, `reencryptLegacy` (cron). Tested. |
| `api/_supabaseAdmin.js` | Service-role (`SUPABASE_SECRET_KEY`) client for the server-only tables; also the server's one copy of the project URL + publishable key. |
| `api/keys.js` | `/api/keys`: validate / store (encrypted) / remove the Anthropic key; add / rename / reorder / remove MarketCheck keys. Answers with metadata only. |
| `api/snapshots.js`, `src/snapshots.js` | List/restore the automatic app-state backups (`app_state_history`); admins also publish the demo snapshot here (`POST { demo }`). |
| `api/ai.js`, `api/_ai.js` | **Every AI feature, one function.** `POST { task }`: `score` (batch listing scoring), `price` (Price Check's fair-price verdict), `baseline` (a profile's AI price baseline), `suggest` (the profile wizard's AI step); `GET ?task=prompt` returns the default scoring prompt. `_ai.js`: `loadAnthropicKey(userId)` (the only place the vaulted key is decrypted), the streamed call, refusal / token-limit / rejected-key handling. Prompts + schemas: `_scoring.js` (score, baseline), `_pricecheck.js`, `_suggest.js`. |
| `api/pricecomps.js` | Price tab: live MarketCheck comps around the home base (a `local` step). |
| `src/priceCheck.js`, `src/priceExport.js` | Price tab's local-comps math (pure, 0 API calls) and the price-history CSV export. Pure, tested. |
| `src/geo.js`, `src/tableSort.js` | Straight-line distance to the home base; shared sortable-table helpers (Compare, Price comps). Pure, tested. |
| `api/cron-sync.js` | Scheduled background sync (Vercel Cron; `CRON_SECRET`-gated; accounts with `allowed_emails.scheduled_sync`), plus the vault's v1 → v2 re-encryption sweep. |
| `api/_suggest.js` | The wizard's optional AI step (`api/ai.js` task `suggest`): must-haves / dealbreakers / years to avoid / trim notes from the vehicle + Explore's market snapshot. Prompt, schema, `coerceSuggestion` (tested). |
| `supabase/migrations/*.sql` | DB schema: `app_state` + RLS, allowlist, Anthropic-key vault, backup history + trigger, `rev`, demo snapshot, grant/RLS tightening. |
| `supabase/tests/*.test.sql`, `supabase/config.toml` | pgTAP tests (`supabase test db`): RLS, grants and `save_app_state()` (`rls.test.sql`); allowlist flags, `my_access()`, the key vault, backup scrubbing (`access.test.sql`); run as `anon`/`authenticated`; CLI config (Postgres 17). |
| `supabase/templates/magic_link.html` | Magic Link email body with the one-time code (paste into the Dashboard; needs custom SMTP). |
| `.github/workflows/migrations.yml` | Validate + apply migrations. |
| `docs/listing-pipeline.md` | **Design doc** for the sync pipeline. Read for the "why". |
| `supabase/README.md` | How to apply migrations + CI secrets. |
| `.env.example` | Every env var, documented. |
| `vercel.json` | Build, function `maxDuration`s, the daily cron, security headers (CSP etc.), SPA rewrite (not for `/api/*`). |

**Do NOT load into context (generated / vendored / noise):**

- `node_modules/` — vendored dependencies (gitignored). Never read.
- `dist/` — Vite build output (gitignored); `dist/assets/index-*.js` are minified
  bundles. Never read; rebuild instead.
- `package-lock.json` — generated lockfile (~36K). Only consult for a specific
  dependency version; never read in full.
- `public/` — static assets (favicon, Home Screen icons + `manifest.webmanifest`),
  plus `public/demo/` (the demo fixture — generated; read `snapshot.json` only
  to debug the demo, never the thumbnails).

There is **no generated source** in `src/` or `api/` — it's all authored by hand.

## Architecture (quick)

See `docs/listing-pipeline.md` for the full design. In short:

- **State model:** the whole app state (`profiles`, `criteria`, `globalReqs`,
  `listings`, `candidates`, `settings` {budget, taxRate, tagline, homeBase, saltMode, …}, `skipped`,
  `scoreModel`, `autoScore`, `onboarded`, `version`, `lastSynced`) is one JSONB
  blob per user in `app_state.data`. `storage.js` reads/writes it; `App.jsx`
  holds it in `data` and saves via `save()` / `saveRecalc()` / `patchListings()`.
  Writes go through a serialized queue (`persist`) to `save_app_state(data,
  expected_rev)`, which writes only if the stored `rev` still matches; on a
  conflict the session reloads the stored version (`applyRemote`) and says so.
  **Realtime:** the session also subscribes to its own `app_state` row
  (`watchState`); a newer `rev` from another device reloads the same way
  (only `rev` is read from the payload, then `storage.get`). The scheduled
  sync and Backups restore write with the service role and bump `rev`, so open
  sessions pick those up too.
  There is no per-listing table. Bump `VERSION` + add a `migrate()` step when the
  blob shape changes (see the v6 `settings` migration).
  The candidate **review queue** is in the blob too (`data.candidates`, newest
  300): restored on load minus VINs since approved/skipped (`restoreQueue`), and
  saved ~1 s after it changes. The scheduled sync appends to it (flagged
  `fromScheduled`, counted for a notice on next open).
- **Settings keys:** `DEFAULT_SETTINGS` (top of `App.jsx`) is the schema — one
  commented line per key. A new optional key only needs a line there
  (`getSettings()` merges defaults on read), not a `VERSION` bump. Settings
  edits don't flag AI scores stale: `scoreInputHash` reads only `homeBase` from
  settings. The scheduled sync spreads `state.settings`, so new keys survive it.
- **Where preferences live:** anything the user sets (layouts, filters' defaults,
  the review queue) goes in the synced blob so every device agrees — the owner
  asked for this explicitly. `localStorage` is only for throwaway per-device state.
- **AI scoring:** `src/score.js` → `POST /api/ai { task: "score" }` decrypts the user's vaulted
  Anthropic key (`api/_keys.js`) and scores each listing against a
  JSON schema built from the user's criteria (`_scoring.js`, model allowlisted).
  Roles/categories are freeform; budget/home base live in `data.settings`.
- **Auth + allowlist (server-enforced):** sign-in is invite-only (the client
  never creates users — `shouldCreateUser: false` — and the project has
  sign-ups off; admins invite from the Admin tab). `api/_auth.js` also requires
  the email be in the `allowed_emails` table (`my_access()` RPC, which also says
  whether they're an admin) — there is no env-var allowlist. RLS on `app_state`
  enforces the same at the data layer (`is_allowed()`). The UI calls `GET /api/me`
  and shows a friendly screen for non-allowlisted users (fails open on error —
  RLS/API are the real boundary).
- **Sync pipeline:** `src/syncPlan.js` plans it; `src/sync.js` → `POST
  /api/marketcheck` per step (proxy holding `MARKETCHECK_API_KEY`) → MarketCheck
  `/v2/search/car/active`, **nationwide, one search per active profile**, salt-belt
  states excluded via `state=` (or flagged — Settings) → `normalize()` →
  `reconcile()`. New VINs become **candidates** (human-approved, same as Import);
  known VINs get price-change notes + `lastSeen`; a watchlist VIN the direct VIN
  lookup can't find is stamped `goneAt`. Manual only — the **↻ Sync** button on
  the Results tab (a full refresh of every active profile) — plus the optional
  daily scheduled sync (`api/cron-sync.js`, cheap path). No sync on app open.
- **All MarketCheck-specific field/param names live in `buildUrl()` and
  `normalize()` in `api/marketcheck.js`** — if the API shape is wrong, that's the
  only place to change.
- **API version is pinned** (`x-version`, `API_VERSION` in `api/marketcheck.js`,
  `v4.8.0`). Every response's
  `served-by-version` / `deprecation` / `sunset` headers are stored in
  `settings.mcApi`; the app shows a banner within 60 days of sunset, if a different
  major version answers, or if the pin is rejected (sync then retries unpinned).
  A sync where most rows lack VIN/make/model is flagged as a format change rather
  than silently dropping listings. To move versions: update `normalize()` /
  `buildUrl()` + the fixture, then bump `API_VERSION`.

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

**Tests:** Vitest tests live in `test/` — unit tests for every pure module
(`*.test.js`) and jsdom render tests (`*.render.test.jsx`) for UI flows; see
`test/README.md` for the layout, the full-App harness, and jsdom's gaps. The
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
| `MARKETCHECK_API_KEY` | server only (optional) | Shared MarketCheck key — used only for accounts with no keys of their own in Settings; ignored entirely once a user has any (never a fallback). **Never** `VITE_`-prefixed. The MarketCheck host, radius, throttle and time budgets are constants in `api/marketcheck.js`. |
| `SUPABASE_SECRET_KEY` | server only | Supabase Secret key (`sb_secret_…`); service-role access to the server-only tables (allowlist, key vault, backups). |
| `KEY_ENCRYPTION_SECRET` | server only | ≥16 chars; the stored API keys' encryption secret (HKDF → AES-256-GCM). Rotating invalidates them. |
| `CRON_SECRET` | server (optional) | ≥16 chars; authorizes the daily `/api/cron-sync` (Vercel Cron Bearer token). Unset = scheduled sync off. Which accounts it syncs is `allowed_emails.scheduled_sync`. |
| `SUPABASE_DB_URL` | GitHub Actions secret | Session-pooler URL for CI `db push`. |

That's all of them: who may use the app, who is an admin, and who gets the
daily sync are rows in `allowed_emails`, not env vars.

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

## UI patterns (reuse these)

- **Tabs** (`TABS` in `App.jsx`): Dashboard, Profiles (profile editor `ProfEd`:
  search fields, then `TrimChips` / `DrivetrainChips` / `ColorFilter` chips),
  Criteria, Results (candidates `CandCard`, watchlist `LCard`), Compare
  (sortable table; rows open the card), Price, Settings, Help — plus Admin for
  admins.
  User-facing changes get a line in `HelpTab`.
- **Modals:** fixed backdrop (`zIndex: 200`) that closes on `onMouseDown`, inner
  dialog stops propagation, Escape closes via a `keydown` listener —
  `QuotaModal`, `ListingModal`.
- **Listing cards:** `cardProps(listing, ctx, stale, criteriaStale)` builds
  `LCard`'s props from the App's handlers, so any view can show the Results card.
- **Toggles keep their size:** render `<Check on={…} />` instead of a
  conditional "✓ ", and `<Swap labels={["On", "Off"]} show={i} />` instead of a
  conditional label (it sizes to the longest), so nothing beside the button
  shifts; keep border widths constant between states.
- **Demo mode** (`DEMO` from `src/demoRuntime.js`): `storage.js` swaps in an
  in-memory store, so edits just work and vanish on reload — keep persisting
  through `save()`. Every `/api` request is answered locally with a 403; give a
  new endpoint a message in `BLOCKED` (`demoRuntime.js`). Hide owner-only
  chrome with `!DEMO` (quota gauge, Backups, Debug raw). The snapshot is
  published by admins via `POST /api/snapshots { demo }` into
  `public.demo_snapshot` (anyone can read; only the service role writes) —
  served at `/?demo=live`. Plain `/?demo` loads the bundled fixture
  (`public/demo/snapshot.json`), falling back to the live row.
- **Tutorial targets:** a step spotlights the first `[data-tour="…"]` element
  (profile, add-profile, criteria, candidates, sync, cand-card, score,
  watch-card, filters, compare, price, quota, banner). Keep those attributes
  when reworking a view; a missing target just skips its step.
- **New profiles** go through `ProfileWizard` ("+ Add"; "start from a blank
  profile" keeps the old path). Its Explore is `refreshProfileFacets(p,
  { quotaOnly: true })`; create stores the facets in `mcProfiles` and then runs
  the normal count (caps changed).
- **Sortable tables:** `sortRows` / `nextSort` / `sortIndicator` + the `cs-sort`
  class (Compare, Price Check comps).
- **Touch / iOS Home Screen:** the owner uses it as an iPhone web app. Inputs are
  16px on coarse pointers (no zoom). HTML5 drag-and-drop doesn't work with touch,
  and neither did pointer events on a `touch-action: none` grip — iOS scrolled
  the table instead. React's touch handlers are passive (can't `preventDefault`),
  so a touch drag needs native `addEventListener("touchstart"/"touchmove", …,
  { passive: false })` (Compare's `gripRef`), plus a tap-based fallback (tap the
  grip, then the target). Sticky columns must leave room to scroll on a phone
  (Compare caps pins at 70% of the table's width).

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
   - `No MarketCheck API key` → the account has no keys in Settings **and** `MARKETCHECK_API_KEY` is unset for that Vercel env.
   - HTTP 401/403 → bad key or the plan lacks the active-search endpoint.
   - HTTP 4xx on every query → wrong host/param (it's `api.marketcheck.com`,
     `year` as an exact-year CSV, `price_range`/`miles_range`, `state` CSV).
4. To exercise the full candidate/approve flow **without** the API or key, the
   proxy supports `?mock=1` (synthetic listings).

### Probing MarketCheck live
Every call is billed against the key's 500/month free quota — errors, 404s and
`rows=0` counts included — and there is no free endpoint that reports the
quota (it's only learned from the `quota-*` headers of real calls). Ask the
owner before spending calls, keep probes to one or two, and never commit a key.
`?mock=1` costs nothing. What's already verified live is listed in
`docs/listing-pipeline.md` §2–3 — check there before re-probing.

### Serverless function count
Every non-underscore file in `api/` is its own Vercel function (8 today — the four AI endpoints were merged into `api/ai.js`).
Vercel's Hobby plan has capped deployments at 12 functions — check the current
limit before adding more. Put shared code in `api/_*.js`, and prefer a new mode
on an existing endpoint over a new file once that's close. Functions
that call Anthropic or page MarketCheck need a `maxDuration` entry in
`vercel.json`.

### Headless / agent debugging (no email login)
There is no token bypass (the old `DEBUG_TOKEN` was removed): every `/api` call
needs a real, allowlisted Supabase session. For headless use, create a
dedicated password user with the service role
(`auth.admin.createUser({ email, password, email_confirm: true })`), add its
email to `allowed_emails`, sign in with `signInWithPassword`, and send the
access token as the Bearer token:
```bash
curl -X POST "$SITE/api/marketcheck?mock=1" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"full","profile":{"id":"rav4-hybrid","name":"RAV4 Hybrid","params":{"make":"Toyota","model":"RAV4","powertrain":"Hybrid","years":"2019-2022","maxPrice":25000,"maxMiles":90000}}}'
```
`?mock=1` costs nothing; `?raw=1` makes one real (billed) call. Remove the
user's `allowed_emails` row to revoke.

### Auth / allowlist
- `401` from `/api/*` = not signed in / missing-invalid token. `403` = signed in
  but not allowlisted.
- Allowed if the email is in the `allowed_emails` table (any letter case) —
  manage it from the Admin tab. Admin = `is_admin`.
- Someone with no account who asks for a sign-in email gets "invite-only" back
  (`isNoAccount` in `Auth.jsx`); invite them from the Admin tab.
- A signed-in account not on the list sees the "Access not enabled" screen.

### Data not loading / saving
- `storage.js` operates as the logged-in user; RLS requires `auth.uid() =
  user_id` **and** `is_allowed()`. If a legit user sees empty data after the
  allowlist migration, confirm their email is a row in `allowed_emails`.
- Storage errors are caught and logged (`console.error("storage.* error")`) and
  return `null` — check the console.

### Migrations
- Validate locally the same way CI does (needs Docker): `supabase db start`
  (the CLI's Postgres 17 with the real `auth` schema; applies every
  migration), re-apply each `supabase/migrations/*.sql` with `psql` against
  `postgresql://postgres:postgres@127.0.0.1:54322/postgres` (idempotency),
  then `supabase test db`. A new table, policy or database function gets
  pgTAP checks in `supabase/tests/` (keep `plan(n)` in step).
- New tables: Supabase grants every new `public` table to `anon` and
  `authenticated`. A server-only table also gets `revoke all … from anon,
  authenticated` (not just RLS with no policies). In policies, write
  `(select auth.uid())`, not `auth.uid()`, so it runs once per statement.
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

## Merging

`main` has a ruleset requiring the **`test`** check (the `npm test` + `npm run
build` workflow), and the repo allows **auto-merge**. Open the PR, enable
auto-merge (squash) on it, and move on — GitHub merges once `test` passes, and
red CI can't merge. The owner merges freely — no need to ask. After a squash
merge, start follow-up work from the new `main` (the old commits aren't
ancestors of it). Don't make the migrations `validate` check required: it only
runs on some PRs, so others would wait on it forever.

## Deploy

Vercel builds from `main` (`npm run build` → `dist/`). Functions run in `cle1`
(Cleveland, `regions` in `vercel.json`), next to the Supabase project in AWS
us-east-2; keep the two in the same region. The SPA rewrite in
`vercel.json` sends non-file routes to `index.html`, except `/api/*` (an
unknown API path is a 404, not the app's HTML). Every response gets the
headers in `vercel.json`: a Content-Security-Policy (scripts from this origin
only; `connect-src` this origin + `*.supabase.co`; images from any `https:`
host, for dealer photos; Google Fonts), `frame-ancestors 'none'`, `nosniff`,
and a Referrer-Policy. A new external script, API host or font source needs a
CSP change there. DB migrations auto-apply via CI on merge to
`main`.
