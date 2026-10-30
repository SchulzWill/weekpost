import { describe, expect, it } from "vitest";
import { seasonFor } from "./season.ts";

describe("seasonFor (meteorological season by month)", () => {
  it("follows the northern hemisphere", () => {
    expect(seasonFor("2026-10-26", "north")).toBe("autumn");
  });

  it("follows the southern hemisphere: October is spring", () => {
    expect(seasonFor("2026-10-26", "south")).toBe("spring");
  });

  it.each([
    ["2026-02-28", "winter", "summer"],
    ["2026-03-01", "spring", "autumn"],
    ["2026-05-31", "spring", "autumn"],
    ["2026-06-01", "summer", "winter"],
    ["2026-08-31", "summer", "winter"],
    ["2026-09-01", "autumn", "spring"],
    ["2026-11-30", "autumn", "spring"],
    ["2026-12-01", "winter", "summer"],
    ["2027-01-15", "winter", "summer"],
  ] as const)("%s: north %s, south %s", (date, north, south) => {
    expect(seasonFor(date, "north")).toBe(north);
    expect(seasonFor(date, "south")).toBe(south);
  });
});
