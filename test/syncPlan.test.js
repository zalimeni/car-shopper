import { describe, it, expect } from "vitest";
import { planSync, profileStatus, searchSig, trackedVins, nextProfileMeta, estimateCost, FULL_REFRESH_DAYS } from "../src/syncPlan.js";
import { isSaltState, searchStates, SALT_STATES, ALL_STATES } from "../src/regions.js";
import { nearestAirport } from "../src/airports.js";
import { travelFacts, DRIVE_MAX_MI } from "../src/travel.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const OPTS = { excludeSalt: true, franchiseOnly: false };
const bolt = { id: "bolt", name: "Bolt EV", params: { make: "Chevrolet", model: "Bolt EV", years: "2021-2023", maxPrice: 16000, maxMiles: 70000 } };
const tucson = { id: "tucson", name: "Tucson Hybrid", params: { make: "Hyundai", model: "Tucson", powertrain: "Hybrid", years: "2022-2024", maxPrice: 27000 } };
const fresh = (p, daysAgo, extra) => Object.assign({ fullAt: iso(daysAgo), lastAt: iso(daysAgo), sig: searchSig(p, OPTS) }, extra || {});

describe("planSync: full refresh when due, else new listings", () => {
  it("a never-synced profile gets a full refresh", () => {
    expect(planSync([bolt], {}, OPTS, NOW).map((s) => s.kind)).toEqual(["full"]);
  });
  it("a recent full refresh means a new-listings pass, covering the days since the last search", () => {
    const steps = planSync([bolt], { bolt: fresh(bolt, 1, { lastAt: iso(1) }) }, OPTS, NOW);
    expect(steps).toEqual([{ kind: "new", profile: bolt, since: 2 }]);
  });
  it(FULL_REFRESH_DAYS + " days after the last full refresh it's due again", () => {
    expect(planSync([bolt], { bolt: fresh(bolt, FULL_REFRESH_DAYS) }, OPTS, NOW)[0].kind).toBe("full");
  });
  it("editing a profile's search filters (or the salt / franchise setting) makes it due", () => {
    const meta = { bolt: fresh(bolt, 0.5) };
    const edited = Object.assign({}, bolt, { params: Object.assign({}, bolt.params, { maxPrice: 18000 }) });
    expect(planSync([edited], meta, OPTS, NOW)[0].kind).toBe("full");
    expect(planSync([bolt], meta, { excludeSalt: false }, NOW)[0].kind).toBe("full");
    // a non-search edit (notes, must-haves) doesn't
    const notes = Object.assign({}, bolt, { params: Object.assign({}, bolt.params, { mustHave: "heated seats" }) });
    expect(planSync([notes], meta, OPTS, NOW)[0].kind).toBe("new");
  });
  it("a manual sync fully refreshes every profile", () => {
    expect(planSync([bolt, tucson], { bolt: fresh(bolt, 0.5), tucson: fresh(tucson, 0.5) }, Object.assign({ manual: true }, OPTS), NOW).map((s) => s.kind)).toEqual(["full", "full"]);
  });
  it("profileStatus says when the stored count predates an edit", () => {
    const meta = { bolt: fresh(bolt, 1, { count: 120, countSig: searchSig(bolt, OPTS) }) };
    expect(profileStatus(bolt, meta, OPTS, NOW)).toMatchObject({ due: false, edited: false, count: 120, countCurrent: true });
    const edited = Object.assign({}, bolt, { params: Object.assign({}, bolt.params, { years: "2022-2023" }) });
    expect(profileStatus(edited, meta, OPTS, NOW)).toMatchObject({ due: true, edited: true, countCurrent: false });
  });
});

describe("trackedVins / nextProfileMeta", () => {
  it("tracks the watchlist's dealer-synced VINs only, normalized and deduped", () => {
    const ls = [
      { vin: " abc ", source: "marketcheck", status: "watch" }, { vin: "ABC", source: "marketcheck", status: "watch" },
      { vin: "MAN", status: "watch" }, { vin: "REJ", source: "marketcheck", status: "rejected" }, { vin: "", source: "marketcheck", status: "watch" },
    ];
    expect(trackedVins(ls)).toEqual(["ABC"]);
  });
  it("a finished full refresh stamps fullAt + sig; a new pass only lastAt; a failed step neither, but keeps its count", () => {
    const now = iso(0);
    const m = nextProfileMeta({ tucson: fresh(tucson, 1) }, [
      { profile: bolt, kind: "full", numFound: 80, ok: true },
      { profile: tucson, kind: "new", numFound: 300, ok: true },
    ], OPTS, now);
    expect(m.bolt).toMatchObject({ fullAt: now, lastAt: now, sig: searchSig(bolt, OPTS), count: 80 });
    expect(m.tucson).toMatchObject({ fullAt: iso(1), lastAt: now, count: 300 });
    const f = nextProfileMeta({}, [{ profile: bolt, kind: "full", numFound: 80, ok: false }], OPTS, now);
    expect(f.bolt.fullAt).toBeUndefined();
    expect(f.bolt.count).toBe(80);
  });
});

describe("estimateCost", () => {
  const watch = Array.from({ length: 60 }, (_, i) => ({ vin: "W" + i, source: "marketcheck", status: "watch" }));
  it("a full refresh costs a call per 50 matching cars, from the known count", () => {
    const meta = { bolt: fresh(bolt, 1, { count: 120, countSig: searchSig(bolt, OPTS) }) };
    const c = estimateCost([bolt], meta, watch, Object.assign({ manual: true }, OPTS), NOW);
    expect(c.profiles[0]).toMatchObject({ kind: "full", min: 3, max: 3 });
    expect(c.vins).toEqual({ min: 0, max: 2 }); // most watched cars come back in a full refresh
    expect([c.min, c.max]).toEqual([3, 5]);
  });
  it("over 500 it adds a page-1 per extra state group", () => {
    const meta = { bolt: fresh(bolt, 1, { count: 1097, countSig: searchSig(bolt, OPTS) }) };
    expect(estimateCost([bolt], meta, [], Object.assign({ manual: true }, OPTS), NOW).profiles[0].min).toBe(22 + 2);
  });
  it("an unknown count is 1–10 pages; a new-listings pass 1–2", () => {
    expect(estimateCost([bolt], {}, [], OPTS, NOW).profiles[0]).toMatchObject({ min: 1, max: 10 });
    expect(estimateCost([bolt], { bolt: fresh(bolt, 1) }, watch, OPTS, NOW)).toMatchObject({ min: 2, max: 4, vins: { min: 1, max: 2 } });
  });
});

describe("regions", () => {
  it("salt belt membership", () => {
    expect([isSaltState("oh"), isSaltState("NC"), isSaltState("")]).toEqual([true, false, false]);
    expect(searchStates(true).length).toBe(ALL_STATES.length - SALT_STATES.length);
    expect(searchStates(false)).toEqual(ALL_STATES);
  });
});

describe("travel flags", () => {
  const home = { lat: 35.994, lon: -78.8986 }; // Durham
  it("nearest major airport", () => {
    expect(nearestAirport(35.99, -78.9)).toMatchObject({ code: "RDU" });
    expect(nearestAirport(null, 1)).toBeNull();
    expect(nearestAirport("33.45", "-112.07").code).toBe("PHX");
  });
  it("distance from the home base, far = ship or fly; airport within 50 mi = fly-in friendly", () => {
    const phx = travelFacts({ dLat: 33.45, dLon: -112.07, state: "AZ" }, home);
    expect(phx.homeMi).toBeGreaterThan(DRIVE_MAX_MI);
    expect(phx).toMatchObject({ farFromHome: true, salt: false });
    expect(phx.airport).toMatchObject({ code: "PHX", near: true });
    const near = travelFacts({ dLat: 36.07, dLon: -79.79, state: "NC" }, home); // Greensboro
    expect(near.farFromHome).toBe(false);
    expect(travelFacts({ dLat: 41.5, dLon: -81.7, state: "OH" }, home).salt).toBe(true);
  });
  it("no home base: no distance, airport still known", () => {
    expect(travelFacts({ dLat: 33.45, dLon: -112.07 }, null)).toMatchObject({ homeMi: null, farFromHome: false, airport: { code: "PHX" } });
  });
});

describe("full refresh colors reach the profile's meta", () => {
  it("nextProfileMeta stores a step's color breakdown with its time", () => {
    const now = iso(0);
    const m = nextProfileMeta({}, [{ profile: bolt, kind: "full", numFound: 80, colors: { counts: { Blue: 50, White: 25 }, unlisted: 5 }, ok: true }], OPTS, now);
    expect(m.bolt.colors).toEqual({ counts: { Blue: 50, White: 25 }, unlisted: 5, at: now });
    const n = nextProfileMeta(m, [{ profile: bolt, kind: "new", numFound: 80, colors: null, ok: true }], OPTS, iso(-1));
    expect(n.bolt.colors.at).toBe(now); // a new-listings pass leaves it alone
  });
});

describe("mergeColorCache", async () => {
  const { mergeColorCache } = await import("../src/syncPlan.js");
  it("remembers decoded colors and 'none found', newest first, dropping 90-day-old entries", () => {
    const now = "2026-10-16T12:00:00.000Z";
    const c = mergeColorCache({ OLD: { color: "Red", baseColor: "Red", at: "2026-06-01T00:00:00Z" }, KEEP: { color: null, at: "2026-10-01T00:00:00Z" } },
      { A: { color: "Shimmering Silver Metallic", baseColor: "Silver" }, B: null }, now);
    expect(Object.keys(c).sort()).toEqual(["A", "B", "KEEP"]);
    expect(c.A).toEqual({ color: "Shimmering Silver Metallic", baseColor: "Silver", at: now });
    expect(c.B).toEqual({ color: null, at: now });
  });
});
