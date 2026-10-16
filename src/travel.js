// Travel flags for a listing: how far it is from the buyer's home base, whether
// there's a major airport near the dealer (fly in, drive back), and whether the
// dealer is in the salt belt. Flags only — nothing is filtered on distance, since
// a far car can be shipped. Pure; shared by the cards and the AI scoring facts.

import { homeMiles } from "./geo.js";
import { nearestAirport } from "./airports.js";
import { isSaltState } from "./regions.js";

export const DRIVE_MAX_MI = 500;    // past this (straight line) it's "ship or fly", not a drive home
export const AIRPORT_NEAR_MI = 50;  // a major airport within this of the dealer = fly-in friendly

// -> { homeMi, farFromHome, airport: { code, mi, near } | null, salt }
// homeMi is null without a home base (or dealer coordinates).
export function travelFacts(listing, homeBase) {
  const l = listing || {};
  const homeMi = homeMiles(l, homeBase);
  const ap = nearestAirport(l.dLat, l.dLon);
  return {
    homeMi: homeMi,
    farFromHome: homeMi != null && homeMi > DRIVE_MAX_MI,
    airport: ap ? { code: ap.code, mi: ap.mi, near: ap.mi <= AIRPORT_NEAR_MI } : null,
    salt: isSaltState(l.state),
  };
}
