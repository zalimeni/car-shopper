// Pure sync reconciliation — no imports, no browser/DOM dependencies, so it can
// run in the browser (src/sync.js) AND in a serverless function (scheduled
// background sync). Keep it that way.
//
// Known VINs get price-change + last-seen updates; brand-new VINs come back as
// `candidates` for the human-approval queue. Non-destructive: a listing is only
// ever flagged gone, never deleted or auto-rejected.

// Cap the per-listing price history so the single-blob state stays bounded.
var PRICE_HISTORY_MAX = 40;

// opts.goneVins: watchlist VINs a direct VIN lookup came back without — no longer
// listed anywhere. Only those are counted "not seen" (and stamped goneAt); a car a
// search simply didn't return (a new-listings pass, a filter it left) is untouched.
export function reconcile(existing, fetched, todayStr, opts) {
  const gone = {};
  ((opts && opts.goneVins) || []).forEach(function (v) { const k = vinKey(v); if (k) gone[k] = true; });
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
      // Confirmed no longer listed — flag only (the Sold banner offers to archive).
      if (k && gone[k] && l.source === "marketcheck" && l.status === "watch") {
        summary.notSeen++;
        return l.goneAt ? l : Object.assign({}, l, { goneAt: todayStr });
      }
      return l;
    }
    matched[k] = true;
    const next = Object.assign({}, l, { lastSeen: todayStr, lastChecked: todayStr });
    if (next.goneAt) delete next.goneAt; // relisted
    // Keep the market facts that drift over time current on every sighting.
    if (f.dom != null) next.dom = f.dom;
    if (f.distMi != null) next.distMi = f.distMi;
    if (f.fees != null) next.fees = f.fees;
    if (f.dLat != null && f.dLon != null) { next.dLat = f.dLat; next.dLon = f.dLon; }
    if (f.mcSeen) next.mcSeen = f.mcSeen;
    if (next.mcQ) delete next.mcQ; // per-search tags from the old unchanged-search shortcut
    // One-time basis correction: listings synced before we stored prices
    // pre-fee carry the fee inside `price`. When the new price differs by exactly
    // that fee it isn't a price move — fix the stored price (and its history)
    // quietly instead of announcing a phantom drop.
    if (f.price && l.source === "marketcheck" && l.fees == null && f.fees > 0 && l.price - f.price === f.fees) {
      next.price = f.price;
      if (Array.isArray(l.priceHistory) && l.priceHistory.length) {
        next.priceHistory = l.priceHistory.map(function (p) { return p && p.price ? Object.assign({}, p, { price: p.price - f.fees }) : p; });
      }
      summary.refreshed++;
      return next;
    }
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
