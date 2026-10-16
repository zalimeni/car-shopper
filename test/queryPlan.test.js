import { describe, it, expect } from "vitest";
import { parseYears, mapPowertrain } from "../src/queryPlan.js";

describe("profile field -> MarketCheck value helpers", () => {
  it("parseYears expands ranges and lists, sorted and deduped", () => {
    expect(parseYears("2016, 2018-2019")).toBe("2016,2018,2019");
    expect(parseYears("2022-2019")).toBe("2019,2020,2021,2022");
    expect(parseYears("")).toBe("");
  });
  it("mapPowertrain turns friendly words into powertrain_type codes", () => {
    expect(mapPowertrain("Plug-in Hybrid")).toBe("PHEV");
    expect(mapPowertrain("hybrid")).toBe("HEV");
    expect(mapPowertrain("Electric")).toBe("BEV");
    expect(mapPowertrain("gas")).toBe("Combustion");
    expect(mapPowertrain("FCEV")).toBe("FCEV"); // unknowns pass through
  });
});
