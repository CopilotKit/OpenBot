import { describe, expect, test } from "bun:test";
import { insideWindow, upgradeAllowedNow } from "../src/window";

describe("maintenance window", () => {
  const tuesday = { weekday: 2, startUtc: "14:00", hours: 4 };

  test("a window holds from its start for its hours, and not a minute either side", () => {
    expect(insideWindow(tuesday, new Date("2026-11-17T13:59:00Z"))).toBe(false);
    expect(insideWindow(tuesday, new Date("2026-11-17T14:00:00Z"))).toBe(true);
    expect(insideWindow(tuesday, new Date("2026-11-17T17:59:00Z"))).toBe(true);
    expect(insideWindow(tuesday, new Date("2026-11-17T18:00:00Z"))).toBe(false);
    // The same time on another day is outside.
    expect(insideWindow(tuesday, new Date("2026-11-18T15:00:00Z"))).toBe(false);
  });

  test("a window that starts late on Saturday runs into Sunday", () => {
    const saturdayNight = { weekday: 6, startUtc: "22:30", hours: 6 };
    expect(insideWindow(saturdayNight, new Date("2026-11-21T23:00:00Z"))).toBe(
      true,
    );
    expect(insideWindow(saturdayNight, new Date("2026-11-22T04:29:00Z"))).toBe(
      true,
    );
    expect(insideWindow(saturdayNight, new Date("2026-11-22T04:30:00Z"))).toBe(
      false,
    );
    expect(insideWindow(saturdayNight, new Date("2026-11-21T22:29:00Z"))).toBe(
      false,
    );
  });

  test("an upgrade needs the service's window and the customer's, where the customer set one", () => {
    const always = { weekday: 0, startUtc: "00:00", hours: 168 };
    const inside = new Date("2026-11-17T15:00:00Z");
    const outside = new Date("2026-11-17T19:00:00Z");
    expect(upgradeAllowedNow(always, tuesday, inside)).toBe(true);
    expect(upgradeAllowedNow(always, tuesday, outside)).toBe(false);
    expect(upgradeAllowedNow(tuesday, always, outside)).toBe(false);
    expect(upgradeAllowedNow(tuesday, null, inside)).toBe(true);
  });
});
