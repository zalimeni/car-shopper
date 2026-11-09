# Demo fixture

`/?demo` runs the app over `public/demo/snapshot.json` (the demo-snapshot shape:
`{ demoVersion, exportedAt, data, pool }`) with thumbnails in `public/demo/cars/`.
These scripts rebuild both from an export of the owner's data.

**Nothing from the owner's data goes into git except what the build writes.**
The build keeps real prices, mileage, trims, colors, cities and AI scores, and
replaces everything that identifies a car, a dealer or the owner:

| Kept | Replaced |
|---|---|
| year, trim, color, price, mileage, days listed, city/state | VIN serial (valid check digit), dealer name (fictional), dealer link (none), dealer coordinates (city center) |
| AI scores, summaries, rationales | the dealer's name inside them; the dealer rationale; any VIN |
| sync-written price notes | memos, hand-written notes, reject reasons, profile must-haves (rewritten neutral) |
| — | dealer photos → cut-out, softened illustrations (no lot, banner or readable plate) |

## Rebuild

1. Get an export: the published demo row (`/rest/v1/demo_snapshot?id=eq.1`, public)
   or an app-state blob. Keep it **outside** the repo.
2. Build the fixture (prints counts and any leftover real VIN / dealer name):
   ```bash
   node scripts/demo-fixture/build.mjs /path/to/export.json --out public/demo/snapshot.json
   ```
   It writes the source photo URLs to `$TMPDIR/demo-fixture-photos.json` (real
   dealer URLs — never commit; `.gitignore` covers the usual names).
3. Thumbnails (Python 3, `pip install "rembg[cpu]" pillow`; the ~170 MB U²-Net
   model downloads on first run):
   ```bash
   rm -rf public/demo/cars
   python scripts/demo-fixture/thumb.py "$TMPDIR/demo-fixture-photos.json" public/demo/cars
   ```
   Photos that can't be fetched are listed in `dead-photos.json` next to the
   photos file: rerun step 2 with `--skip-photos <that file>` (it picks the
   next-best car), then step 3, until none fail.
4. **Look at every thumbnail** (e.g. `montage public/demo/cars/*.webp sheet.png`).
   Add the source URL of any bad one (placeholder, close-up, watermark, broken
   cut-out) to the skip list and repeat.
5. `npm test` — `test/demoFixture.test.js` must pass.
