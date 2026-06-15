# Tests

Golden tests (Vitest) for the deterministic core of the sync pipeline. Run with:

```bash
npm test
```

## What's covered

- `marketcheck.test.js` — `buildUrl` (the exact request we send to MarketCheck —
  host, `year_range`, `price_range`/`miles_range`, no `seller_type`), `parseYears`,
  `normalize` (response → app listing), `mapDealerType`.
- `sync.test.js` — `reconcile`: price-drop notes, `lastSeen` refresh, vanished
  listings flagged (not deleted), manual listings untouched, new VINs → candidates,
  lowest-price dedup.

## Fixtures

`fixtures/marketcheck-active-search.json` mirrors a MarketCheck
`GET /v2/search/car/active` response and is the golden input for `normalize`.

**Refresh it from real data** once a live sync works: tap **Debug raw** in the
app footer (or `await window.__rawSync()`), copy the `rawSample` listings into the
fixture's `listings`, and update the expected values in `marketcheck.test.js`. The
`buildUrl`/`parseYears`/`reconcile` tests are schema-independent and stay valid
regardless.
