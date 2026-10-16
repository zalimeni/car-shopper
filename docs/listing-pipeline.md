# Design: Automated Listing Pipeline (dealer inventory via aggregator)

Status: **Draft for review** · Owner: @zalimeni · Scope: dealer-only acquisition

## 1. Goal

Replace the manual JSON import with an automated loop that keeps the watchlist
current with **dealer** inventory:

- **Discover** new listings matching the active vehicle profiles.
- **Refresh** price and availability on listings already being watched.
- **Purge** listings that have sold or been removed.

All output flows into the existing validation → candidate-approval → VIN-dedup →
staleness machinery, so the human-in-the-loop review stays exactly as it is
today. Facebook Marketplace / private-party sources are explicitly **out of
scope** (buyer prefers dealers).

## 2. Data source: MarketCheck

No consumer site (CarGurus, Cars.com, Carvana, CarMax) offers a public listings
API, and self-scraping is fragile + against ToS. We use **MarketCheck**, an
automotive-listings aggregator covering US/Canada dealer inventory.

Verified against the live API (free plan, Oct 2026) — what an agent would
otherwise have to spend calls rediscovering:

- **Endpoints:** `GET https://api.marketcheck.com/v2/search/car/active`
  (search, VIN lists, counts, facets) and `/v2/decode/car/neovin/{vin}/specs`
  (VIN decoder: factory exterior color with a confidence; no build date). No
  CARFAX / history access.
- **Auth:** `api_key` query param. The proxy redacts it from every debug output.
- **Version pin:** an `x-version` request header (`v4.8.0`); responses carry
  `served-by-version` / `requested-from-version` / `auto-upgraded-version` and
  `deprecation` / `sunset`. An unknown version is rejected (the proxy retries
  unpinned and the app shows a banner).
- **Params we rely on:** `make`, `model`, `year` (exact-year CSV), `price_range`,
  `miles_range`, `car_type=used`, `state` (CSV), `vin` (CSV, ≤50), `sort_by` +
  `sort_order` (`dos_active` = days at this dealer), `start`/`rows` (≤50 per
  call), `rows=0` + `facets=base_exterior_color` (counts per base color in one
  call). `facets` takes a list — one call returns `base_exterior_color`,
  `version` and `drivetrain` together — and `stats=price,miles` returns min/max/
  mean/median and percentiles (5…99) of the match set on the free plan (for the
  planned profile wizard's suggested caps). Each facet lists at most 20 values.
  No location at all = nationwide (rows still carry dealer lat/lon; no
  `dist`). Radius > 100 mi is rejected on the free plan.
- **Trim fields:** `build.trim` is the clean grade ("Limited", 7 for Outback
  2020–22); `build.version` is finer and is what we store and show ("Limited XT",
  "SEL Convenience HEV AWD") — only it separates turbo / drivetrain / powertrain
  variants. `version` is `"-"` when absent (every Outback Base) → fall back to
  `trim`. `build.drivetrain` is `4WD` / `FWD` / `RWD`; AWD reports as `4WD`.
- **Row fields we read:** see `normalize()` — notably `base_ext_color`
  (normalized base color; missing on some marketplace-relayed rows) beside the
  dealer's marketing `exterior_color`, `dos_active` (days at this dealer; `dom_active` fallback), `vdp_url`, `dealer.*`.
- **Quota:** free plan = 500 calls/month per key, 5 requests/second, and a
  500-row pagination ceiling per query. **Every call is billed** — errors,
  `rows=0` counts and decodes included. Each response carries `quota-limit`,
  `quota-remaining` and `quota-reset-time`; there is no free "check my quota"
  call, so the app only learns the quota from real calls (`src/quota.js`).
  `quota-reset-time` looks like `2026-11-01 00:00:00 UTC` — **not** ISO, and
  Safari's `Date` can't parse it; always go through `parseMcTime`/`isoMcTime`.
- **429 is ambiguous:** it's both the per-second throttle (retry after a moment)
  and a spent month. The proxy treats it as spent only when `quota-remaining`
  is 0, `Retry-After` ≥ 1 h, or the body mentions the monthly quota; 402 is
  always spent (`readQuota`).

## 3. Architecture — nationwide sync

Reconciliation runs **in the browser while the user is logged in**, so all
writes go through the normal Supabase session + RLS. The serverless function is
a thin proxy that holds only the MarketCheck key. There is no sync on app open:
the **↻ Sync** button, plus the optional daily scheduled sync (§4a).

Every MarketCheck call is billed (errors and 304s too), and every 50 cars is a
call. So the plan (`src/syncPlan.js`, shared by the browser and the scheduled
sync) does as little as it can:

```
↻ Sync button (manual)  ──or── daily scheduled sync (automatic)
   1. Each ACTIVE profile → ONE nationwide search (no location), its own filters
      (merging profiles widens filters nationwide: 6 merged = 7,824 cars vs 67 alone)
      salt-belt dealers left out via state=<the other states> (src/regions.js),
      unless Settings says to flag them instead.
        FULL refresh — every matching car. Due when never run, 3+ days since the
          last one, the profile's search filters (or salt/franchise settings)
          changed, or on a manual Sync. Catches older listings that newly match
          (a price drop under the cap). Over the 500-row ceiling the state list
          is halved until each part fits; one state still too big reads its
          newest 500 and says so.
        else NEW LISTINGS — sort_by=dos_active asc (days at THIS dealer, so a
          relisted car counts as new), stop once a page reaches cars listed more
          than <days since the profile's last search> + 1 ago. Usually one call.
   2. Watchlist VINs (status watch, from MarketCheck) that step 1 didn't return →
      vin=<up to 50, comma-separated> lookups. A VIN the lookup doesn't return
      either is no longer listed: the ONLY way a car is marked gone (goneAt), so
      it's never a guess from a search that simply didn't include it.
   3. Cars with no color in their listing (often marketplace-relayed) → NeoVIN, the
      VIN decoder (/v2/decode/car/neovin/{vin}/specs; free plan, one call per VIN,
      no batch form): its factory exterior color fills color/baseColor (marked
      colorSource "neovin"). At most 10 a sync; each VIN decoded once ever —
      settings.mcColors remembers the answer, "none" included (90 days, ≤1,000).
      Verified live: KM8JCCD10RU198791 → "Shimmering Silver Metallic" (Silver, 0.8).
      NeoVIN has no build date.
   One /api/marketcheck request per step (POST { kind, profile, since, vins, … }),
   each its own function invocation, clear of the 60 s limit.
   Keys: requests carry spentKeys (from the stored quota and earlier steps), so the
   server starts on the first key with calls left. A failover is a notice.
   → normalized listings (§5)                      [holds MARKETCHECK_API_KEY only]
   └─> Browser (authed) reconciles vs. stored listings (§6), goneVins included
   └─> settings.mcProfiles[id] = { fullAt, lastAt, sig, count, countSig, countAt }
   └─> Browser writes the updated app_state blob via the user's session (RLS)
```

All verified live on the free plan (Oct 2026): no-location searches (dealer
coordinates on every row, no `dist`), `state=` and `vin=` lists, `sort_by=dos_active`,
and `rows=0` counts (one call, no paging — the profile card's "check now").

**Cost.** A profile's match count comes back with every search, so the profile
card shows it and warns past 300 (narrow price/miles/years). Typical: a
new-listings pass is ~1 call per profile, the watchlist lookup ~1, and a full
refresh one per 50 matching cars — a few calls a sync for small profiles.

**Colors, trims, drivetrains — filtered on our side.** Each listing keeps MarketCheck's normalized
`base_ext_color` as `baseColor` (some listings, often marketplace-relayed, have no
color at all — shown as "Color not listed"). A profile's hidden colors and its
"include cars with no color listed" switch (default on) hide candidates locally,
like trim excludes, so an unexpected or missing color is never silently dropped by
the search. The editor's color list comes from a `facets=base_exterior_color` on a
rows=0 count (verified live to list every base color — Outback: 11, Purple: 1),
taken when a profile is saved with new search filters (1 call) and refreshed by
every full refresh (the facet rides on its page 1 — no extra call). Trims
(`version`) and drivetrains ride on the same call and work the same way
(`src/trims.js`): chips with counts, hidden ones filtered locally, preferred (★)
trims fed to AI scoring. Because a facet lists at most 20 values, the trim chips
also offer any trim seen on the profile's synced cars.

**Travel flags, not filters.** Nothing is filtered on distance (a far car can be
shipped). `src/travel.js` flags each listing from the dealer's coordinates:
straight-line miles from the home base ("ship or fly" past 500), the nearest
major airport (`src/airports.js`, "fly-in friendly" within 50 mi), and a
salt-belt state. Cards show them; AI scoring gets them as facts.

**No service-role key anywhere.** The only server-held secret is the MarketCheck
data key (unrelated to the user's accounts). Unattended refreshes come from the
optional scheduled sync (§4a), which runs the same plan server-side.

## 4. Runtime & secrets

- **Where:** `api/marketcheck.js` (the proxy, one sync step per request) and
  `api/cron-sync.js` (the optional daily scheduled sync, §4a).
- **Secrets (Vercel env vars only — never committed, never shipped to client):**
  - `MARKETCHECK_API_KEY` — the aggregator key. A data-API credential, fully
    separate from the user's personal Anthropic/Claude account. **This is the
    only server-held secret.**
  - `ALLOWED_EMAILS` (optional) — comma-separated allowlist; always applies, in
    addition to the DB table. See "Access control" below.
- **Access control (two layers, allow if EITHER source grants):**
  - **Data layer (`supabase/migrations/*_user_allowlist.sql`):** RLS on `app_state` requires both
    `auth.uid() = user_id` *and* `public.is_allowed()`. The `public.allowed_emails`
    table backs `is_allowed()`; non-allowlisted accounts can sign up but can't
    read or write any data.
  - **API layer (`api/_auth.js` → `authorize()`):** the sync proxy requires a
    valid Supabase token and is allowed if the email is in `ALLOWED_EMAILS` **or**
    the DB table (`is_allowed()` RPC). The browser attaches its session token
    (`Authorization: Bearer`) on every sync; 401 = not signed in, 403 = not
    allowlisted. Note: the env list grants the API, but not DB rows — to also
    read/write data, an email must be in the `allowed_emails` table (or be added
    to both).
  - **Friendly screen:** `AuthGate` calls `GET /api/me` after login; a 403
    renders a "not authorized" screen (with sign-out) instead of an empty app.
    This is UX only — it fails open on errors since RLS/the API are the real
    boundary.
  - Magic-link signup stays open to anyone, so the allowlist — enforced
    server-side in the DB and the proxy, never in the client — is what protects
    both the data and the MarketCheck quota.
- The browser keeps using the existing **anon key + Supabase session** to read
  and write `app_state`; RLS continues to enforce that the user only touches
  their own row. The reconcile logic (§6) moves client-side.
- **Service-role key:** the in-app sync never needs it (it has the user's
  session). Only the sessionless paths hold `SUPABASE_SECRET_KEY`: the Anthropic
  key vault and the scheduled sync (§4a).
- **Auth note (for the deferred LLM phase):** Anthropic has no third-party
  consumer OAuth; programmatic access is API-key / Workload Identity Federation,
  both server-side. When we add enrichment, the clean path is a small server
  endpoint holding the Claude key, gated behind the existing Supabase login —
  no browser-exposed key, no copy-paste.

### 4a. Scheduled sync (shipped; email deferred)

Unattended refresh so new matches arrive without opening the app:

- Vercel Cron (`vercel.json`, daily 10:00 UTC) → `/api/cron-sync`, gated by
  `CRON_SECRET` (unset = off; the cron then only pings Supabase as a keepalive).
- Runs for the accounts in `CRON_SYNC_EMAILS`, loading/writing each row with
  `SUPABASE_SECRET_KEY` (no user session), compare-and-swap on `app_state.rev`
  so an active app session wins.
- New VINs go onto the synced review queue (`data.candidates`, flagged
  `fromScheduled`); price changes land on the watchlist as an in-app sync would.
- Email on new matches is still deferred (provider + threshold undecided).
- The plan (`src/syncPlan.js`) and reconcile logic (§6) are shared between the
  client and this function, so neither is rewritten. The scheduled sync takes the
  automatic path (full refresh only when due).

## 5. Normalization (MarketCheck → app listing)

The reconciler depends only on this mapping, so API drift is contained here.

| App field      | Source                                  | Notes |
|----------------|-----------------------------------------|-------|
| `vin`          | `vin`                                    | dedup key |
| `vehicle`      | `build.make` + `build.model`             | e.g. "Toyota RAV4 Hybrid" |
| `year`         | `build.year`                             | |
| `trim`         | `build.trim`                             | |
| `price`        | `price`                                  | |
| `mileage`      | `miles`                                  | |
| `dealer`       | `dealer.name`                            | |
| `dealerType`   | `seller_type`/`dealer.dealer_type`       | map → CPO/franchise/independent |
| `location`     | `dealer.city`                            | |
| `state`        | `dealer.state`                           | drives salt-belt 🧂 flag |
| `link`         | `vdp_url`                                | the listing URL |
| `profileId`    | (the profile that generated the query)   | assigned by us, not MarketCheck |
| `color`        | `exterior_color`                         | |
| `status`       | `"candidate"` on first discovery         | see §6 |

Profile → query mapping: `make`, `model`, `year` (exact-year list), `powertrain_type`,
`price_range`, `miles_range` come straight from `profile.params`; no location
(nationwide), `state=` the allowed states. Dealer `latitude`/`longitude` become
`dLat`/`dLon` for the travel flags.

## 6. Reconciliation

Per sync run, build a set of discovered VINs and compare to stored listings:

- **New VIN** (not in store) → append with `status: "candidate"`, `addedDate`,
  `lastChecked = today`. Awaits human approval (existing candidate UI).
- **Known VIN, price changed** → update `price`, append a note
  (`"Price: $X → $Y on <date>"`), refresh `lastChecked`. Keep its status
  (watch/candidate) and `compositeScore` (recomputed).
- **Known VIN, unchanged** → refresh `lastChecked` only.
- **Watched VIN the VIN lookup confirms gone** (`goneVins`) → **non-destructive
  flag only**: `goneAt` is stamped and the Results banner offers to archive it to
  Sold (restorable). A car a search merely didn't return (a new-listings pass, or
  it left the filters) is untouched — only the direct lookup says gone. Manual
  listings (no `source: "marketcheck"`) are never touched by reconcile.

Reuses the existing `dedupInsert` (lowest-price-wins on VIN) and `daysSince`
staleness logic. Provenance: tag pipeline-created listings with
`source: "marketcheck"` so manual entries are left untouched.

## 7. Data model decision

**Keep the single JSON-blob model (`app_state.data`) for v1.** Reconcile does a
read-modify-write of the blob and reuses all current array logic (`dedupInsert`,
`daysSince`, `calcScore`). Minimal additions:

- **No new persisted "candidate" status.** New VINs flow into the existing
  in-memory candidate queue — the same review path as Import (`CandCard`,
  `approveCand`/`approveAll`). Unreviewed matches aren't persisted; a full
  refresh re-surfaces anything still on the market. Only *approved* listings are
  written (as `watch`).
- New fields on synced listings: `source: "marketcheck"`, `lastSeen` (date last
  present in a sync), `goneAt`, and `dom` (days at this dealer). `lastSynced` on
  the root blob drives the "you synced recently" cost warning.

Normalized per-listing tables (`listings`, `price_history`) remain a backlog
item, justified only if the blob gets large or we want real query history.

## 8. UI changes (shipped in v1)

- Results tab: a **↻ Sync** button + a status line (`SyncStatus`) summarizing the
  last run (new / price-changes / not-seen / query errors), and "Last synced
  <ago>" when idle.
- No sync on app open (it spent quota on every visit); the ↻ Sync button warns
  with the cost when the last sync was under 6 hours ago.
- `LCard` shows the `lastSeen` line for `marketcheck` listings (amber "may be
  sold" when it's not today's date). Price changes append a note via reconcile.

## 9. Cost, limits, failure modes

- **Requests/run:** see §3 — one search per active profile (one call per 50
  matching cars on a full refresh, ~1 on a new-listings pass) plus ~1 watchlist
  lookup. Free plan: 500 calls/month per key, 5/second, 500-row pagination ceiling.
- **Partial failure:** if a profile query fails, skip it and continue; never
  purge based on an incomplete run (only purge VINs for profiles whose query
  succeeded this run).
- **Idempotent:** reconciliation is safe to re-run; VIN dedup prevents dupes.

## 10. Rollout / testing

Shipped. Tests: `test/README.md`. To exercise the flow without spending quota,
use the proxy's `?mock=1`; for one live response, the footer's **Debug raw**.

## 11. Out of scope / deferred

- **Email on new matches** — the scheduled sync shipped (§4a); email didn't.
- FB Marketplace / private-party sourcing (buyer prefers dealers).
- LLM enrichment (auto-scoring, history summaries, dealer-question drafting) —
  deferred; will be a separate, server-gated phase (§4 auth note).
- Normalized listing tables and realtime push between open devices (each device
  reads the synced blob on load; concurrent saves resolve by `rev`).

## 12. Open questions

1. ~~Confirm MarketCheck auth, params, schema and limits~~ — done, see §2.
2. ~~Auto-purge aggressiveness — mark `sold` after one absent run, or require two
   consecutive misses to avoid flapping on transient inventory gaps?~~ — neither:
   a car is marked gone only when a direct VIN lookup can't find it (§3).
3. (Follow-up §4a) Email provider for update alerts — Resend vs. Postmark vs.
   Supabase's built-in — and what threshold triggers a send (any new candidate?
   price drop ≥ X%?).

*Resolved:* no sync on app open (it spent quota every visit) — the ↻ Sync
button plus the optional scheduled sync (§4a).
