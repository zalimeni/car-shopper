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

- **Endpoint:** `GET https://mc-api.marketcheck.com/v2/search/car/active`
- **Auth:** API key (passed as `api_key` query param — *confirm against live
  docs*). Server-side only.
- **Filtering:** 100+ params; the ones we need —
  `make`, `model`, `year` (range via `year_range` or min/max), `price` (max),
  `miles` (max), `latitude`+`longitude`+`radius`, `car_type=used`,
  `seller_type=dealer`, pagination (`start`/`rows`).
- **Response (per listing, fields to confirm):** `vin`, `price`, `miles`,
  `dom` (days on market), `dealer` (name, type), `inventory_type`/`seller_type`,
  `vdp_url` (listing URL), plus `build` (year/make/model/trim), `exterior_color`,
  city/state.
- **Cost:** paid; free trial tier to start. Pricing per request — see §9.

> ⚠️ Field/param names above are from the public docs summary and **must be
> verified against the live API** during implementation; the normalization
> layer (§5) is the single place that depends on them.

## 3. Architecture

```
Vercel Cron  (schedule: every 3 days, < the 5-day staleness threshold)
   └─> POST /api/sync                      (Vercel serverless function, Node)
         1. Load the user's app_state blob from Supabase (service-role key)
         2. For each ACTIVE profile × each hub (Boston 02101, Durham 27701 @ 400mi):
              query MarketCheck /v2/search/car/active  (paginate)
         3. Normalize each result → app listing shape (§5)
         4. Reconcile against existing listings (§6)
         5. Write the updated blob back to Supabase
   └─> User reviews new candidates in the existing Results tab
```

Everything runs **server-side**. No secret ever reaches the browser.

## 4. Runtime & secrets

- **Where:** Vercel serverless function `api/sync.js` + a `vercel.json` cron
  entry. (Vercel Cron calls the function on a schedule.)
- **Secrets (Vercel env vars only — never committed, never shipped to client):**
  - `MARKETCHECK_API_KEY` — the aggregator key. A data-API credential, fully
    separate from the user's personal Anthropic/Claude account.
  - `SUPABASE_SERVICE_ROLE_KEY` — lets the function read/write the user's row
    without a logged-in session (cron has no user session). Bypasses RLS, so
    server-side only.
  - `SUPABASE_URL` — already known.
  - `SYNC_USER_ID` — the single user's `auth.users` id to scope writes to
    (single-user tool; avoids guessing).
  - `CRON_SECRET` — shared secret so only Vercel Cron can invoke `/api/sync`.
- **Auth note (for the deferred LLM phase):** Anthropic has no third-party
  consumer OAuth; programmatic access is API-key / Workload Identity Federation,
  both server-side. When we add enrichment, the clean path is a small server
  endpoint holding the Claude key, gated behind the existing Supabase login —
  no browser-exposed key, no copy-paste.

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

Profile → query mapping: `make`, `model`, `year` range, `maxPrice`, `maxMiles`
come straight from `profile.params`; hub zip → `latitude`/`longitude` (geocode
the two fixed hubs once) + `radius=400`.

## 6. Reconciliation

Per sync run, build a set of discovered VINs and compare to stored listings:

- **New VIN** (not in store) → append with `status: "candidate"`, `addedDate`,
  `lastChecked = today`. Awaits human approval (existing candidate UI).
- **Known VIN, price changed** → update `price`, append a note
  (`"Price: $X → $Y on <date>"`), refresh `lastChecked`. Keep its status
  (watch/candidate) and `compositeScore` (recomputed).
- **Known VIN, unchanged** → refresh `lastChecked` only.
- **Watched/candidate VIN absent from results** → mark `status: "sold"` (new
  terminal state) rather than deleting, so history is retained. Manual listings
  (no VIN, or `source: "manual"`) are **never** auto-purged.

Reuses the existing `dedupInsert` (lowest-price-wins on VIN) and `daysSince`
staleness logic. Provenance: tag pipeline-created listings with
`source: "marketcheck"` so manual entries are left untouched.

## 7. Data model decision

**Keep the single JSON-blob model (`app_state.data`) for v1.** The function does
a read-modify-write of the blob and reuses all current array logic. Two small
changes:

- Persist discovered listings with `status: "candidate"` (today candidates live
  only in React state) so review survives across sessions; `App.jsx` renders
  persisted candidates in addition to in-memory import candidates.
- Add a `"sold"` status and a `source` field.

Concurrency: single-user, infrequent cron → last-write-wins is acceptable; guard
with the row's `updated_at` (re-read and merge if it changed mid-run). Normalized
per-listing tables (`listings`, `price_history`) remain a backlog item, justified
only if the blob gets large or we want real query history.

## 8. UI changes (minimal)

- Results tab: show persisted candidates (currently only in-memory ones show).
- A "Last synced: <date>" line + manual "Sync now" button (calls `/api/sync`
  with the secret, or a thin authed wrapper).
- Surface price-change notes and the `sold` state in `LCard`.

## 9. Cost, limits, failure modes

- **Requests/run:** active profiles (≤5) × 2 hubs × pages. With ~5 profiles and
  modest result counts, low tens of requests every 3 days — comfortably within
  trial/low-tier limits. Confirm MarketCheck rate limits + per-request cost.
- **Partial failure:** if a profile query fails, skip it and continue; never
  purge based on an incomplete run (only purge VINs for profiles whose query
  succeeded this run).
- **Idempotent:** reconciliation is safe to re-run; VIN dedup prevents dupes.

## 10. Rollout / testing

1. Verify MarketCheck auth + response shape against the live API (adjust §5).
2. Implement `/api/sync` with a `dryRun` mode that returns the diff without
   writing — validate mapping/reconcile against real data.
3. Wire Vercel Cron + env vars; run once manually via "Sync now".
4. Enable the schedule once a dry run looks right.

## 11. Out of scope / deferred

- FB Marketplace / private-party sourcing (buyer prefers dealers).
- LLM enrichment (auto-scoring, history summaries, dealer-question drafting) —
  deferred; will be a separate, server-gated phase (§4 auth note).
- Normalized listing tables and realtime cross-device sync.

## 12. Open questions

1. Confirm MarketCheck auth mechanism, exact param names, response schema, and
   trial limits against the live API.
2. Sync cadence — default every 3 days; acceptable?
3. "Sync now" trigger — simple shared-secret endpoint, or gate behind the
   Supabase session?
4. Auto-purge aggressiveness — mark `sold` after one absent run, or require two
   consecutive misses to avoid flapping on transient inventory gaps?
