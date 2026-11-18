import { describe, it, expect } from "vitest";
import { nearestAirport } from "../src/airports.js";
import { travelFacts, DRIVE_MAX_MI } from "../src/travel.js";

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
