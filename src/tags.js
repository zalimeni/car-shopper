// Freeform listing tags ("called dealer", "test drive booked", "waiting on Carfax")
// for filtering and tracking progress. Stored as `tags: [string]` on a saved
// listing. Pure, so it's unit-tested.
//
// Tags match case-insensitively, and a new tag adopts the spelling of one already
// in use ("Called dealer" typed as "called dealer" stays "Called dealer"), so the
// list stays tidy without a separate tag-management screen.

export const TAG_MAX = 30;

// Trim, collapse inner whitespace, cap the length. "" for nothing usable.
export function normalizeTag(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, TAG_MAX).trim();
}

const key = function (t) { return normalizeTag(t).toLowerCase(); };

export function hasTag(listing, tag) {
  const k = key(tag);
  return !!k && Array.isArray(listing && listing.tags) && listing.tags.some(function (t) { return key(t) === k; });
}

// Add a tag (no-op if present), using the spelling of a matching known tag.
export function addTag(tags, tag, known) {
  const t = normalizeTag(tag);
  const list = Array.isArray(tags) ? tags.slice() : [];
  if (!t || list.some(function (x) { return key(x) === t.toLowerCase(); })) return list;
  const same = (known || []).find(function (x) { return key(x) === t.toLowerCase(); });
  list.push(same || t);
  return list;
}

export function removeTag(tags, tag) {
  const k = key(tag);
  return (Array.isArray(tags) ? tags : []).filter(function (x) { return key(x) !== k; });
}

// Every tag in use, most-used first, then alphabetical (one spelling per tag).
export function allTags(listings) {
  const count = {}, spelling = {};
  (listings || []).forEach(function (l) {
    (Array.isArray(l && l.tags) ? l.tags : []).forEach(function (t) {
      const k = key(t);
      if (!k) return;
      if (!spelling[k]) spelling[k] = normalizeTag(t);
      count[k] = (count[k] || 0) + 1;
    });
  });
  return Object.keys(count).sort(function (a, b) { return count[b] - count[a] || a.localeCompare(b); }).map(function (k) { return spelling[k]; });
}
