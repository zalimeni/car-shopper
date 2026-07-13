// Pure sync reconciliation — no imports, no browser/DOM dependencies, so it can
// run in the browser (src/sync.js) AND in a serverless function (scheduled
// background sync). Keep it that way.
//
// Known VINs get price-change + last-seen updates; brand-new VINs come back as
// `candidates` for the human-approval queue. Non-destructive: a listing that
// vanishes from results is only flagged, never deleted or auto-rejected.

// Cap the per-listing price history so the single-blob state stays bounded.
var PRICE_HISTORY_MAX = 40;

export function reconcile(existing, fetched, todayStr) {
  const byVin = {};
  (fetched || []).forEach(function (f) {
    const k = vinKey(f.vin);
    if (!k) return;
    const prev = byVin[k];
    // Lowest REAL price wins — a priced row always beats an unpriced one.
    if (!prev || (f.price && (!prev.price || f.price < prev.price))) byVin[k] = f;
  });

  const matched = {};
  const summary = { fetched: (fetched || []).length, priceUpdates: 0, refreshed: 0, newCount: 0, notSeen: 0 };

  const listings = (existing || []).map(function (l) {
    // Match on a normalized VIN (case/whitespace-insensitive) so a stored
    // listing isn't mistaken for "gone" over a trivial formatting difference.
    const k = vinKey(l.vin);
    const f = k ? byVin[k] : null;
    if (!f) {
      // A previously-synced listing that's missing this run — flag only.
      if (l.source === "marketcheck" && l.status === "watch" && l.lastSeen && l.lastSeen !== todayStr) {
        summary.notSeen++;
      }
      return l;
    }
    matched[k] = true;
    const next = Object.assign({}, l, { lastSeen: todayStr, lastChecked: todayStr });
    // Keep the market facts that drift over time current on every sighting.
    if (f.dom != null) next.dom = f.dom;
    if (f.distMi != null) next.distMi = f.distMi;
    if (f.price && f.price !== l.price) {
      const dir = f.price < l.price ? "↓" : "↑";
      next.notes = appendNote(l.notes, dir + " Price $" + (l.price || 0).toLocaleString() + " → $" + f.price.toLocaleString() + " (" + todayStr + ")");
      // Material change: surface for review (separate from the saved watchlist)
      // and eligible for an auto re-score.
      next.reviewPending = true;
      next.lastChange = { type: "price", from: l.price || 0, to: f.price, dir: dir, at: todayStr };
      next.priceHistory = appendPrice(l, f.price, todayStr);
      next.price = f.price;
      summary.priceUpdates++;
    } else {
      summary.refreshed++;
    }
    return next;
  });

  const candidates = [];
  Object.keys(byVin).forEach(function (vin) {
    if (matched[vin]) return;
    const f = byVin[vin];
    candidates.push(Object.assign({}, f, {
      addedDate: todayStr,
      lastChecked: todayStr,
      lastSeen: todayStr,
      status: "watch",
      scores: {},
      dealRating: "",
      notes: "",
      priceHistory: f.price ? [{ date: todayStr, price: f.price }] : [],
    }));
    summary.newCount++;
  });

  return { listings: listings, candidates: candidates, summary: summary };
}

// Append today's price to a listing's history, seeding the previous price for
// listings tracked from before the history existed. Bounded; idempotent for
// same-day re-syncs at the same price.
function appendPrice(l, price, todayStr) {
  let hist = Array.isArray(l.priceHistory) ? l.priceHistory.slice() : [];
  if (!hist.length && l.price) hist.push({ date: l.lastSeen || l.addedDate || "", price: l.price });
  const last = hist[hist.length - 1];
  if (!last || last.price !== price || last.date !== todayStr) hist.push({ date: todayStr, price: price });
  if (hist.length > PRICE_HISTORY_MAX) hist = hist.slice(hist.length - PRICE_HISTORY_MAX);
  return hist;
}

// Normalize a VIN for matching: VINs are uppercase alphanumeric, so trim and
// upcase both sides before comparing (fetched vs stored).
function vinKey(v) { return String(v || "").trim().toUpperCase(); }

function appendNote(existing, note) {
  const e = (existing || "").trim();
  if (!e) return note;
  if (e.indexOf(note) > -1) return e; // idempotent across re-syncs in one day
  return e + " · " + note;
}
