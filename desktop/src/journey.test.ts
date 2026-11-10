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
import type { Progress } from "./SetupProgress";
import { type QuitClock, quitTick } from "./ShuttingDown";
import { installingBehind } from "./SetupProgress";
import { type JourneyClock, journeyTick, startLegs } from "./StartJourney";

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

/**
 * Windows D updating OpenBot 1.0.1-internal.1008 to 1012, as the Start screen was sampled every 3
 * to 12 seconds: the back end up at 5 s, the update getting ready (stopping OpenBot, backing up its
 * data) until 24 s, its 944.3 MB download from 28 s (386.9 MB at 38 s, 783.5 at 50, 929.6 at 62,
 * 939.1 at 74), installing it at 76 s, starting it at 78 s, and OpenBot open at 110 s.
 */
const D_DOWNLOAD: [number, number][] = [
  [28, 0],
  [38, 386_900_000],
  [50, 783_500_000],
  [62, 929_600_000],
  [74, 939_100_000],
  [76, 944_300_000],
];

function bytesAt(second: number): number {
  for (let index = 1; index < D_DOWNLOAD.length; index += 1) {
    const [to, bytes] = D_DOWNLOAD[index] as [number, number];
    const [from, before] = D_DOWNLOAD[index - 1] as [number, number];
    if (second <= to)
      return before + ((bytes - before) * (second - from)) / (to - from);
  }
  return 944_300_000;
}

function windowsD(second: number): {
  sequence: LocalSequence;
  open: Progress[];
} {
  const start = 1_000_000;
  const opening = second >= 5;
  const sequence = {
    began: "wait",
    at: opening ? "start" : "wait",
    running: true,
    runSince: start,
    since: opening ? start + 5_000 : start,
    updating: false,
    trailKind: null,
    trail: [],
    trailSince: null,
    services: null,
    download: null,
  } as unknown as LocalSequence;
  const open: Progress[] = [];
  if (opening) {
    const detail =
      second < 6
        ? "Updating OpenBot. Your Bots, sign-ins and data stay as they are."
        : second < 12
          ? "Stopping OpenBot."
          : second < 24
            ? "Backing up your data."
            : second < 76
              ? "Downloading the update."
              : second < 78
                ? "Installing the update."
                : "Starting OpenBot.";
    open.push({ step: "release", ok: true, running: true, detail });
  }
  if (second >= 28 && second < 76)
    open.push({
      step: "images",
      ok: true,
      running: true,
      detail: "Downloading local software.",
      downloads: {
        // Its first report, as Windows F's: 538 bytes in half a second, then a burst.
        bytes: second === 28 ? 538 : bytesAt(second),
        size: 944_300_000,
        done: Math.max(0, Math.min(4, Math.floor((second - 44) / 8))),
        total: 5,
        bytesPerSecond:
          second === 28
            ? 1_076
            : second < 31
              ? 120_000_000
              : (bytesAt(second) - bytesAt(second - 3)) / 3,
      },
    });
  return { sequence, open };
}

test("over Windows D's update, the bar follows the time each part takes and the time left never jumps up", () => {
  let clock: JourneyClock | null = null;
  const seen: {
    second: number;
    fraction: number;
    left: number | null;
    said: string;
  }[] = [];
  for (let second = 0; second <= 109; second += 1) {
    const { sequence, open } = windowsD(second);
    const ticked = journeyTick(
      clock,
      sequence,
      open,
      1_000_000 + second * 1000,
      true,
    );
    clock = ticked.clock;
    seen.push({ second, ...ticked.view });
  }
  const at = (second: number) => seen[second] as (typeof seen)[number];
  // Never back.
  for (let second = 1; second < seen.length; second += 1)
    expect(at(second).fraction).toBeGreaterThanOrEqual(at(second - 1).fraction);
  // Not most of the way before the longest part has begun: D's bar was at 72% here.
  expect(at(24).fraction).toBeLessThan(0.35);
  // No leap as the download begins, whatever its first reports say: on Windows F the bar jumped
  // from 22% to 42% in two seconds just before it.
  for (let second = 20; second <= 34; second += 1)
    expect(at(second + 2).fraction - at(second).fraction).toBeLessThan(0.06);
  // The download carries the bar, as its share of the time: about half of D's update. On F the
  // 60 second download moved it only from 44% to 53%.
  expect(at(50).fraction).toBeGreaterThan(at(38).fraction);
  expect(at(62).fraction).toBeGreaterThan(at(50).fraction);
  expect(at(76).fraction - at(28).fraction).toBeGreaterThan(0.38);
  // Never an absurd time left, from a first report or otherwise.
  for (const moment of seen) expect(moment.left ?? 0).toBeLessThan(240);
  // Most of the way by the end, never full while it runs.
  expect(at(105).fraction).toBeGreaterThan(0.85);
  expect(at(109).fraction).toBeLessThan(1);
  // Once settled, the time left only ever rises by a small step between samples 3 seconds apart.
  for (let second = 10; second + 3 < seen.length; second += 1) {
    const now = at(second).left;
    const later = at(second + 3).left;
    if (now !== null && later !== null)
      expect(later - now).toBeLessThanOrEqual(2);
  }
  // It said each part as it came.
  const said = [...new Set(seen.map((moment) => moment.said))];
  expect(said).toContain("Getting the update ready");
  expect(said).toContain("Downloading the update");
  expect(said).toContain("Starting the updated OpenBot");
  expect(said.join(" ")).not.toMatch(/back ?end|Podman|engine/i);
});

/**
 * Windows F said "Taking longer than usual, still working" 46 seconds into setting up the rest of
 * OpenBot, a part that takes about three minutes. It says so only once a step is well past when it
 * typically ends: half as long again, and a minute at least.
 */
test("taking longer than usual is said only well past when a step typically ends", () => {
  const checked = recorded.setup
    .filter(([at]) => at <= 13)
    .map(([, step]) => step);
  // 46 seconds in, still on a step that typically ends at 15: not yet.
  expect(position(SETUP, checked, 46).slow).toBe(false);
  expect(
    journey([{ plan: SETUP, state: "now", at: position(SETUP, checked, 46) }])
      .left,
  ).not.toBeNull();
  // Two minutes in, on the same step: now it says so.
  expect(position(SETUP, checked, 120).slow).toBe(true);
});

/**
 * Windows F: the background row's "Step 3 of 4 · 3m 26s elapsed" went back to "0s elapsed" as the
 * back end's setup moved on to its next phase. Its time so far is the whole install's.
 */
test("the background row's time so far only goes up as the install moves on", () => {
  const since = 1_000_000;
  const backEnd = {
    at: "setup",
    running: true,
    stopped: false,
    ready: false,
    detail: null,
    download: null,
    since: since + 200_000,
    runSince: since + 120_000,
  };
  const rows = [
    installingBehind({
      steps: [],
      installing: false,
      installed: true,
      since,
      backEnd,
    }),
    installingBehind({
      steps: [],
      installing: false,
      installed: true,
      since,
      backEnd: { ...backEnd, at: "connect", since: since + 206_000 },
    }),
    installingBehind({
      steps: [],
      installing: false,
      installed: true,
      since,
      backEnd: { ...backEnd, at: "wait", since: since + 209_000 },
    }),
  ];
  expect(rows.map((row) => row?.startedAt)).toEqual([since, since, since]);
  // With no install on record (a relaunch), the back end's whole run, not its phase.
  const relaunch = installingBehind({
    steps: [],
    installing: false,
    installed: true,
    since: null,
    backEnd: { ...backEnd, at: "connect", since: since + 206_000 },
  });
  expect(relaunch?.startedAt).toBe(since + 120_000);
});

/** Windows D's Quit: stopping OpenBot took 14 seconds and its services about 12. */
test("a Quit says what it is doing, moves its bar, and says the time left", () => {
  let clock: QuitClock | null = null;
  const seen: { said: string; fraction: number; left: number | null }[] = [];
  for (let second = 0; second <= 26; second += 1) {
    const steps: Progress[] =
      second < 14
        ? [{ step: "stop-openbot", ok: true, running: true, detail: "" }]
        : [
            { step: "stop-openbot", ok: true, detail: "" },
            { step: "stop-intelligence", ok: true, running: true, detail: "" },
          ];
    const ticked = quitTick(clock, steps, 1_000_000 + second * 1000);
    clock = ticked.clock;
    seen.push(ticked);
  }
  expect(seen[0]?.said).toBe("Closing OpenBot's apps");
  expect(seen[0]?.left).toBe(28);
  expect(seen[20]?.said).toBe("Closing OpenBot's services");
  for (let second = 1; second < seen.length; second += 1)
    expect(seen[second]?.fraction).toBeGreaterThan(
      seen[second - 1]?.fraction ?? 1,
    );
  expect(seen[26]?.fraction).toBeGreaterThan(0.8);
  expect(seen[26]?.fraction).toBeLessThan(1);
});
