import { useEffect, useRef, useState } from "react";
import {
  CONNECT,
  downloadLeg,
  journey,
  type Leg,
  leftSaid,
  OPEN,
  type Plan,
  position,
  SETUP,
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
 * OpenBot updating itself during Start (`upgrade::now_said`): what each line means is how far along
 * it is. Most of it is the download and the install of its software.
 */
const RELEASE: Plan = {
  milestones: {
    "Stopping OpenBot.": 2,
    "Backing up your data.": 4,
    "Downloading the update.": 6,
    "Installing the update.": 60,
    "Starting OpenBot.": 100,
  },
  stages: [
    { said: "Getting the update ready", until: 6 },
    { said: "Downloading the update", until: 60 },
    { said: "Installing the update", until: 100 },
    { said: "Starting the updated OpenBot", until: 120 },
  ],
};

const PHASE_ORDER = ["setup", "connect", "wait", "start"] as const;

/** "100.0 MB of 944.2 MB", or how much has arrived when that is all there is to say. */
function measured({ bytes, size }: Downloads): string {
  return size && size > 0 && bytes < size
    ? `${formatDownloadBytes(bytes)} of ${formatDownloadBytes(size)}`
    : `${formatDownloadBytes(bytes)} downloaded`;
}

const seconds = (since: number | null, now: number) =>
  since === null ? 0 : Math.max(0, (now - since) / 1000);

/** The download a Start is waiting on now, and what it is for, if one is under way. */
export function downloadNow(
  sequence: LocalSequence,
  open: readonly Progress[],
): { said: string; downloads: Downloads } | null {
  const releasing = open.some((row) => row.step === "release" && row.running);
  if (sequence.running && sequence.download)
    return {
      said:
        sequence.trailKind === "update"
          ? "Downloading the update"
          : "Downloading the rest of OpenBot",
      downloads: sequence.download,
    };
  const row = open.find((row) => row.running && row.downloads);
  return row?.downloads
    ? {
        said: releasing
          ? "Downloading the update"
          : "Downloading the rest of OpenBot",
        downloads: row.downloads,
      }
    : null;
}

/**
 * The legs of one Start, as the screen shows it: the back end's setup and connection when this run
 * began there, its start or its update, then OpenBot's own start, with OpenBot's own update when
 * Start does one. A download under way is a leg of its own, in front of the one it holds up.
 * `open` is what `start_stack` reports (`setup:progress`).
 *
 * `held` is how long the leg under way has spent waiting on a download, which does not count as
 * its own time: without it, a leg that waited three minutes on its download read as taking longer
 * than usual the moment the download ended. `opening` is when OpenBot's own start began, after any
 * update of it.
 */
export function startLegs(
  sequence: LocalSequence,
  open: readonly Progress[],
  now: number,
  { held = 0, opening = null }: { held?: number; opening?: number | null } = {},
): Leg[] {
  const began = PHASE_ORDER.indexOf(sequence.began ?? "wait");
  const at = sequence.at ? PHASE_ORDER.indexOf(sequence.at) : -1;
  const state = (index: number): Leg["state"] =>
    at > index ? "done" : at === index ? "now" : "next";
  const spent = (since: number | null) =>
    Math.max(0, seconds(since, now) - held);
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
  const release = open.find((row) => row.step === "release" && row.running);
  if (release)
    legs.push({
      plan: RELEASE,
      state: "now",
      at: position(
        RELEASE,
        [release.detail],
        spent(release.startedAt ?? sequence.since),
      ),
    });
  const opened = open
    .filter((row) => !row.running && row.ok)
    .map((row) => row.step);
  legs.push({
    plan: OPEN,
    state: at === 3 && !release ? "now" : "next",
    at: position(OPEN, opened, spent(opening ?? sequence.since)),
  });
  const download = downloadNow(sequence, open);
  if (download) {
    const held = legs.findIndex((leg) => leg.state === "now");
    legs.splice(
      held === -1 ? legs.length : held,
      0,
      downloadLeg(download.said, download.downloads),
    );
  }
  return legs;
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
}: {
  sequence: LocalSequence;
  open: readonly Progress[];
  /**
   * What the native side says is happening, when it says something the plan cannot know: Docker
   * Desktop starting in its own window, or the software OpenBot runs on starting.
   */
  now?: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const download = downloadNow(sequence, open);
  const releasing = open.some((row) => row.step === "release" && row.running);
  // The time the leg under way has spent on a download, which is the download's, not its own.
  const leg = `${sequence.runSince}|${sequence.at}|${sequence.trailKind}|${releasing}`;
  const clock = useRef({
    leg,
    held: 0,
    last: null as number | null,
    run: sequence.runSince,
    opening: null as number | null,
  });
  if (clock.current.run !== sequence.runSince)
    clock.current = {
      leg: "",
      held: 0,
      last: null,
      run: sequence.runSince,
      opening: null,
    };
  if (clock.current.leg !== leg)
    clock.current = { ...clock.current, leg, held: 0, last: null };
  if (download) {
    if (clock.current.last !== null)
      clock.current.held += Math.max(0, now - clock.current.last);
    clock.current.last = now;
  } else clock.current.last = null;
  // OpenBot's own start counts from when it began, after any update of OpenBot itself.
  if (sequence.at === "start" && !releasing && clock.current.opening === null)
    clock.current.opening = now;
  const where = journey(
    startLegs(sequence, open, now, {
      held: clock.current.held / 1000,
      opening: clock.current.opening,
    }),
  );
  // Never backward, for one run: a leg learned of partway (an update) holds the bar, not resets it.
  const best = useRef({ run: sequence.runSince, fraction: 0 });
  if (best.current.run !== sequence.runSince)
    best.current = { run: sequence.runSince, fraction: 0 };
  best.current.fraction = Math.max(best.current.fraction, where.fraction);
  const shown = best.current.fraction;
  const elapsed = Math.floor(seconds(sequence.runSince, now));
  // The journey's lines are phrases: the native side's one sentence is said as one too. A line of
  // several sentences, like Docker Desktop's hand-off, stays as it is.
  const said =
    happening === null
      ? where.said
      : happening.slice(0, -1).includes(". ")
        ? happening
        : happening.replace(/\.$/, "");
  return (
    <section className="journey" aria-label="How far along">
      <div className="journey-head">
        <span className="step-spinner" aria-hidden="true" />
        <span className="journey-said">{said}</span>
        <span className="journey-time">
          {leftSaid(where.left)}
          {/* A download's own measure, so a slow line can be told from a stuck one. On the same
              line, so nothing under the journey moves as a download comes and goes. */}
          {download && (
            <span className="journey-bytes">
              {" · "}
              {measured(download.downloads)}
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
        aria-valuetext={`${Math.round(shown * 100)}%, ${leftSaid(where.left)}`}
        value={shown}
        max={1}
      />
    </section>
  );
}
