import { describe, it, expect } from "vitest";
import { reconcile } from "../src/sync.js";

const TODAY = "2026-06-15";

describe("reconcile", () => {
  const existing = [
    // Known synced listing whose price dropped since last sync.
    {
      id: "a1", vin: "VIN_PRICE_DROP", vehicle: "Toyota RAV4 Hybrid", year: 2021,
      price: 27000, status: "watch", source: "marketcheck", profileId: "rav4-hybrid",
      addedDate: "2026-06-01", lastChecked: "2026-06-10", lastSeen: "2026-06-10", notes: "",
    },
    // Previously synced, now absent from results -> should be flagged, not deleted.
    {
      id: "b2", vin: "VIN_GONE", vehicle: "Chevrolet Bolt EUV", year: 2022,
      price: 18000, status: "watch", source: "marketcheck", profileId: "bolt-euv",
      lastSeen: "2026-06-05",
    },
    // Manually entered listing -> must never be touched by sync.
    {
      id: "c3", vin: "VIN_MANUAL", vehicle: "Honda CR-V", year: 2019,
      price: 20000, status: "watch", profileId: "rav4-hybrid",
    },
  ];

  const fetched = [
    { vin: "VIN_PRICE_DROP", vehicle: "Toyota RAV4 Hybrid", year: 2021, price: 25500, source: "marketcheck", profileId: "rav4-hybrid", dom: 30, distMi: 42 },
    { vin: "VIN_NEW", vehicle: "Toyota RAV4 Hybrid", year: 2022, price: 24000, source: "marketcheck", profileId: "rav4-hybrid", dom: 9 },
  ];

  // VIN_GONE's direct VIN lookup came back empty this sync.
  const result = reconcile(existing, fetched, TODAY, { goneVins: ["vin_gone"] });

  it("summarizes the run", () => {
    expect(result.summary).toEqual({ fetched: 2, priceUpdates: 1, refreshed: 0, newCount: 1, notSeen: 1 });
  });

  it("records the price drop with a note + refreshes lastSeen", () => {
    const updated = result.listings.find((l) => l.id === "a1");
    expect(updated.price).toBe(25500);
    expect(updated.lastSeen).toBe(TODAY);
    expect(updated.lastChecked).toBe(TODAY);
    expect(updated.notes).toContain("$27,000 → $25,500");
  });

  it("maintains a bounded price history, seeding the pre-tracking price", () => {
    const updated = result.listings.find((l) => l.id === "a1");
    expect(updated.priceHistory).toEqual([
      { date: "2026-06-10", price: 27000 }, // seeded from lastSeen at the old price
      { date: TODAY, price: 25500 },
    ]);
  });

  it("refreshes drifting market facts (dom, distMi) on every sighting", () => {
    const updated = result.listings.find((l) => l.id === "a1");
    expect(updated.dom).toBe(30);
    expect(updated.distMi).toBe(42);
  });

  it("flags a price-changed listing for review with a lastChange", () => {
    const updated = result.listings.find((l) => l.id === "a1");
    expect(updated.reviewPending).toBe(true);
    expect(updated.lastChange).toEqual({ type: "price", from: 27000, to: 25500, dir: "↓", at: TODAY });
    // unchanged/absent listings are not flagged
    expect(result.listings.find((l) => l.id === "b2").reviewPending).toBeFalsy();
  });

  it("flags a listing the VIN lookup confirmed gone, non-destructively", () => {
    const gone = result.listings.find((l) => l.id === "b2");
    expect(gone).toBeTruthy();
    expect(gone.status).toBe("watch");
    expect(gone.goneAt).toBe(TODAY);
    expect(gone.lastSeen).toBe("2026-06-05");
  });

  it("a car the searches simply didn't return is untouched — only the VIN lookup says gone", () => {
    const r = reconcile(existing, fetched, TODAY);
    expect(r.summary.notSeen).toBe(0);
    expect(r.listings.find((l) => l.id === "b2")).toEqual(existing[1]);
  });

  it("a relisted car loses its gone mark", () => {
    const ex = [{ id: "g", vin: "G1", price: 1, status: "watch", source: "marketcheck", goneAt: "2026-06-01" }];
    expect(reconcile(ex, [{ vin: "G1", price: 1 }], TODAY).listings[0].goneAt).toBeUndefined();
  });

  it("never touches manual listings", () => {
    expect(result.listings.find((l) => l.id === "c3")).toEqual(existing[2]);
  });

  it("returns brand-new VINs as candidates", () => {
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    expect(c.vin).toBe("VIN_NEW");
    expect(c.status).toBe("watch");
    expect(c.lastSeen).toBe(TODAY);
    expect(c.notes).toBe(""); // dom shows as a card chip now, not a note
    expect(c.dom).toBe(9);
    expect(c.priceHistory).toEqual([{ date: TODAY, price: 24000 }]); // history starts at first sighting
  });

  it("keeps the lower price when a VIN appears twice in one batch", () => {
    const dupBatch = [
      { vin: "DUP", vehicle: "X", year: 2021, price: 22000, profileId: "p", source: "marketcheck" },
      { vin: "DUP", vehicle: "X", year: 2021, price: 20500, profileId: "p", source: "marketcheck" },
    ];
    const r = reconcile([], dupBatch, TODAY);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].price).toBe(20500);
  });

  it("prefers a priced duplicate over an unpriced ($0) one, regardless of order", () => {
    const r = reconcile([], [
      { vin: "DUP0", vehicle: "X", year: 2021, price: 0, profileId: "p", source: "marketcheck" },
      { vin: "DUP0", vehicle: "X", year: 2021, price: 21000, profileId: "p", source: "marketcheck" },
    ], TODAY);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].price).toBe(21000);
  });

  it("refreshes lastSeen for an unchanged (same-price) listing rather than treating it as gone", () => {
    const ex = [{ id: "u1", vin: "VIN_SAME", price: 20000, status: "watch", source: "marketcheck", lastSeen: "2026-06-10" }];
    const r = reconcile(ex, [{ vin: "VIN_SAME", price: 20000, source: "marketcheck" }], TODAY);
    const u = r.listings.find((l) => l.id === "u1");
    expect(u.lastSeen).toBe(TODAY);
    expect(u.lastChecked).toBe(TODAY);
    expect(u.reviewPending).toBeFalsy(); // unchanged -> not surfaced for review
    expect(r.summary.refreshed).toBe(1);
    expect(r.summary.notSeen).toBe(0);
    expect(r.candidates).toHaveLength(0); // matched, not a new candidate
  });

  it("matches VINs case/whitespace-insensitively so trivial drift isn't read as 'sold'", () => {
    const ex = [{ id: "m1", vin: "abc123 ", price: 20000, status: "watch", source: "marketcheck", lastSeen: "2026-06-10" }];
    const r = reconcile(ex, [{ vin: "ABC123", price: 20000, source: "marketcheck" }], TODAY);
    const m = r.listings.find((l) => l.id === "m1");
    expect(m.lastSeen).toBe(TODAY); // matched despite case + trailing space
    expect(r.candidates).toHaveLength(0); // not mistaken for a brand-new VIN
    expect(r.summary.notSeen).toBe(0);
  });
});

describe("reconcile: fees, coordinates and MarketCheck freshness", () => {
  const T = "2026-10-14";
  const stored = (over) => Object.assign({ id: "t1", vin: "KM8JCCD14RU211946", vehicle: "Hyundai Tucson", year: 2024, price: 26683, status: "watch", source: "marketcheck",
    profileId: "p", addedDate: "2026-09-29", lastChecked: "2026-10-01", lastSeen: "2026-10-01", notes: "",
    priceHistory: [{ date: "2026-09-29", price: 27183 }, { date: "2026-10-01", price: 26683 }] }, over || {});
  const fetched = (over) => Object.assign({ vin: "KM8JCCD14RU211946", price: 25988, fees: 695, dLat: 34.77, dLon: -87.67, mcSeen: "2026-10-12", dom: 109 }, over || {});

  it("quietly re-bases a legacy fee-inclusive price: no phantom drop, no review flag, history fixed", () => {
    const r = reconcile([stored()], [fetched()], T);
    const l = r.listings[0];
    expect(l.price).toBe(25988);
    expect(l.fees).toBe(695);
    expect(l.reviewPending).toBeFalsy();
    expect(l.notes).toBe("");
    expect(l.lastChange).toBeUndefined();
    expect(l.priceHistory.map((p) => p.price)).toEqual([26488, 25988]);
    expect(r.summary.priceUpdates).toBe(0);
  });
  it("still reports a genuine price change after the re-base", () => {
    const r = reconcile([stored({ price: 25988, fees: 695 })], [fetched({ price: 24688 })], T);
    expect(r.listings[0].price).toBe(24688);
    expect(r.listings[0].reviewPending).toBe(true);
    expect(r.summary.priceUpdates).toBe(1);
  });
  it("does not treat an unrelated change as a re-base", () => {
    const r = reconcile([stored()], [fetched({ price: 25000 })], T);
    expect(r.summary.priceUpdates).toBe(1);
    expect(r.listings[0].price).toBe(25000);
  });
  it("refreshes coordinates and MarketCheck's last-seen on every sighting", () => {
    const r = reconcile([stored({ price: 25988, fees: 695 })], [fetched()], T);
    expect(r.listings[0]).toMatchObject({ dLat: 34.77, dLon: -87.67, mcSeen: "2026-10-12", lastSeen: T });
  });
  it("hands new candidates the new fields", () => {
    const r = reconcile([], [fetched()], T);
    expect(r.candidates[0]).toMatchObject({ fees: 695, dLat: 34.77, mcSeen: "2026-10-12" });
  });
});

describe("reconcile fills a color a saved listing never had", () => {
  it("takes the decoded color and marks its source; never overwrites an existing color", () => {
    const ex = [{ id: "a", vin: "A1", price: 1, status: "watch", source: "marketcheck" }, { id: "b", vin: "B1", price: 1, status: "watch", source: "marketcheck", color: "Blue", baseColor: "Blue" }];
    const r = reconcile(ex, [{ vin: "A1", price: 1, color: "Shimmering Silver Metallic", baseColor: "Silver", colorSource: "neovin" }, { vin: "B1", price: 1, color: "Red", baseColor: "Red" }], "2026-10-16");
    expect(r.listings[0]).toMatchObject({ color: "Shimmering Silver Metallic", baseColor: "Silver", colorSource: "neovin" });
    expect(r.listings[1]).toMatchObject({ color: "Blue", baseColor: "Blue" });
  });
});
