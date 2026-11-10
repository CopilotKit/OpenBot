import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CONNECT,
  journey,
  type Leg,
  leftSaid,
  OPEN,
  type Plan,
  position,
  SETUP,
  stageAt,
  UPDATE,
  WAIT,
} from "./journey";
import type { LocalSequence } from "./LocalIntelligence";
import { startLegs } from "./StartJourney";

/**
 * A first setup of the back end and its update after an app update, as the CLI logged them on a
 * Windows machine (D30): [seconds since the call began, the step it finished].
 */
const recorded: { setup: [number, string][]; update: [number, string][] } =
  JSON.parse(
    readFileSync(
      new URL(
        "../src-tauri/test-fixtures/local-eval/d30-steps.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

/** Words a person setting OpenBot up doesn't know. */
const TECHNICAL = [
  /Podman/i,
  /\bWSL\b/,
  /\bengines?\b/i,
  /back ?end/i,
  /\bk3[sd]\b/i,
  /\bHelm\b/,
  /kubectl/i,
  /\bCLI\b/,
  /\bCompose\b/,
  /\bcontainers?\b/i,
  /\bcluster\b/i,
  /\bimages?\b/i,
  /\bhooks?\b/i,
  /\bmigrations?\b/i,
  /\bquiesce\b/i,
  /\bdependenc/i,
  /-/,
];

const PLANS: [string, Plan][] = [
  ["setup", SETUP],
  ["update", UPDATE],
  ["wait", WAIT],
  ["open", OPEN],
  ["connect", CONNECT],
];

test("every step is said in plain words, and every recorded step has a place in its plan", () => {
  for (const [name, plan] of PLANS)
    for (const stage of plan.stages)
      for (const word of TECHNICAL)
        expect({
          plan: name,
          said: stage.said,
          word: word.test(stage.said),
        }).toEqual({
          plan: name,
          said: stage.said,
          word: false,
        });
  // What the person reads while a recorded step runs is one of the plan's own sentences.
  for (const [name, plan] of [
    ["setup", SETUP],
    ["update", UPDATE],
  ] as const)
    for (const [, step] of recorded[name]) {
      const at = plan.milestones[step];
      if (at === undefined) continue;
      expect(plan.stages.map((stage) => stage.said)).toContain(
        stageAt(plan, at).said,
      );
    }
});

/**
 * The bar only moves forward, second by second through the real runs: never back, and never stuck
 * for long while the run goes on.
 */
for (const name of ["setup", "update"] as const) {
  test(`over the recorded ${name}, the bar only moves forward and says what is happening`, () => {
    const plan = name === "setup" ? SETUP : UPDATE;
    const steps = recorded[name];
    const end = Math.ceil(steps[steps.length - 1][0]);
    let last = -1;
    let still = 0;
    const said = new Set<string>();
    for (let t = 0; t <= end; t += 1) {
      const ended = steps.filter(([at]) => at <= t).map(([, step]) => step);
      const where = journey([
        { plan, state: "now", at: position(plan, ended, t) },
      ]);
      expect(where.fraction).toBeGreaterThanOrEqual(last);
      still = where.fraction > last ? 0 : still + 1;
      // Never sits still for more than a few seconds while the run goes on.
      expect(still).toBeLessThanOrEqual(3);
      last = where.fraction;
      said.add(where.said);
    }
    // Close to the end by the end, and it said each part of the run as it came.
    expect(last).toBeGreaterThan(0.9);
    expect([...said]).toEqual(plan.stages.map((stage) => stage.said));
  });
}

/**
 * A step that runs long: the bar slows rather than stalls or passes what has not happened, and the
 * time left gives way to saying it is taking longer, rather than a number that is wrong.
 */
test("a step that runs long slows the bar, never passes it, and says it is taking longer", () => {
  // Setup stuck waiting on its databases: everything up to installing them ended, on time.
  const ended = recorded.setup
    .filter(([at]) => at <= 86)
    .map(([, step]) => step);
  const next = SETUP.milestones["dependencies-wait"];
  let last = 0;
  const seen: { at: number; left: number | null }[] = [];
  for (const t of [90, 110, 130, 160, 220, 400, 900]) {
    const at = position(SETUP, ended, t);
    const where = journey([{ plan: SETUP, state: "now", at }]);
    expect(at.at).toBeLessThan(next);
    expect(where.fraction).toBeGreaterThan(last);
    last = where.fraction;
    seen.push({ at: Math.round(at.at), left: where.left });
  }
  // On time, it gives a time left; well past when that step usually ends, it says so instead.
  expect(seen[0].left).not.toBeNull();
  expect(seen[seen.length - 1].left).toBeNull();
  expect(leftSaid(null)).toBe("Taking longer than usual, still working");
  // Once the step ends, the bar moves on past it.
  const after = position(SETUP, [...ended, "dependencies-wait"], 900);
  expect(after.at).toBeGreaterThanOrEqual(next);
});

/** One journey over a whole Start: a leg done counts in full, and one to come counts nothing yet. */
test("a Start's legs make one journey, weighed by how long each takes", () => {
  const legs: Leg[] = [
    { plan: WAIT, state: "done" },
    { plan: OPEN, state: "now", at: position(OPEN, ["env", "ports"], 3) },
  ];
  const where = journey(legs);
  expect(where.fraction).toBeGreaterThan(60 / 85);
  expect(where.fraction).toBeLessThan(1);
  expect(where.said).toBe("Checking OpenBot's settings");
  expect(leftSaid(where.left)).toBe("Less than a minute left");
  const first = journey([
    { plan: WAIT, state: "now", at: position(WAIT, [], 0) },
    { plan: OPEN, state: "next" },
  ]);
  expect(first.fraction).toBe(0);
  expect(leftSaid(first.left)).toBe("About a minute left");
});

/**
 * A download is a step of the journey of its own: the bar moves with its bytes and its time left
 * comes from its own speed. The step it holds up keeps its own clock meanwhile, so once a three
 * minute download ends the update carries on as on time, not "taking longer than usual".
 */
test("a long download moves the bar by its bytes and holds up no step's clock", () => {
  const now = 1_000_000;
  const since = now - 200_000;
  const sequence = {
    began: "wait",
    at: "wait",
    running: true,
    runSince: since,
    since,
    updating: true,
    trailKind: "update",
    trail: recorded.update.filter(([at]) => at <= 6).map(([, step]) => step),
    trailSince: since,
    services: null,
    download: {
      bytes: 600_000_000,
      size: 1_200_000_000,
      bytesPerSecond: 4_000_000,
    },
  } as unknown as LocalSequence;
  // 190 of the 200 seconds so far went on the download.
  const held = 190;
  const downloading = journey(startLegs(sequence, [], now, { held }));
  expect(downloading.said).toBe("Downloading the update");
  // What is left of it at its own speed, 150 seconds, then the rest of the update and the start.
  expect(downloading.left).toBeGreaterThan(150);
  const more = journey(
    startLegs(
      {
        ...sequence,
        download: { ...sequence.download, bytes: 900_000_000 },
      } as LocalSequence,
      [],
      now,
      { held },
    ),
  );
  expect(more.fraction).toBeGreaterThan(downloading.fraction);
  // Downloaded: the update carries on from where it was, on time.
  const after = { ...sequence, download: null } as LocalSequence;
  const carrying = journey(startLegs(after, [], now, { held }));
  expect(carrying.said).toBe("Getting the update ready");
  expect(carrying.left).not.toBeNull();
  // Counting the download as the update's own time read as taking longer than usual.
  expect(journey(startLegs(after, [], now)).left).toBeNull();
});
