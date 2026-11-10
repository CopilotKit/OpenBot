import { useEffect, useRef, useState } from "react";
import {
  CONNECT,
  type DownloadWhere,
  downloadLeg,
  downloadWhere,
  journey,
  type Leg,
  leftSaid,
  OPEN,
  type PartsSeen,
  type Plan,
  position,
  SETUP,
  seeParts,
  steadyLeft,
  UPDATE,
  WAIT,
} from "./journey";
import type { LocalSequence } from "./LocalIntelligence";
import {
  type Downloads,
  formatDownloadBytes,
  formatElapsed,
  type Progress,
} from "./SetupProgress";

/**
 * OpenBot updating itself during Start (`upgrade::now_said`), by the line its row says as each step
 * begins, measured on Windows D updating 1.0.1-internal.1008 to 1012: getting it ready (stopping
 * OpenBot and backing up its data) about 20 seconds, the 944 MB download about 50, installing it a
 * moment, then starting it and waiting until it answers about 35. OpenBot's own start is the last of
 * it, so a Start that updates OpenBot has no separate leg for it.
 */
export const RELEASE: Plan = {
  milestones: {
    "Stopping OpenBot.": 2,
    "Backing up your data.": 8,
    "Downloading the update.": 21,
    "Installing the update.": 71,
    "Starting OpenBot.": 73,
  },
  stages: [
    { said: "Getting the update ready", until: 21 },
    { said: "Downloading the update", until: 71 },
    { said: "Installing the update", until: 73 },
    { said: "Starting the updated OpenBot", until: 108 },
  ],
  download: { from: 21, to: 71 },
};

const PHASE_ORDER = ["setup", "connect", "wait", "start"] as const;

/** Seconds into a run before its time left is held steady (`steadyLeft`). */
export const SETTLING = 10;

const seconds = (since: number | null, now: number) =>
  since === null ? 0 : Math.max(0, (now - since) / 1000);

/** "100.0 MB of 944.2 MB", or how much has arrived when that is all there is to say. */
function measured({ bytes, size }: Downloads): string {
  return size && size > 0 && bytes < size
    ? `${formatDownloadBytes(bytes)} of ${formatDownloadBytes(size)}`
    : `${formatDownloadBytes(bytes)} downloaded`;
}

/** The download a Start is waiting on now, and what it is for, if one is under way. */
export function downloadNow(
  sequence: LocalSequence,
  open: readonly Progress[],
): { said: string; unpacking: string; downloads: Downloads } | null {
  const releasing = open.some((row) => row.step === "release" && row.running);
  if (sequence.running && sequence.download)
    return sequence.trailKind === "update"
      ? {
          said: "Downloading the update",
          unpacking: "Unpacking the update",
          downloads: sequence.download,
        }
      : {
          said: "Downloading the rest of OpenBot",
          unpacking: "Unpacking OpenBot",
          downloads: sequence.download,
        };
  const row = open.find((row) => row.running && row.downloads);
  if (!row?.downloads) return null;
  return releasing
    ? {
        said: "Downloading the update",
        unpacking: "Unpacking the update",
        downloads: row.downloads,
      }
    : {
        said: "Downloading the rest of OpenBot",
        unpacking: "Unpacking OpenBot",
        downloads: row.downloads,
      };
}

/** What `startLegs` needs to know beyond the sequence and OpenBot's own rows. */
export type LegClocks = {
  /** Seconds the leg under way has spent waiting on a download: the download's, not its own. */
  held?: number;
  /** When OpenBot's own start began. */
  opening?: number | null;
  /** The leg under way has had its download: what it stood in for is done. */
  downloaded?: boolean;
  /** Start updates OpenBot itself (`upgrade_due`): its leg is in the journey from the start. */
  releaseDue?: boolean;
  /** Where the download under way is, with its parts as watched (`downloadWhere`). */
  where?: DownloadWhere;
  /** The download's speed is steady enough to plan with (`seeParts`). */
  steady?: boolean;
};

/**
 * The legs of one Start, as the screen shows it: the back end's setup and connection when this run
 * began there, its start or its update, then OpenBot's own start, or OpenBot updating itself, which
 * ends with its start. A download under way is a leg of its own, in front of the one it holds up,
 * and stands in for that leg's own download stretch (`Plan.download`), so it is not counted twice.
 * `open` is what `start_stack` or `upgrade_and_start` reports (`setup:progress`).
 */
export function startLegs(
  sequence: LocalSequence,
  open: readonly Progress[],
  now: number,
  {
    held = 0,
    opening = null,
    downloaded = false,
    releaseDue = false,
    where,
    steady = true,
  }: LegClocks = {},
): Leg[] {
  const began = PHASE_ORDER.indexOf(sequence.began ?? "wait");
  const at = sequence.at ? PHASE_ORDER.indexOf(sequence.at) : -1;
  const state = (index: number): Leg["state"] =>
    at > index ? "done" : at === index ? "now" : "next";
  const release = open.find((row) => row.step === "release");
  // The leg under way. Its download's time is the download's, and once it has had one, its own
  // clock counts that stretch as taking as long as it typically does, so it carries on from there.
  const holding =
    release?.running === true
      ? RELEASE
      : sequence.at === "setup"
        ? SETUP
        : sequence.at === "wait" && sequence.trailKind === "update"
          ? UPDATE
          : null;
  const stretch =
    downloaded && holding?.download
      ? holding.download.to - holding.download.from
      : 0;
  const spent = (since: number | null) =>
    Math.max(0, seconds(since, now) - Math.max(0, held - stretch));
  const legs: Leg[] = [];
  if (began <= 0)
    legs.push({
      plan: SETUP,
      state: state(0),
      at: position(
        SETUP,
        sequence.trailKind === "setup" ? sequence.trail : [],
        spent(sequence.trailSince ?? sequence.since),
      ),
    });
  if (began <= 1)
    legs.push({
      plan: CONNECT,
      state: state(1),
      at: position(CONNECT, [], spent(sequence.since)),
    });
  if (began <= 2) {
    const waiting = state(2);
    if (sequence.updating) {
      const updatingNow = waiting === "now" && sequence.trailKind === "update";
      legs.push({
        plan: UPDATE,
        state: waiting === "done" ? "done" : updatingNow ? "now" : "done",
        at: position(UPDATE, sequence.trail, spent(sequence.trailSince)),
      });
    }
    const services = sequence.services;
    legs.push({
      plan: WAIT,
      state: waiting,
      at: position(
        WAIT,
        [],
        spent(sequence.since),
        services && services.total > 0 ? services.ready / services.total : 0,
      ),
    });
  }
  if (release || releaseDue) {
    // OpenBot updating itself, which ends with its start: done once its row is, or once it says it
    // is starting OpenBot, which is OpenBot's own start.
    const running = release?.running === true;
    legs.push({
      plan: RELEASE,
      state: !release ? "next" : running ? "now" : "done",
      at: position(
        RELEASE,
        release ? [release.detail] : [],
        spent(release?.startedAt ?? opening ?? sequence.since),
      ),
    });
  } else {
    const opened = open
      .filter((row) => !row.running && row.ok)
      .map((row) => row.step);
    legs.push({
      plan: OPEN,
      state: at === 3 ? "now" : "next",
      at: position(OPEN, opened, spent(opening ?? sequence.since)),
    });
  }
  const download = downloadNow(sequence, open);
  const underWay = legs.findIndex((leg) => leg.state === "now");
  const waiting = underWay === -1 ? undefined : legs[underWay];
  // The leg's own download stretch is done once a download has stood in for it.
  if (waiting?.at && waiting.plan.download && (download || downloaded))
    waiting.at = {
      ...waiting.at,
      at: Math.max(waiting.at.at, waiting.plan.download.to),
    };
  if (download) {
    const stretch = waiting?.plan.download;
    const going = where ?? downloadWhere(download.downloads, 0, null);
    legs.splice(
      underWay === -1 ? legs.length : underWay,
      0,
      downloadLeg(
        going.unpacking
          ? `${download.unpacking} (${going.unpacking.at} of ${going.unpacking.of})`
          : download.said,
        download.downloads,
        going,
        stretch ? stretch.to - stretch.from : null,
        steady,
      ),
    );
  }
  return legs;
}

/** What one Start's journey carries from one second to the next. */
export type JourneyClock = {
  run: number | null;
  /** The leg under way, as a key: its clocks start over when it changes. */
  leg: string;
  held: number;
  last: number | null;
  downloaded: boolean;
  opening: number | null;
  parts: PartsSeen | null;
  /** The furthest the bar has been: it never goes back. */
  best: number;
  /** The time left last shown. */
  shown: { left: number; at: number } | null;
};

/** What the journey shows at a moment. */
export type JourneyView = {
  said: string;
  /** From 0 to 1, only ever forward. */
  fraction: number;
  /** Seconds left, as shown, or null while it is taking longer than usual. */
  left: number | null;
  /** The download's measure, while there is one. */
  bytes: string | null;
};

/**
 * One second of a Start's journey: what is happening, how far along, and the time left.
 *
 * How far along is the time so far over the time so far and the time left. A part counts for as
 * long as it took, not for how long it typically takes: on Windows D the bar jumped to 72% before
 * the update's download, its longest part, had begun, because the back end's setup, which had
 * not run at all, counted as three minutes done. Now a long download is most of the bar and
 * moves it with its bytes. The time left is steadied (`steadyLeft`), and the bar never goes back.
 */
export function journeyTick(
  clock: JourneyClock | null,
  sequence: LocalSequence,
  open: readonly Progress[],
  now: number,
  releaseDue = false,
): { clock: JourneyClock; view: JourneyView } {
  const releasing = open.some((row) => row.step === "release" && row.running);
  const leg = `${sequence.runSince}|${sequence.at}|${sequence.trailKind}|${releasing}`;
  let next: JourneyClock =
    clock && clock.run === sequence.runSince
      ? { ...clock }
      : {
          run: sequence.runSince,
          leg: "",
          held: 0,
          last: null,
          downloaded: false,
          opening: null,
          parts: null,
          best: 0,
          shown: null,
        };
  if (next.leg !== leg)
    next = {
      ...next,
      leg,
      held: 0,
      last: null,
      downloaded: false,
      parts: null,
    };
  const download = downloadNow(sequence, open);
  if (download) {
    if (next.last !== null) next.held += Math.max(0, now - next.last);
    next.last = now;
    next.downloaded = true;
  } else next.last = null;
  // OpenBot's own start counts from when it began.
  if (sequence.at === "start" && next.opening === null) next.opening = now;
  let where: DownloadWhere | undefined;
  let steady = true;
  if (download) {
    const watched = seeParts(next.parts, download.downloads, now);
    next.parts = watched.seen;
    where = downloadWhere(
      download.downloads,
      watched.waited,
      watched.perPart,
      watched.steady,
      watched.allIn,
    );
    steady = watched.steady;
  }
  const plans = journey(
    startLegs(sequence, open, now, {
      held: next.held / 1000,
      opening: next.opening,
      downloaded: next.downloaded,
      releaseDue,
      where,
      steady,
    }),
  );
  const slow = plans.left === null;
  const so = seconds(sequence.runSince, now);
  // The first seconds learn what the run holds (an update due, a download's size): the time left
  // settles on that before it is held steady.
  next.shown =
    so < SETTLING
      ? { left: plans.remaining, at: now }
      : steadyLeft(next.shown, plans.remaining, now);
  const fraction = so + next.shown.left > 0 ? so / (so + next.shown.left) : 0;
  next.best = Math.max(next.best, Math.min(0.99, fraction));
  return {
    clock: next,
    view: {
      // Every leg done, for the moment before the screen moves on.
      said: plans.said || "Opening OpenBot",
      fraction: next.best,
      left: slow ? null : Math.round(next.shown.left),
      bytes: download ? measured(download.downloads) : null,
    },
  };
}

/**
 * What a Start is doing now, in plain words, how far along the whole of it is on one bar that only
 * moves forward, the time left, and the time so far.
 *
 * The person on the Start screen saw "Waiting for the back end · In progress · 13s elapsed" for
 * minutes and could not tell what was happening or how far along it was. Every row the screen
 * shows is one journey here: one bar covers them all.
 */
export function StartJourney({
  sequence,
  open,
  now: happening = null,
  releaseDue = false,
}: {
  sequence: LocalSequence;
  open: readonly Progress[];
  /**
   * What the native side says is happening, when it says something the plan cannot know: Docker
   * Desktop starting in its own window, or the software OpenBot runs on starting.
   */
  now?: string | null;
  /** Start updates OpenBot itself (`upgrade_due`). */
  releaseDue?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const clock = useRef<JourneyClock | null>(null);
  const ticked = journeyTick(clock.current, sequence, open, now, releaseDue);
  clock.current = ticked.clock;
  const { view } = ticked;
  const elapsed = Math.floor(seconds(sequence.runSince, now));
  // The journey's lines are phrases: the native side's one sentence is said as one too. A line of
  // several sentences, like Docker Desktop's hand-off, stays as it is.
  const said =
    happening === null
      ? view.said
      : happening.slice(0, -1).includes(". ")
        ? happening
        : happening.replace(/\.$/, "");
  return (
    <section className="journey" aria-label="How far along">
      <div className="journey-head">
        <span className="step-spinner" aria-hidden="true" />
        <span className="journey-said">{said}</span>
        <span className="journey-time">
          {leftSaid(view.left)}
          {/* A download's own measure, so a slow line can be told from a stuck one. On the same
              line, so nothing under the journey moves as a download comes and goes. */}
          {view.bytes && (
            <span className="journey-bytes">
              {" · "}
              {view.bytes}
            </span>
          )}
          <span aria-hidden="true">
            {" · "}
            {formatElapsed(elapsed)} so far
          </span>
        </span>
      </div>
      <progress
        aria-label="How far along"
        aria-valuetext={`${Math.round(view.fraction * 100)}%, ${leftSaid(view.left)}`}
        value={view.fraction}
        max={1}
      />
    </section>
  );
}
