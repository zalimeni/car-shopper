// The guided tutorial — steps + placement math (pure, tested). The overlay that
// runs it is src/Tutorial.jsx; start it with startTutorial() from anywhere.
//
// A step: { id, title, text, tab?, target?, action?, costly?, demoOnly?, signedInOnly?, signedInText?,
//           remember?, targetFor?, modal? }
//  - tab: switch to it first (through the URL hash the app already follows).
//  - target: a [data-tour="…"] element to spotlight (first match). Missing → the step is skipped.
//  - action: "click" — the visitor taps the highlighted control, or Next taps it for them;
//    either way the step waits until it's done (the control is enabled and no longer "…ing"),
//    then moves on.
//  - costly: the action spends real MarketCheck calls / the owner's Anthropic key. Signed in,
//    such a step only explains (the control can't be tapped through the overlay); in the
//    demo everything is simulated, so it runs.
//  - remember: "car" — note which candidate card the tapped control sits in (its
//    data-car VIN); a later step's targetFor(memory) can spotlight that same car
//    even after the list re-sorts.
//  - modal: steps that live inside a dialog the tutorial opened (e.g. "quota");
//    leaving the last of them closes it via [data-tour-close="<modal>"].

export var TUTORIAL_EVENT = "cs-tutorial";
export function startTutorial() {
  try { window.dispatchEvent(new CustomEvent(TUTORIAL_EVENT)); } catch (e) { /* no window */ }
}

export var STEPS = [
  { id: "intro", title: "Quick tutorial",
    text: "This will give you a short tour of the app. Tap Next, or tap the highlighted control yourself. You can skip any time." },
  { id: "profile", tab: "Profiles", target: "profile", title: "Profiles",
    text: "A profile is one car you're looking for: make, model, years, max price and mileage, plus must-haves and dealbreakers for the AI to check. The switch turns its search on or off." },
  { id: "add-profile", tab: "Profiles", target: "add-profile", title: "Add a profile",
    text: "+ Add opens a wizard. Pick a make and model, then Explore shows how many are for sale, in which trims, and at what prices, to help you set limits." },
  { id: "criteria", tab: "Criteria", target: "criteria", title: "Criteria",
    text: "Price, mileage, condition, location and more, each with a weight. Each listing gets a 1–10 score per criterion, and the weights combine them into one score." },
  { id: "candidates", tab: "Results", target: "candidates", title: "New listings",
    text: "New listings show up here first until you dismiss or add to your watchlist.\n\nThe demo simulates new results from a daily sync.",
    signedInText: "New listings show up here first, not on your watchlist, whether ↻ Sync or the daily sync found them. ✓ Add to Watchlist keeps one; Skip hides it." },
  { id: "sync", tab: "Results", target: "sync", action: "click", costly: true, title: "Sync",
    text: "↻ Sync runs one search per active profile. New cars show up for review, price changes are noted, and sold cars are flagged. Tap it, or tap Next to run it.",
    signedInText: "↻ Sync runs one search per active profile. New cars show up for review, price changes are noted, and sold cars are flagged. It uses your MarketCheck quota, so the tutorial won't run it for you." },
  { id: "cand-card", tab: "Results", target: "cand-card", title: "Review a listing",
    text: "Price, miles, dealer, distance, days listed and the AI's score. ✓ Add to Watchlist keeps it; Skip hides it for good." },
  { id: "score", tab: "Results", target: "score", action: "click", costly: true, remember: "car", title: "AI scoring",
    text: "✨ Score has Claude rate a car against your criteria and profile. In the demo, scores are copied from similar cars. Tap it, or tap Next.",
    signedInText: "✨ Score has Claude rate a car against your criteria and profile. It uses your Anthropic key, so the tutorial won't run it for you." },
  { id: "scored", tab: "Results", target: "cand-card", targetFor: function (m) { return m && m.car ? '[data-tour="cand-card"][data-car="' + m.car + '"]' : null; },
    title: "The score",
    text: "The overall score is at the top right. Below it is a short summary from the AI. Per-criterion shows each score and the reason for it.",
    signedInText: "After scoring, the overall score is at the top right. Below it is a short summary from the AI. Per-criterion shows each score and the reason for it." },
  { id: "watch-card", tab: "Results", target: "watch-card", title: "Watchlist",
    text: "Saved cars keep a price history. Price drops show on the card, and sold cars are marked so you can archive them." },
  { id: "filters", tab: "Results", target: "filters", title: "Filter and sort",
    text: "Filter by profile, category, dealer or tag. Sort by score, price or miles." },
  { id: "compare", tab: "Compare", target: "compare", title: "Compare",
    text: "All your saved cars in one table. Drag a header to move a column, pin columns to the left, and tap a row to open the car." },
  { id: "price", tab: "Price", target: "price", title: "Price Check",
    text: "Check any car's price against similar listings, even a car you found somewhere else. You can search the live market and ask the AI whether it's a fair price." },
  { id: "quota", target: "quota", action: "click", title: "MarketCheck usage",
    text: "MarketCheck's free plan allows 500 calls a month per key. The ring shows how many are left. Tap it, or tap Next, to see details." },
  { id: "quota-head", modal: "quota", target: "quota-head", title: "This month",
    text: "Calls left across your keys, and when the count resets. Keys are used in order: when one runs out, the next one is used." },
  { id: "quota-syncs", modal: "quota", target: "quota-syncs", title: "Sync cost",
    text: "Each active profile is one search, about one call per 50 matching cars. This shows what a ↻ Sync costs and how many more you can run this month." },
  { id: "quota-costs", modal: "quota", target: "quota-costs", title: "Cost per action",
    text: "How many calls each action uses, from a sync to a Price Check search." },
  { id: "done-demo", demoOnly: true, target: "banner", title: "Done",
    text: "Reset starts the demo over, Tutorial runs this again, and About explains how the app is built." },
  { id: "done", signedInOnly: true, title: "Done",
    text: "The Help tab covers every feature. You can run this tutorial again from there." },
];

export function stepsFor(demo) {
  return STEPS.filter(function (s) { return demo ? !s.signedInOnly : !s.demoOnly; });
}
export function stepText(step, demo) { return !demo && step.signedInText ? step.signedInText : step.text; }
// Can the visitor (or Next) run this step's action?
export function runsAction(step, demo) { return !!(step && step.action && (demo || !step.costly)); }

// Where the card goes: below the target if it fits, else above, else whichever
// side has more room (clamped on screen). No target → centered.
// rect { top, left, width, height } (viewport px), card { w, h }, vp { w, h }
// -> { top, left, arrow: "up" | "down" | null, arrowX }
export function placeCard(rect, card, vp, gap) {
  var g = gap == null ? 14 : gap, m = 10;
  if (!rect) return { top: Math.max(m, (vp.h - card.h) / 2), left: Math.max(m, (vp.w - card.w) / 2), arrow: null, arrowX: 0 };
  var below = vp.h - (rect.top + rect.height) - g - m;
  var above = rect.top - g - m;
  var down = below >= card.h || (above < card.h && below >= above);
  var top = down ? rect.top + rect.height + g : rect.top - g - card.h;
  top = Math.min(Math.max(m, top), Math.max(m, vp.h - card.h - m));
  var cx = rect.left + rect.width / 2;
  var left = Math.min(Math.max(m, cx - card.w / 2), Math.max(m, vp.w - card.w - m));
  return { top: top, left: left, arrow: down ? "up" : "down", arrowX: Math.min(Math.max(18, cx - left), card.w - 18) };
}

// Is a clicked control finished? Enabled again and not showing a busy label.
export function looksDone(el) {
  if (!el) return true;
  return !el.disabled && !/…|\.\.\./.test(el.textContent || "");
}
