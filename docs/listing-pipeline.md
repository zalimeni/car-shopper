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

## 3. Architecture — sync-on-open

Reconciliation runs **in the browser while the user is logged in**, so all
writes go through the normal Supabase session + RLS. The serverless function is
a thin proxy that holds only the MarketCheck key.

```
App opens (user authenticated)  ──or── "Sync now" button
   └─> GET /api/marketcheck       (Vercel serverless function, Node)
         For each ACTIVE profile × each hub (Boston 02101, Durham 27701 @ radius):
           # radius = MARKETCHECK_RADIUS, default 100mi (free-tier cap); raise on a paid plan
           query MarketCheck /v2/search/car/active  (paginate)
         → return normalized listings (§5)        [holds MARKETCHECK_API_KEY only]
   └─> Browser (authed) reconciles vs. stored listings (§6)
   └─> Browser writes the updated app_state blob via the user's session (RLS)
```

**No service-role key anywhere.** The only server-held secret is the MarketCheck
data key (unrelated to the user's accounts). The cost of this approach: listings
refresh only when the app is open (plus the manual "Sync now" button) — not
unattended. See §4 for the background-cron variant that lifts that limitation.

## 4. Runtime & secrets

- **Where:** one Vercel serverless function `api/marketcheck.js` (the proxy).
  No cron in v1.
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
- **Why no service-role key:** that key bypasses RLS and would only be needed by
  a *sessionless* background job. Sync-on-open always has a session, so it
  doesn't need it. Keeping it out means there is no RLS-bypassing credential
  anywhere in the system.
- **Auth note (for the deferred LLM phase):** Anthropic has no third-party
  consumer OAuth; programmatic access is API-key / Workload Identity Federation,
  both server-side. When we add enrichment, the clean path is a small server
  endpoint holding the Claude key, gated behind the existing Supabase login —
  no browser-exposed key, no copy-paste.

### 4a. Follow-up: background cron + email-on-update (planned)

A later phase adds unattended refresh so new matches arrive without opening the
app. This is the piece that *does* need elevated server credentials:

- Vercel Cron → `POST /api/sync` (shared `CRON_SECRET` so only cron can call it).
- The function loads/writes the user's row with `SUPABASE_SERVICE_ROLE_KEY`
  (server-side only) — because cron has no user session — scoped to `SYNC_USER_ID`.
- On *newly discovered* candidates (or notable price drops), send an email
  (e.g. Resend/Postmark) summarizing the matches + links.
- The reconcile logic from §6 is shared between the client (sync-on-open) and
  this function, so it isn't rewritten.

Shipped only after sync-on-open is solid; it's strictly additive.

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
- **Watched VIN absent from results** → **non-destructive flag only** (v1):
  `lastSeen` is left unchanged so the card shows "Last seen in sync: <date> (may
  be sold)". No status change, no deletion. Auto-marking `sold` is deferred to
  the §4a follow-up. Manual listings (no `source: "marketcheck"`) are never
  touched by reconcile.

Reuses the existing `dedupInsert` (lowest-price-wins on VIN) and `daysSince`
staleness logic. Provenance: tag pipeline-created listings with
`source: "marketcheck"` so manual entries are left untouched.

## 7. Data model decision

**Keep the single JSON-blob model (`app_state.data`) for v1.** Reconcile does a
read-modify-write of the blob and reuses all current array logic (`dedupInsert`,
`daysSince`, `calcScore`). Minimal additions:

- **No new persisted "candidate" status.** New VINs flow into the existing
  in-memory candidate queue — the same review path as Import (`CandCard`,
  `approveCand`/`approveAll`). Unreviewed matches aren't persisted; because
  sync-on-open re-runs each visit, anything still on the market simply
  re-surfaces. Only *approved* listings are written (as `watch`).
- New fields on synced listings: `source: "marketcheck"`, `lastSeen` (date last
  present in a sync), and `dom` (days on market, shown in notes). A
  `lastSynced` timestamp on the root blob drives the sync-on-open debounce.

Normalized per-listing tables (`listings`, `price_history`) remain a backlog
item, justified only if the blob gets large or we want real query history.

## 8. UI changes (shipped in v1)

- Results tab: a **↻ Sync** button + a status line (`SyncStatus`) summarizing the
  last run (new / price-changes / not-seen / query errors), and "Last synced
  <ago>" when idle.
- Sync-on-open: auto-runs once per load if it's been > `AUTO_SYNC_HOURS` (12)
  since `lastSynced`; quiet on error for the background run.
- `LCard` shows the `lastSeen` line for `marketcheck` listings (amber "may be
  sold" when it's not today's date). Price changes append a note via reconcile.

## 9. Cost, limits, failure modes

- **Requests/run:** active profiles (≤5) × 2 hubs × pages — low tens of requests
  per sync. Sync-on-open could fire often, so **debounce** (skip if synced within
  the last N hours) to stay within trial/low-tier limits. Confirm MarketCheck
  rate limits + per-request cost.
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

- **Background cron + email-on-update** — planned follow-up, designed in §4a.
  Needs the service-role key + a `CRON_SECRET`; shipped after sync-on-open.
- FB Marketplace / private-party sourcing (buyer prefers dealers).
- LLM enrichment (auto-scoring, history summaries, dealer-question drafting) —
  deferred; will be a separate, server-gated phase (§4 auth note).
- Normalized listing tables and realtime cross-device sync.

## 12. Open questions

1. Confirm MarketCheck auth mechanism, exact param names, response schema, and
   trial limits against the live API.
2. Auto-purge aggressiveness — mark `sold` after one absent run, or require two
   consecutive misses to avoid flapping on transient inventory gaps?
3. (Follow-up §4a) Email provider for update alerts — Resend vs. Postmark vs.
   Supabase's built-in — and what threshold triggers a send (any new candidate?
   price drop ≥ X%?).

*Resolved:* v1 trigger is sync-on-open + a "Sync now" button (no service-role
key). Unattended refresh + email moves to the §4a follow-up.
