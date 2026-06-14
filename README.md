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

## Data storage

All data lives in `localStorage` under the key `car-search-data`, so it persists
across sessions and deploys but stays on the device. Use **Export Listings** to
back up and the **Import** tab to restore or seed data.

## Architecture

- `src/App.jsx` — single-file React app: all components, logic, and inline
  styles.
- `src/storage.js` — `localStorage` wrapper with an async API.
- `src/main.jsx` — React entry point.
- `src/index.css` — minimal global reset.

## Future work

- [ ] Component decomposition (`App.jsx` is ~1,150 lines)
- [ ] CSS modules or Tailwind instead of inline styles
- [ ] Persistent/shared backend for query history and dedup
- [ ] Automated search via API
- [ ] Mobile PWA support
- [ ] Tests
