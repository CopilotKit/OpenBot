/**
 * Where a long start, setup or update is, in the person's words, and how far along: from the
 * steps the CLI has finished (`local_eval_steps`) and what OpenBot's own start reports, weighed by
 * how long each part takes.
 *
 * The product's rule: a person waiting always knows what is happening and how far along it is. A
 * row that said "Waiting for the back end · 13s elapsed" for minutes told them neither. The step
 * names never reach the screen: each maps to a plain phrase here, and the names stay in the log.
 *
 * Timings are measured, not guessed: a first setup and an update of the back end on Windows
 * (D30, 2026-11-09, `cli.log`), and OpenBot's own start (about 25 seconds). Each is a milestone:
 * the seconds into the run by which that step had typically finished. Where a run is, is the
 * furthest milestone it has passed, moved on by the time since, and never past the next one: a
 * step that runs long slows the bar rather than letting it pass what has not happened, and the
 * time left gives way to "Taking longer than usual, still working" rather than lying.
 */

/** One part of a run: what it is called on screen, and by when it typically ends. */
export type Stage = { said: string; until: number };

export type Plan = {
  /** Seconds into the run by which each step typically finished, by the CLI's step name. */
  milestones: Record<string, number>;
  /** In order: what each stretch of the run is, said plainly. */
  stages: Stage[];
};

/** Typical seconds of the whole plan. */
export function length(plan: Plan): number {
  return plan.stages[plan.stages.length - 1]?.until ?? 0;
}

/**
 * A first setup of the back end (D30 Windows, 3 minutes and 10 seconds): checks, the cluster,
 * downloads, the databases and storage, the database jobs, then its services.
 */
export const SETUP: Plan = {
  milestones: {
    "engine-check": 0,
    "release-download": 3,
    "docker-check": 6,
    "resource-check": 6,
    "engine-storage-check": 13,
    "chart-download": 15,
    "chart-render": 15,
    "cluster-discovery": 16,
    "cluster-create": 27,
    kubeconfig: 29,
    "ownership-check": 31,
    "runtime-inspect": 32,
    "runtime-identity-write": 32,
    "image-download": 46,
    "system-image-download": 71,
    "system-image-tag": 72,
    "secrets-apply": 82,
    "dependencies-install": 85,
    "dependencies-wait": 112,
    "hook-apply": 128,
    "migration-apply": 128,
    "migration-wait": 143,
    "hook-wait": 149,
    "bootstrap-result": 149,
    "services-start": 183,
    "service-status": 187,
  },
  stages: [
    { said: "Checking this computer", until: 13 },
    { said: "Preparing a place on this computer for OpenBot", until: 32 },
    { said: "Downloading what OpenBot needs", until: 80 },
    { said: "Preparing where OpenBot keeps your data", until: 127 },
    { said: "Setting up your data", until: 160 },
    { said: "Starting OpenBot's services", until: 190 },
  ],
};

/** An update of the back end after an app update (D30 Windows, 2 minutes). */
export const UPDATE: Plan = {
  milestones: {
    "release-download": 1,
    "chart-download": 3,
    "chart-render": 3,
    "cluster-discovery": 4,
    kubeconfig: 4,
    "runtime-identity-write": 6,
    "image-download": 7,
    "system-image-download": 10,
    "system-image-tag": 11,
    "secrets-apply": 15,
    "update-schedules": 15,
    "update-suspend": 16,
    "update-quiesce": 17,
    "update-quiesce-wait": 48,
    "update-jobs": 49,
    "update-agent-stop": 49,
    "update-agent-wait": 50,
    "dependencies-install": 57,
    "dependencies-wait": 67,
    "hook-apply": 68,
    "migration-apply": 69,
    "migration-wait": 75,
    "hook-wait": 80,
    "bootstrap-result": 81,
    "services-start": 115,
    "service-status": 117,
  },
  stages: [
    { said: "Getting the update ready", until: 15 },
    { said: "Pausing OpenBot's services", until: 50 },
    { said: "Updating where OpenBot keeps your data", until: 68 },
    { said: "Updating your data", until: 92 },
    { said: "Starting OpenBot's services", until: 120 },
  ],
};

/**
 * Every day, the back end comes up by itself once the computer's software runs: no CLI steps to
 * follow, so time and the services it reports ready say how far along it is.
 */
export const WAIT: Plan = {
  milestones: {},
  stages: [
    { said: "Starting the software OpenBot runs on", until: 15 },
    { said: "Starting OpenBot's services", until: 60 },
  ],
};

/**
 * OpenBot's own start, once its services answer (about 25 seconds): its settings, its apps, then
 * waiting until it answers. By the rows `start_stack` reports (`setup:progress`).
 */
export const OPEN: Plan = {
  milestones: {
    env: 1,
    ports: 2,
    deployment: 3,
    images: 4,
    installation: 4,
    services: 13,
    "carry-over": 14,
    migrate: 18,
    answering: 25,
  },
  stages: [
    { said: "Checking OpenBot's settings", until: 4 },
    { said: "Starting OpenBot's apps", until: 14 },
    { said: "Checking your data", until: 18 },
    { said: "Waiting for OpenBot to respond", until: 25 },
  ],
};

/** Connecting OpenBot to its services: seconds. */
export const CONNECT: Plan = {
  milestones: {},
  stages: [{ said: "Connecting OpenBot to its services", until: 3 }],
};

/** Where a run is, in seconds of its plan, and whether it is running longer than usual. */
export type Position = { at: number; slow: boolean };

/**
 * Where a run of `plan` is: past the furthest milestone of the steps it has `ended`, moved on by
 * the `elapsed` seconds since it began, and never at the next milestone until that step ends. Past
 * 80% of the way to it, it eases toward 95% instead of stopping. `slow` once the run is well past
 * where that step typically ends.
 */
export function position(
  plan: Plan,
  ended: readonly string[],
  elapsed: number,
  /** A measured share of the plan done, such as services reported ready, from 0 to 1. */
  measured = 0,
): Position {
  const total = length(plan);
  const passed = Math.max(
    0,
    total * Math.min(1, Math.max(0, measured)),
    ...ended.map((step) => plan.milestones[step] ?? 0),
  );
  const ahead = [
    ...Object.values(plan.milestones),
    ...plan.stages.map((stage) => stage.until),
  ]
    .filter((at) => at > passed)
    .sort((a, b) => a - b);
  const next = ahead[0] ?? total;
  const span = Math.max(1, next - passed);
  const into = Math.max(0, elapsed - passed);
  const eased =
    into <= 0.8 * span
      ? into
      : span * (0.8 + 0.15 * (1 - Math.exp(-(into - 0.8 * span) / span)));
  return {
    at: Math.min(total, passed + eased),
    slow: elapsed > next + Math.max(15, span * 0.5),
  };
}

/** What the run is doing now, by where it is. */
export function stageAt(plan: Plan, at: number): Stage {
  return (
    plan.stages.find((stage) => at < stage.until) ??
    plan.stages[plan.stages.length - 1]
  );
}

/** One part of a whole journey across a screen, and where it is. */
export type Leg = {
  plan: Plan;
  /** Done, under way with its position, or still to come. */
  state: "done" | "now" | "next";
  at?: Position;
};

export type Journey = {
  /** From 0 to 1, over every leg. */
  fraction: number;
  /** What is happening now, in plain words. */
  said: string;
  /** Seconds left, or null while running longer than usual. */
  left: number | null;
};

/** Where a whole journey is, over its legs, weighed by how long each typically takes. */
export function journey(legs: readonly Leg[]): Journey {
  const total = legs.reduce((sum, leg) => sum + length(leg.plan), 0) || 1;
  let done = 0;
  let left = 0;
  let slow = false;
  let said = "";
  for (const leg of legs) {
    const size = length(leg.plan);
    if (leg.state === "done") {
      done += size;
      continue;
    }
    if (leg.state === "now") {
      const at = leg.at ?? { at: 0, slow: false };
      done += at.at;
      left += size - at.at;
      slow ||= at.slow;
      said ||= stageAt(leg.plan, at.at).said;
      continue;
    }
    left += size;
    said ||= leg.plan.stages[0]?.said ?? "";
  }
  return {
    fraction: Math.min(1, done / total),
    said,
    left: slow ? null : Math.max(0, Math.round(left)),
  };
}

/** Bytes a second to plan with until a download's own speed is known: 10 MB a second. */
const ASSUMED_SPEED = 10_000_000;

/**
 * A download under way, as a leg of its own: how long it takes is what is left of it over its
 * speed so far. The steps it holds up stand still meanwhile (`position` with no time gone), so a
 * slow line reads as a download that is moving, not a step taking longer than usual.
 */
export function downloadLeg(
  said: string,
  {
    bytes,
    size,
    bytesPerSecond,
  }: { bytes: number; size?: number; bytesPerSecond?: number },
): Leg {
  const speed =
    bytesPerSecond && bytesPerSecond > 0 ? bytesPerSecond : ASSUMED_SPEED;
  // Its size not known yet: a minute to plan with, and nothing of it counted as done.
  const seconds = size && size > 0 ? Math.max(1, size / speed) : 60;
  const done = size && size > 0 ? Math.min(1, bytes / size) : 0;
  return {
    plan: { milestones: {}, stages: [{ said, until: seconds }] },
    state: "now",
    at: { at: done * seconds, slow: false },
  };
}

/** "About 3 minutes left", "Less than a minute left", or that it is taking longer. */
export function leftSaid(left: number | null): string {
  if (left === null) return "Taking longer than usual, still working";
  if (left < 60) return "Less than a minute left";
  const minutes = Math.round(left / 60);
  return minutes <= 1 ? "About a minute left" : `About ${minutes} minutes left`;
}
