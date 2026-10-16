# Tests

Vitest tests for the pure modules and the main UI flows. Run with:

```bash
npm test                         # everything (CI runs this + npm run build)
npx vitest run test/foo.test.js  # one file
```

## Layout

- **`<module>.test.js`** — one per pure module, named after it: `marketcheck`
  (`buildUrl`/`normalize`/`parseYears`…), `searchSteps` (the proxy's `runStep`
  kinds), `syncPlan`, `sync` (`reconcile`), `quota`, `colors`, `tags`,
  `compareCols`, `geo`, `locations`, `markdown`, `priceCheck`,
  `scoring`, `crypto`, `authLink`, `tableSort`, `migrate` (`.jsx`: imports `App.jsx`)…
- **`*.render.test.jsx`** — jsdom render tests (first line
  `// @vitest-environment jsdom`, Testing Library). Two kinds:
  - **One component:** import an exported component (`TagEditor`,
    `ColorFilter`, `QuotaModal`, `PriceCheckTab`…) and render it with props.
    `tags.render.test.jsx` is the template.
  - **The whole App:** mount `App` over mocked modules with a saved state, then
    drive it like a user (click a tab by its text, fire events) and assert on
    what was saved. `compareModal.render.test.jsx` / `queueSync.render.test.jsx`
    are the template: `storage.get` returns the state blob (`{ value:
    JSON.stringify(state), rev }`), `storage.set` pushes each saved blob onto
    `writes`, and `supabaseClient`, `Auth`, `sync`, `score`, `admin`,
    `snapshots` are stubbed. `await screen.findByText("Car Shopper")` waits out
    the load. Set `version` to the current `VERSION` in `App.jsx` so `migrate`
    leaves the state alone.

**jsdom gaps:** no layout (`offsetWidth` etc. are 0, so sticky offsets can't
be asserted beyond `position`) and no `document.elementFromPoint` (stub it when
testing a drag — see `compareColumns.render.test.jsx`). Pointer events fire
fine with `fireEvent.pointerDown/Move/Up`.

## Fixtures

`fixtures/marketcheck-active-search.json` mirrors a MarketCheck
`GET /v2/search/car/active` response and is the golden input for `normalize`.

**Refresh it from real data** once a live sync works: tap **Debug raw** in the
app footer (or `await window.__rawSync()`), copy the `rawSample` listings into the
fixture's `listings`, and update the expected values in `marketcheck.test.js`. The
`buildUrl`/`parseYears`/`reconcile` tests are schema-independent and stay valid
regardless.
