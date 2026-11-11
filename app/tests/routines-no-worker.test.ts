import { describe, expect, test } from "bun:test";
import {
  nothingIsFiring,
  type SweepRecord,
  stoppedRoutinesGuidance,
} from "@/lib/routines/queries";

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

describe("what the routines page tells the person who reads it", () => {
  test("a personal owner whose worker went quiet is told to restart OpenBot, not to ask an admin", () => {
    const said = stoppedRoutinesGuidance("3 hours ago", "personal");
    expect(said).toBe(
      "OpenBot last checked them 3 hours ago. None will run until it starts again. Restart OpenBot to start them.",
    );
    expect(said).not.toMatch(/admin/i);
  });

  test("a personal owner whose worker never started is told the same", () => {
    const said = stoppedRoutinesGuidance(null, "personal");
    expect(said).toBe(
      "OpenBot hasn't started running routines yet, so none of these will run. Restart OpenBot to start them.",
    );
    expect(said).not.toMatch(/admin/i);
  });

  test("a team member is pointed at their admin, keeping when it last checked", () => {
    expect(stoppedRoutinesGuidance("3 hours ago", "team")).toBe(
      "OpenBot last checked them 3 hours ago. None will run until it starts again. Ask an admin if this keeps happening.",
    );
    expect(stoppedRoutinesGuidance(null, "team")).toBe(
      "OpenBot hasn't started running routines yet, so none of these will run. Ask an admin to set this up.",
    );
  });

  test("before the edition is known it says only what is true for both", () => {
    expect(stoppedRoutinesGuidance("3 hours ago", undefined)).toBe(
      "OpenBot last checked them 3 hours ago. None will run until it starts again.",
    );
    expect(stoppedRoutinesGuidance(null, undefined)).not.toMatch(
      /admin|Restart/,
    );
  });
});
