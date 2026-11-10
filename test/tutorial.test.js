import { describe, it, expect } from "vitest";
import { STEPS, stepsFor, stepText, runsAction, placeCard, looksDone } from "../src/tutorial.js";

describe("tutorial steps", () => {
  it("demo and signed-in get their own ending", () => {
    expect(stepsFor(true).map((s) => s.id)).toContain("done-demo");
    expect(stepsFor(true).map((s) => s.id)).not.toContain("done");
    expect(stepsFor(false).map((s) => s.id)).toContain("done");
    expect(stepsFor(false).map((s) => s.id)).not.toContain("done-demo");
    expect(stepsFor(true).length).toBe(18);
  });
  it("costly actions run only in the demo; signed in they just explain", () => {
    var sync = STEPS.find((s) => s.id === "sync");
    expect(runsAction(sync, true)).toBe(true);
    expect(runsAction(sync, false)).toBe(false);
    expect(stepText(sync, false)).toMatch(/won't run it for you/);
    expect(runsAction(STEPS[1], true)).toBe(false);
  });
  it("every target is unique-ish and ids are unique", () => {
    var ids = STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("placeCard", () => {
  var vp = { w: 390, h: 800 }, card = { w: 320, h: 160 };
  it("below the target when it fits, arrow up at the target's center", () => {
    var p = placeCard({ top: 100, left: 20, width: 100, height: 40 }, card, vp);
    expect(p).toEqual({ top: 154, left: 10, arrow: "up", arrowX: 60 });
  });
  it("above when there's no room below", () => {
    var p = placeCard({ top: 700, left: 300, width: 60, height: 40 }, card, vp);
    expect(p.arrow).toBe("down");
    expect(p.top).toBe(700 - 14 - 160);
    expect(p.left).toBe(390 - 320 - 10);
    expect(p.arrowX).toBe(330 - 60); // target center minus card left
  });
  it("centered without a target", () => {
    expect(placeCard(null, card, vp)).toEqual({ top: 320, left: 35, arrow: null, arrowX: 0 });
  });
  it("a tall target: stays on screen", () => {
    var p = placeCard({ top: 4, left: 0, width: 390, height: 780 }, card, vp);
    expect(p.top).toBeGreaterThanOrEqual(10);
    expect(p.top + card.h).toBeLessThanOrEqual(800 - 10);
  });
});

describe("looksDone", () => {
  it("busy labels and disabled controls aren't done", () => {
    expect(looksDone({ disabled: true, textContent: "↻ Sync" })).toBe(false);
    expect(looksDone({ disabled: false, textContent: "Syncing…" })).toBe(false);
    expect(looksDone({ disabled: false, textContent: "↻ Sync" })).toBe(true);
    expect(looksDone(null)).toBe(true);
  });
});

describe("tutorial follow-ups", () => {
  it("the result step follows the car that was scored", () => {
    var scored = STEPS.find((s) => s.id === "scored");
    expect(scored.targetFor({ car: "VIN1" })).toBe('[data-tour="cand-card"][data-car="VIN1"]');
    expect(scored.targetFor({})).toBeNull(); // falls back to the first candidate card
    expect(STEPS[STEPS.indexOf(scored) - 1].remember).toBe("car");
  });
  it("the quota dialog steps run in a row, opened by a free action", () => {
    var ids = STEPS.map((s) => s.id);
    var q = ids.indexOf("quota");
    expect(ids.slice(q, q + 4)).toEqual(["quota", "quota-head", "quota-syncs", "quota-costs"]);
    expect(runsAction(STEPS[q], false)).toBe(true); // opening it costs nothing, so it runs signed in too
    expect(STEPS.slice(q + 1, q + 4).every((s) => s.modal === "quota")).toBe(true);
  });
});
