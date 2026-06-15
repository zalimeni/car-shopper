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
    { vin: "VIN_PRICE_DROP", vehicle: "Toyota RAV4 Hybrid", year: 2021, price: 25500, source: "marketcheck", profileId: "rav4-hybrid", dom: 30 },
    { vin: "VIN_NEW", vehicle: "Toyota RAV4 Hybrid", year: 2022, price: 24000, source: "marketcheck", profileId: "rav4-hybrid", dom: 9 },
  ];

  const result = reconcile(existing, fetched, TODAY);

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

  it("flags a vanished listing non-destructively", () => {
    const gone = result.listings.find((l) => l.id === "b2");
    expect(gone).toBeTruthy();
    expect(gone.status).toBe("watch");
    expect(gone.lastSeen).toBe("2026-06-05"); // unchanged -> stale = "may be sold"
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
    expect(c.notes).toBe("9 days on market");
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
});
