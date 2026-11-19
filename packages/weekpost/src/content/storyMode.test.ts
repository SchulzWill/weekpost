import { describe, expect, it } from "vitest";
import { fallbackTime } from "./storyMode.ts";

describe("fallbackTime", () => {
  it("is the post time plus the delay, on the same day", () => {
    expect(fallbackTime("11:00", 120)).toBe("13:00");
    expect(fallbackTime("22:00", 119)).toBe("23:59");
  });
  it("says so when the deadline falls on the next day", () => {
    expect(fallbackTime("23:00", 120)).toBe("01:00 (next day)");
    expect(fallbackTime("23:00", 60)).toBe("00:00 (next day)");
  });
});
