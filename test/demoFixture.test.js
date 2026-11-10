import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prepareDemo, demoCount, simulateSync, autoNotes } from "../src/demo.js";

// The public demo's data (public/demo/, built by scripts/demo-fixture/). It
// ships to every visitor and lives in git forever, so this test is the
// tripwire: anything that looks like a secret, a contact, a real link or a
// stray build input fails it.

const DIR = path.join(__dirname, "..", "public", "demo");
const fx = JSON.parse(fs.readFileSync(path.join(DIR, "snapshot.json"), "utf8"));
const d = fx.data;
const cars = [].concat(d.listings, d.candidates, d.skipped, fx.pool);
const strings = [];
(function walk(v, p) {
  if (typeof v === "string") strings.push([p, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + "[" + i + "]"));
  else if (v && typeof v === "object") Object.keys(v).forEach((k) => walk(v[k], p + "." + k));
})(fx, "");

const VAL = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const vinOk = (v) => {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let s = 0;
  for (let i = 0; i < 17; i++) s += (/\d/.test(v[i]) ? +v[i] : VAL[v[i]]) * W[i];
  return v[8] === (s % 11 === 10 ? "X" : String(s % 11));
};

describe("demo fixture: nothing sensitive", () => {
  it("no contacts, keys, tokens or outside links anywhere", () => {
    const bad = [
      [/[\w.+-]+@[\w-]+\.[a-z]{2,}/i, "email"],
      [/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/, "phone number"],
      [/https?:\/\//i, "outside link"],
      [/\bsk-ant-|sb_secret_|sb_publishable_|eyJ[\w-]{10,}\.|Bearer\s/i, "key or token"],
      [/\bapi[_-]?key\b|\bpassword\b/i, "credential word"],
    ];
    const hits = [];
    strings.forEach(([p, v]) => bad.forEach(([re, what]) => { if (re.test(v)) hits.push(what + " at " + p); }));
    expect(hits).toEqual([]);
  });
  it("settings carry no keys, quota records, VIN caches or custom prompts", () => {
    ["marketcheckKeys", "mcQuota", "mcApi", "mcColors"].forEach((k) => expect(d.settings[k]).toBeUndefined());
    expect(d.scorePrompt).toBeUndefined();
    expect(Object.keys(d).sort()).toEqual(["autoScore", "candidates", "criteria", "globalReqs", "lastSynced", "listings", "onboarded",
      "profiles", "scoreModel", "settings", "skipped", "version"]);
  });
  it("every car: synthetic VIN (valid check digit), no dealer link, a bundled thumbnail", () => {
    const vins = new Set();
    cars.forEach((c) => {
      expect(vinOk(c.vin)).toBe(true);
      vins.add(c.vin);
      expect(c.link).toBe("");
      expect(c.photo).toMatch(/^\/demo\/cars\/car-\d{2}\.webp$/);
      expect(fs.existsSync(path.join(DIR, "cars", path.basename(c.photo)))).toBe(true);
      expect(c.distMi).toBeUndefined(); // only city-center coordinates
    });
    expect(vins.size).toBe(cars.length);
  });
  it("free text is only what the build writes: sync's price notes, neutral reasons, one scripted memo", () => {
    cars.forEach((c) => expect(c.notes || "").toBe(autoNotes(c.notes)));
    const reasons = d.listings.filter((l) => l.rejectReason).map((l) => l.rejectReason);
    reasons.forEach((r) => expect(["Price is high for the miles", "Trim is missing features I want", "Too far to ship",
      "Accident on the history report", "Not a color I'd live with"]).toContain(r));
    expect(cars.filter((c) => c.memo).length).toBeLessThanOrEqual(1);
  });
  it("public/demo holds only the snapshot and referenced thumbnails (no build inputs)", () => {
    expect(fs.readdirSync(DIR).sort()).toEqual(["cars", "snapshot.json"]);
    const used = new Set(cars.map((c) => path.basename(c.photo)));
    expect(fs.readdirSync(path.join(DIR, "cars")).filter((f) => !used.has(f))).toEqual([]);
  });
});

describe("demo fixture: a good tour", () => {
  const prof = Object.fromEntries(d.profiles.map((p) => [p.id, p]));
  it("cars belong to its profiles; enough of each kind to show every feature", () => {
    cars.forEach((c) => expect(prof[c.profileId]).toBeTruthy());
    const by = (s) => d.listings.filter((l) => l.status === s).length;
    expect(by("watch")).toBeGreaterThanOrEqual(6);
    expect(by("sold")).toBeGreaterThanOrEqual(1);
    expect(by("rejected")).toBeGreaterThanOrEqual(3);
    expect(d.candidates.length).toBeGreaterThanOrEqual(4);
    expect(fx.pool.length).toBeGreaterThanOrEqual(6);
    expect(d.listings.some((l) => l.reviewPending && l.lastChange)).toBe(true);
    expect(d.profiles.filter((p) => p.active).length).toBe(3);
  });
  it("loads as a demo, simulates a sync, and Explore answers for every active profile", () => {
    const p = prepareDemo(fx, new Date("2026-12-01T12:00:00Z"));
    expect(p.data.candidates.filter((c) => c.fromScheduled).length).toBe(2);
    const s = simulateSync(p.data.listings, p.pool, 0);
    expect(s.released.length).toBe(3);
    expect(s.goneVins.length).toBe(1);
    const all = cars.concat(fx.pool);
    d.profiles.filter((x) => x.active).forEach((x) => expect(demoCount(x, all, d.profiles, d.settings.mcProfiles).numFound).toBeGreaterThan(0));
  });
});
