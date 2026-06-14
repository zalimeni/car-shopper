# car-shopper

Personal used-car search dashboard for tracking a two-car purchase. Built with
React + Vite and deployed to GitHub Pages. State persists locally in the
browser via `localStorage` — there is no backend.

> Vibe-coded with Claude, then cleaned up and deployed.

## Context

Shopping for two used cars with a $40K combined budget:

- **SUV**: 2019–2022 RAV4 Hybrid or 2021–2022 RAV4 Prime (family car, AWD,
  rear-passenger safety priority)
- **Commuter**: 2022–2023 Bolt EUV, 2021–2023 Bolt EV, or 2016/2018 Volt
  (25-mile commute, L2 charging at work)

Search hubs: Boston MA (02101) and Durham NC (27701), 400-mile radius.

## Features

- **Dashboard** — stats, budget pairing calculator, profile quick-links to the
  filtered watchlist, and stale-listing alerts.
- **Vehicle Profiles** — configurable profiles with make/model/year/trim, price
  and mileage ranges, must-haves, and dealbreakers.
- **Global Requirements** — an editable checklist applied to all profiles.
- **Scoring Criteria** — weighted criteria; editing a weight auto-recalculates
  every listing's composite score.
- **Search Queries** — generates per-source, per-hub queries for the active
  profiles to run manually.
- **Results** — filter by profile/role, sort by score/price/mileage, VIN dedup
  (lowest price wins), salt-belt flagging (🧂), reject-with-reason, and
  staleness tracking.
- **Import / Export** — validated JSON import with per-field error reporting and
  an approve/reject candidate flow; one-tap JSON export for backup.

## Getting started

Requires Node 22 (see `.nvmrc`).

```bash
npm install
npm run dev      # http://localhost:3000
```

Other scripts:

```bash
npm run build    # production build to dist/
npm run preview  # serve the production build locally
```

## Deployment

Deployed on **Vercel**. The repo is connected as a Vercel project, so every push
to `main` triggers a production deploy (and pushes to other branches get preview
deployments). Settings live in `vercel.json`:

- `buildCommand`: `npm run build`
- `outputDirectory`: `dist`
- a catch-all rewrite to `index.html` so the single-page app serves on any path

To set up from scratch: in the Vercel dashboard, **Add New Project → Import**
this repo. Vercel auto-detects Vite; no extra configuration is required.

## Auth & data storage

The app is gated by **Supabase email magic-link auth** and stores all state in
Supabase, so your data syncs across devices: sign in with the same email
anywhere and you get the same data.

State is kept as a single JSON blob in one row per user (table `app_state`,
keyed by `user_id`). The `src/storage.js` wrapper exposes an async
`get/set/delete` API over that row. On first sign-in, any data left in
`localStorage` from the earlier localStorage-only version is migrated up
automatically. You can still **Export Listings** for a manual JSON backup and
use the **Import** tab to restore or seed data.

### Supabase setup

The project URL and publishable (anon) key are baked in as defaults in
`src/supabaseClient.js` — these are public by design; data is protected by Row
Level Security. To point at a different project, set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` (see `.env.example`) locally and in Vercel.

For a fresh Supabase project, two one-time steps are required:

1. **Create the table and RLS policy** (SQL editor):

   ```sql
   create table app_state (
     user_id uuid primary key references auth.users(id) on delete cascade,
     data jsonb not null,
     updated_at timestamptz not null default now()
   );

   alter table app_state enable row level security;

   create policy "own row" on app_state
     for all
     using (auth.uid() = user_id)
     with check (auth.uid() = user_id);
   ```

2. **Allow the app's URLs** under Authentication → URL Configuration: set the
   Site URL to the Vercel production URL and add `http://localhost:3000` (and
   any preview URLs) to the redirect allowlist so magic links return correctly.

## Architecture

- `src/App.jsx` — single-file React app: all components, logic, and inline
  styles.
- `src/Auth.jsx` — Supabase auth gate (magic-link sign-in) and `signOut`.
- `src/storage.js` — async `get/set/delete` wrapper over the Supabase row.
- `src/supabaseClient.js` — configured Supabase client.
- `src/main.jsx` — React entry point (wraps `App` in `AuthGate`).
- `src/index.css` — minimal global reset.

## Future work

- [ ] Component decomposition (`App.jsx` is ~1,150 lines)
- [ ] CSS modules or Tailwind instead of inline styles
- [ ] Normalized tables (per-listing rows) for query history and dedup
- [ ] Realtime sync across open devices
- [ ] Automated search via API
- [ ] Mobile PWA support
- [ ] Tests
