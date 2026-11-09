// The guided tutorial — steps + placement math (pure, tested). The overlay that
// runs it is src/Tutorial.jsx; start it with startTutorial() from anywhere.
//
// A step: { id, title, text, tab?, target?, action?, costly?, demoOnly?, signedInOnly?, signedInText? }
//  - tab: switch to it first (through the URL hash the app already follows).
//  - target: a [data-tour="…"] element to spotlight (first match). Missing → the step is skipped.
//  - action: "click" — the visitor taps the highlighted control, or Next taps it for them;
//    either way the step waits until it's done (the control is enabled and no longer "…ing"),
//    then moves on.
//  - costly: the action spends real MarketCheck calls / the owner's Anthropic key. Signed in,
//    such a step only explains (the control can't be tapped through the overlay); in the
//    demo everything is simulated, so it runs.

export var TUTORIAL_EVENT = "cs-tutorial";
export function startTutorial() {
  try { window.dispatchEvent(new CustomEvent(TUTORIAL_EVENT)); } catch (e) { /* no window */ }
}

export var STEPS = [
  { id: "intro", title: "Quick tutorial",
    text: "A two-minute walk through the app, in the order you'd use it. Tap Next, or tap whatever's highlighted yourself. Skip any time." },
  { id: "profile", tab: "Profiles", target: "profile", title: "Profiles: the cars you're hunting",
    text: "Each profile is one car you're after: make, model, years, price and mileage caps, plus must-haves and dealbreakers the AI scores against. The switch turns its searches on or off." },
  { id: "add-profile", tab: "Profiles", target: "add-profile", title: "Add a car with the wizard",
    text: "+ Add opens a wizard: pick a make and model, then Explore shows how many are for sale nationwide, in which trims, and what they cost, so the caps you set mean something." },
  { id: "criteria", tab: "Criteria", target: "criteria", title: "What a good deal means to you",
    text: "Weighted criteria: price, mileage, condition, location and more. Every listing gets a 1–10 score per criterion, rolled up by these weights." },
  { id: "candidates", tab: "Results", target: "candidates", title: "New matches wait for review",
    text: "New listings land here, not straight on your watchlist. The daily background sync found a couple while you were away." },
  { id: "sync", tab: "Results", target: "sync", action: "click", costly: true, title: "Sync pulls fresh inventory",
    text: "↻ Sync runs one nationwide search per active profile: new cars join the queue, price changes get noted, and cars that sold are flagged. Tap it, or tap Next and it runs for you.",
    signedInText: "↻ Sync runs one nationwide search per active profile: new cars join the queue, price changes get noted, and cars that sold are flagged. It uses your MarketCheck quota, so the tutorial won't run it for you." },
  { id: "cand-card", tab: "Results", target: "cand-card", title: "Review a candidate",
    text: "Price, miles, dealer, distance, days listed and the AI's take, at a glance. ✓ Add to Watchlist keeps it; Skip sets it aside for good." },
  { id: "score", tab: "Results", target: "score", action: "click", costly: true, title: "AI scoring",
    text: "✨ Score grades a car against your criteria and profile with Claude. Here it's simulated from similar cars already scored. Tap it, or tap Next.",
    signedInText: "✨ Score grades a car against your criteria and profile with Claude, using your Anthropic key, so the tutorial won't run it for you." },
  { id: "watch-card", tab: "Results", target: "watch-card", title: "Your watchlist",
    text: "Saved cars keep a price history. Drops show on the card, and a car that sells is called out so you can archive it." },
  { id: "filters", tab: "Results", target: "filters", title: "Slice the list",
    text: "Filter by profile, category, dealer or tag, and sort by score, price or miles." },
  { id: "compare", tab: "Compare", target: "compare", title: "Compare side by side",
    text: "Every watched car in one table. Drag a header to reorder, pin columns to keep them on the left, and tap a row to open its card." },
  { id: "price", tab: "Price", target: "price", title: "Is it a fair price?",
    text: "Check any car, even one you found elsewhere, against comparable listings. Pull in the live market and ask AI for a verdict." },
  { id: "quota", target: "quota", title: "MarketCheck usage",
    text: "The ring shows how much of this month's MarketCheck quota is left. Tap it any time for what each action costs." },
  { id: "done-demo", demoOnly: true, target: "banner", title: "That's the tutorial",
    text: "Reset starts the demo over, Tutorial replays this, and About has the notes on how it's built. Have fun poking around!" },
  { id: "done", signedInOnly: true, title: "That's the tutorial",
    text: "The Help tab covers every feature in detail, and you can replay this from there any time." },
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
