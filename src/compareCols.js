// Compare table column layout: order (drag a header) and pins (kept on the left,
// sticky while the table scrolls). Pure, so it's unit-tested.
//
// Stored in the synced settings as settings.compareCols = { order: [key], pinned: [key] }
// (column keys: "score", "spec:price", "cpo", "crit:<criterion id>" …). Saved keys
// that no longer exist (a deleted criterion) are ignored; columns the saved order
// doesn't know (a new criterion) keep their default spot relative to the others.
// The Listing column is always first and always pinned — it isn't part of this.

// Columns in display order: pinned ones first (in the user's order), then the rest.
// -> { pinned: [col], rest: [col] }
export function layoutColumns(cols, pref) {
  const p = pref || {};
  const keys = cols.map(function (c) { return c.key; });
  const order = mergeOrder(keys, Array.isArray(p.order) ? p.order : []);
  const pinSet = {};
  (Array.isArray(p.pinned) ? p.pinned : []).forEach(function (k) { pinSet[k] = true; });
  const byKey = {};
  cols.forEach(function (c) { byKey[c.key] = c; });
  const all = order.map(function (k) { return byKey[k]; });
  return {
    pinned: all.filter(function (c) { return pinSet[c.key]; }),
    rest: all.filter(function (c) { return !pinSet[c.key]; }),
  };
}

// The saved order restricted to current keys, with unknown (new) keys slotted in
// after the column that precedes them by default (or first, if nothing does).
export function mergeOrder(keys, saved) {
  const known = {};
  keys.forEach(function (k) { known[k] = true; });
  const out = [];
  const seen = {};
  saved.forEach(function (k) { if (known[k] && !seen[k]) { seen[k] = true; out.push(k); } });
  keys.forEach(function (k, i) {
    if (seen[k]) return;
    seen[k] = true;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const pos = out.indexOf(keys[j]); if (pos > -1) { at = pos + 1; break; } }
    out.splice(at, 0, k);
  });
  return out;
}

// Move column `from` to where column `to` is (dropping onto a header). Moving
// between the pinned and unpinned groups pins/unpins it to match its new
// neighbour. -> the new { order, pinned }
export function moveColumn(cols, pref, from, to) {
  const lay = layoutColumns(cols, pref);
  const shown = lay.pinned.concat(lay.rest).map(function (c) { return c.key; });
  let pinned = lay.pinned.map(function (c) { return c.key; });
  const fi = shown.indexOf(from), ti = shown.indexOf(to);
  if (fi < 0 || ti < 0 || fi === ti) return { order: shown, pinned: pinned };
  shown.splice(fi, 1);
  shown.splice(ti, 0, from);
  const targetPinned = pinned.indexOf(to) > -1;
  pinned = pinned.filter(function (k) { return k !== from; });
  if (targetPinned) pinned.push(from);
  return { order: shown, pinned: shown.filter(function (k) { return pinned.indexOf(k) > -1; }) };
}

// Pin or unpin a column. A newly pinned column goes to the end of the pinned group;
// an unpinned one goes to the front of the rest. -> the new { order, pinned }
export function togglePin(cols, pref, key) {
  const lay = layoutColumns(cols, pref);
  let pinned = lay.pinned.map(function (c) { return c.key; });
  let rest = lay.rest.map(function (c) { return c.key; });
  if (pinned.indexOf(key) > -1) { pinned = pinned.filter(function (k) { return k !== key; }); rest = [key].concat(rest); }
  else if (rest.indexOf(key) > -1) { rest = rest.filter(function (k) { return k !== key; }); pinned = pinned.concat(key); }
  return { order: pinned.concat(rest), pinned: pinned };
}
