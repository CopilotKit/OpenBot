import { expect, test } from "bun:test";
import { length, OPEN, type Plan, SETUP, UPDATE } from "./journey";
import mirror from "./journeyTimings.json";
import { RELEASE } from "./StartJourney";

// journeyTimings.json is what the native side times setup, start and update steps by
// (`stall.rs`, `setup_stalled`). It mirrors the journeys' measured timings here; when a timing
// changes in journey.ts or StartJourney.tsx, change it there too.

const timings = mirror as unknown as {
  setup: unknown;
  update: unknown;
  start: unknown;
  release: {
    begins: [string, string, number][];
    length: number;
    download: unknown;
  };
};

const ends = (plan: Plan): unknown => ({
  ends: Object.entries(plan.milestones),
  ...(plan.download
    ? { download: [plan.download.from, plan.download.to] }
    : {}),
});

test("the native side times each step by the journeys' own measured timings", () => {
  expect(timings.setup).toEqual(ends(SETUP));
  expect(timings.update).toEqual(ends(UPDATE));
  expect(timings.start).toEqual(ends(OPEN));
  expect(
    timings.release.begins.map(([, line, begin]) => [line, begin]),
  ).toEqual(Object.entries(RELEASE.milestones));
  expect(timings.release.length).toBe(length(RELEASE));
  expect(timings.release.download).toEqual([
    RELEASE.download?.from,
    RELEASE.download?.to,
  ]);
});
