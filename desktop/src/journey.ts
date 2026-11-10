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
  /**
   * The stretch of the run that is its download, when it has one: a download that reports its
   * bytes stands in for it (`downloadLeg`), so it is never counted twice.
   */
  download?: { from: number; to: number };
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
  download: { from: 32, to: 80 },
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
  download: { from: 6, to: 11 },
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
 * where that step typically ends: half as long again, and a minute at least.
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
    // Well past when that step typically ends, not a few seconds past it: on Windows F "Taking
    // longer than usual" showed 46 seconds into a setup whose parts take minutes.
    slow: elapsed > Math.max(1.5 * next, next + 60),
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
  /** From 0 to 1, over every leg, each weighed by how long it typically takes. */
  fraction: number;
  /** What is happening now, in plain words. */
  said: string;
  /** Seconds left, or null while running longer than usual. */
  left: number | null;
  /** Seconds left by the plans, running long or not. */
  remaining: number;
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
    remaining: Math.max(0, left),
  };
}

/**
 * Seconds to plan with for each part of a download still unpacking once its bytes are in, until
 * its own parts have measured it. On Windows F the last two of OpenBot's five parts took about 10
 * seconds once every byte was in; on Windows D the update's last parts took two.
 */
export const UNPACK_SECONDS = 6;

/** The share of a download's bar its bytes take when parts unpack after them: the rest is theirs. */
const BYTES_SHARE = 0.8;

/**
 * Every byte counts as in from 99%: a download's last bytes can go uncounted between its progress
 * reports, and Windows F read "1.1 GB of 1.1 GB · 2 of 5 parts left" under a full bar for minutes.
 */
export const ALL_IN = 0.99;

/**
 * Every byte is in, or as good as: 99% of them, or 90% with nothing arriving any more (a speed of
 * 0 over the last seconds). On Windows F the row read "1.1 GB of 1.1 GB · 3 of 5 parts left" for
 * ten seconds after the transfer had ended, with some of its bytes never counted.
 */
export function allBytesIn({
  bytes,
  size,
  bytesPerSecond,
}: {
  bytes: number;
  size?: number;
  bytesPerSecond?: number;
}): boolean {
  if (!size || size <= 0) return false;
  const got = bytes / size;
  return got >= ALL_IN || (got >= 0.9 && bytesPerSecond === 0);
}

/**
 * A download's speed is steady enough to say a time from once it has run 3 seconds and brought in
 * 5 MB. Before that, Windows F said "About 164011 minutes left" for its first 538 bytes.
 */
export const STEADY_SECONDS = 3;
export const STEADY_BYTES = 5_000_000;

/** How far along a download and the unpacking of its parts are. */
export type DownloadWhere = {
  /** From 0 to 1, and below 1 while any part is left. Null while its size is not known. */
  fraction: number | null;
  /** Once every byte is in: the part unpacking now, of how many. */
  unpacking: { at: number; of: number } | null;
  /** Seconds left, or null when not known yet or when it is taking longer than usual. */
  left: number | null;
  /** Running well past when the part unpacking now should have finished. */
  slow: boolean;
};

/**
 * Where a download is: its bytes, then its parts unpacking one by one (`done` of `total`), weighed
 * as one. A full bar while parts were still unpacking read as done, or as stuck; now the bytes take
 * most of the bar and each part its slice of the rest, and the part unpacking now eases through its
 * slice, slowing rather than stopping, so the bar keeps moving and is full only once every part is.
 * `waited` is the seconds since the last part finished, or since every byte came in if that was
 * later; `perPart` is how long a part has taken in this download once its own parts say.
 */
export function downloadWhere(
  {
    bytes,
    size,
    done = 0,
    total = 0,
    bytesPerSecond,
  }: {
    bytes: number;
    size?: number;
    done?: number;
    total?: number;
    bytesPerSecond?: number;
  },
  waited = 0,
  perPart: number | null = null,
  /** Its speed is steady enough to say a time from (`STEADY_SECONDS`, `STEADY_BYTES`). */
  steady = true,
  /**
   * Every byte was in once already (`seeParts`). It stays unpacking until every part is: on
   * Windows F the row went back for a few seconds from "Unpacking OpenBot (3 of 5)" to
   * "Downloading OpenBot. About 2 minutes left." as a report briefly counted its bytes short.
   */
  wasAllIn = false,
): DownloadWhere {
  if (!size || size <= 0)
    return { fraction: null, unpacking: null, left: null, slow: false };
  const parts = total > 0;
  const allIn = wasAllIn || allBytesIn({ bytes, size, bytesPerSecond });
  // As good as in: counted whole, so the bar does not sit short of its share.
  const got = allIn && parts && done < total ? 1 : Math.min(1, bytes / size);
  const share = parts ? BYTES_SHARE : 1;
  const per = Math.max(2, perPart ?? UNPACK_SECONDS);
  const base =
    share * got + (1 - share) * (parts ? Math.min(1, done / total) : 0);
  if (parts && done < total && allIn) {
    const into = Math.max(0, waited);
    const eased =
      into <= 0.8 * per
        ? into / per
        : 0.8 + 0.15 * (1 - Math.exp(-(into - 0.8 * per) / per));
    const slow = into > 3 * per + 20;
    return {
      fraction: Math.min(0.999, base + ((1 - share) / total) * eased),
      unpacking: { at: done + 1, of: total },
      left: slow ? null : Math.max(0, (total - done - eased) * per),
      slow,
    };
  }
  const left =
    steady && bytesPerSecond && bytesPerSecond > 0 && got < 1
      ? (size - bytes) / bytesPerSecond + (parts && done < total ? per : 0)
      : null;
  return {
    fraction: parts && done < total ? Math.min(0.999, base) : base,
    unpacking: null,
    left,
    slow: false,
  };
}

/** What a download's parts have done so far, as one screen has watched them. */
export type PartsSeen = {
  /** When the download was first seen. */
  first: number;
  done: number;
  /** When the count of finished parts last changed. */
  changed: number;
  /** When every byte was in, once it was. */
  allIn: number | null;
  doneAtAllIn: number;
};

/**
 * A download's parts as watched at `now`: how long since the last part finished or every byte came
 * in (`waited`), and how long a part has taken here once any finished after that (`perPart`).
 */
export function seeParts(
  seen: PartsSeen | null,
  downloads: {
    bytes: number;
    size?: number;
    done?: number;
    bytesPerSecond?: number;
  },
  now: number,
): {
  seen: PartsSeen;
  waited: number;
  perPart: number | null;
  /** Its speed is steady enough to say a time from. */
  steady: boolean;
  /** Every byte has been in at some point. */
  allIn: boolean;
} {
  const { bytes, done = 0 } = downloads;
  let next: PartsSeen = seen ?? {
    first: now,
    done,
    changed: now,
    allIn: null,
    doneAtAllIn: 0,
  };
  if (done !== next.done) next = { ...next, done, changed: now };
  if (allBytesIn(downloads) && next.allIn === null)
    next = { ...next, allIn: now, doneAtAllIn: done };
  const steady =
    now - next.first >= STEADY_SECONDS * 1000 && bytes >= STEADY_BYTES;
  const perPart =
    next.allIn !== null && done > next.doneAtAllIn
      ? (next.changed - next.allIn) / 1000 / (done - next.doneAtAllIn)
      : null;
  const waited =
    next.allIn === null
      ? 0
      : Math.max(0, (now - Math.max(next.changed, next.allIn)) / 1000);
  return { seen: next, waited, perPart, steady, allIn: next.allIn !== null };
}

/**
 * The time left to show, from the one just worked out (`raw`) and the one shown before: it falls
 * by at most `FALL` seconds a second more than the time that passed when the work goes faster, and
 * rises by at most `RISE` seconds a second when it goes slower, so it never says a low number and
 * then a much higher one, and the bar never leaps. On
 * Windows D an update said "About a minute left", then "About 2", then "About 3" as its parts
 * came to light.
 */
export function steadyLeft(
  shown: { left: number; at: number } | null,
  raw: number,
  now: number,
): { left: number; at: number } {
  if (!shown) return { left: raw, at: now };
  const passed = Math.max(0, (now - shown.at) / 1000);
  return {
    left: Math.max(
      shown.left - (1 + FALL) * passed,
      Math.min(raw, shown.left + RISE * passed),
    ),
    at: now,
  };
}

/** The most the time left shown may rise, in seconds for each second that passes. */
export const RISE = 0.5;

/**
 * The most it may fall beyond the second that passed, so a better estimate (a download's speed
 * once steady) eases in over a few seconds rather than leaping the bar forward.
 */
export const FALL = 3;

/** Bytes a second to plan with until a download's own speed is known: 10 MB a second. */
const ASSUMED_SPEED = 10_000_000;

/**
 * A download under way, as a leg of its own: how long it takes is what is left of it, bytes and
 * unpacking, at its speed so far (`downloadWhere`). The steps it holds up stand still meanwhile, so
 * a slow line reads as a download that is moving, not a step taking longer than usual.
 */
export function downloadLeg(
  said: string,
  downloads: {
    bytes: number;
    size?: number;
    done?: number;
    total?: number;
    bytesPerSecond?: number;
  },
  where: DownloadWhere = downloadWhere(downloads),
  /** How long the stretch it stands in for typically takes, to plan with until it has a speed. */
  typical: number | null = null,
  /** Its speed is steady enough to plan with (`seeParts`). */
  steady = true,
): Leg {
  const { size, total = 0, bytesPerSecond } = downloads;
  const measured = steady && Boolean(bytesPerSecond && bytesPerSecond > 0);
  const speed = measured ? (bytesPerSecond as number) : ASSUMED_SPEED;
  // Until it has a speed, as long as that stretch usually takes; with no size either, a minute.
  const planned =
    !measured && typical !== null
      ? typical
      : size && size > 0
        ? Math.max(1, size / speed) + total * UNPACK_SECONDS * 0.5
        : 60;
  const fraction = where.fraction ?? 0;
  // With a time left it stands behind, the leg is what is left of it from where it is now.
  const seconds =
    measured && where.left !== null && fraction < 1
      ? Math.max(1, where.left / (1 - fraction))
      : where.unpacking && where.left !== null && fraction < 1
        ? Math.max(1, where.left / (1 - fraction))
        : planned;
  return {
    plan: { milestones: {}, stages: [{ said, until: seconds }] },
    state: "now",
    at: { at: Math.min(seconds, fraction * seconds), slow: where.slow },
  };
}

/** "About 3 minutes left", "Less than a minute left", or that it is taking longer. */
export function leftSaid(left: number | null): string {
  if (left === null) return "Taking longer than usual, still working";
  if (left < 60) return "Less than a minute left";
  const minutes = Math.round(left / 60);
  return minutes <= 1 ? "About a minute left" : `About ${minutes} minutes left`;
}
