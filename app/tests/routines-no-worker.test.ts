import { describe, expect, test } from "bun:test";
import { nothingIsFiring, type SweepRecord } from "@/lib/routines/queries";

const sweeping: SweepRecord = {
  lastSweptAt: new Date().toISOString(),
  working: true,
};
const quiet: SweepRecord = {
  lastSweptAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  working: false,
};
const never: SweepRecord = { lastSweptAt: null, working: false };

describe("when the routines page should say nothing is running them", () => {
  test("says so when a worker has gone quiet and routines are standing", () => {
    expect(nothingIsFiring(quiet, 2)).toBe(true);
  });

  test("says so when no worker has ever checked in", () => {
    expect(nothingIsFiring(never, 1)).toBe(true);
  });

  test("stays quiet while a worker is sweeping", () => {
    expect(nothingIsFiring(sweeping, 2)).toBe(false);
  });

  test("stays quiet when there is nothing scheduled to miss", () => {
    expect(nothingIsFiring(quiet, 0)).toBe(false);
  });

  test("stays quiet before the page knows, so the warning cannot flash on load", () => {
    expect(nothingIsFiring(undefined, 2)).toBe(false);
  });
});
