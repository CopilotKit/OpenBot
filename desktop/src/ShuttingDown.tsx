import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import {
  journey,
  type Leg,
  leftSaid,
  type Plan,
  position,
  steadyLeft,
} from "./journey";
import { formatElapsed, type Progress, SetupProgress } from "./SetupProgress";

/**
 * The Shutting down screen's rows, as `quit:progress` carries them: the whole list each time, with
 * a sequence that only rises, so whichever copy is newest wins.
 */
export type QuitStatus = { seq: number; steps: Progress[] };

/** The setup page's fragment that the native side opens to show this screen alone. */
const SHUTTING_DOWN_HASH = "#shutting-down";

export function isShuttingDownPage(hash: string): boolean {
  return hash === SHUTTING_DOWN_HASH;
}

/**
 * The rows of a Quit in progress, or null while nobody has quit.
 *
 * `catchUp` also asks for the rows sent before this page loaded, for a window the native side
 * navigated here once the cleanup had already begun.
 */
export function useQuitStatus(catchUp: boolean): QuitStatus | null {
  const [status, setStatus] = useState<QuitStatus | null>(null);
  useEffect(() => {
    let active = true;
    const keep = (next: QuitStatus | null) => {
      if (!active || !next) return;
      setStatus((current) =>
        current && current.seq >= next.seq ? current : next,
      );
    };
    const stop = listen<QuitStatus>("quit:progress", (event) =>
      keep(event.payload),
    );
    if (catchUp) {
      stop
        .then(() => invoke<QuitStatus | null>("quit_status"))
        .then(keep)
        // The rows still arrive as events; the screen does not depend on this answer.
        .catch(() => {});
    }
    return () => {
      active = false;
      stop.then((unlisten) => unlisten());
    };
  }, [catchUp]);
  return status;
}

/**
 * The parts of a Quit, in order, and how long each typically takes: on Windows D stopping OpenBot
 * took 14 seconds and stopping its services about 12. An update let finish first takes as long as
 * what is left of it, a minute or so.
 */
export const QUIT_PARTS: { step: string; plan: Plan }[] = [
  {
    step: "finish-update",
    plan: {
      milestones: {},
      stages: [
        {
          said: "Finishing the update so nothing is left half done",
          until: 60,
        },
      ],
    },
  },
  {
    step: "stop-openbot",
    plan: {
      milestones: {},
      stages: [{ said: "Closing OpenBot's apps", until: 14 }],
    },
  },
  {
    step: "stop-intelligence",
    plan: {
      milestones: {},
      stages: [{ said: "Closing OpenBot's services", until: 14 }],
    },
  },
  // Only on a Mac where OpenBot paused the person's own Podman while it ran (`own_machine`).
  {
    step: "start-your-podman",
    plan: {
      milestones: {},
      stages: [{ said: "Starting your Podman again", until: 25 }],
    },
  },
];

/** What a Quit's journey carries from one second to the next. */
export type QuitClock = {
  began: number;
  /** When each part was first seen running. */
  started: Record<string, number>;
  shown: { left: number; at: number } | null;
  best: number;
};

/**
 * One second of a Quit: what it is doing, how far along on a bar that only moves forward, and the
 * time left. The parts still to come count as long as they typically take; an update let finish
 * is counted only when there is one.
 */
export function quitTick(
  clock: QuitClock | null,
  steps: readonly Progress[],
  now: number,
): { clock: QuitClock; said: string; fraction: number; left: number | null } {
  const next: QuitClock = clock
    ? { ...clock, started: { ...clock.started } }
    : { began: now, started: {}, shown: null, best: 0 };
  const legs: Leg[] = [];
  for (const { step, plan } of QUIT_PARTS) {
    const row = steps.find((known) => known.step === step);
    if (!row && (step === "finish-update" || step === "start-your-podman"))
      continue;
    if (row?.running && next.started[step] === undefined)
      next.started[step] = now;
    const since = next.started[step] ?? now;
    legs.push({
      plan,
      state: !row ? "next" : row.running ? "now" : "done",
      at: position(plan, [], (now - since) / 1000),
    });
  }
  const where = journey(legs);
  next.shown = steadyLeft(next.shown, where.remaining, now);
  const so = (now - next.began) / 1000;
  const fraction = so + next.shown.left > 0 ? so / (so + next.shown.left) : 0;
  next.best = Math.max(next.best, Math.min(0.99, fraction));
  return {
    clock: next,
    said: where.said || "Closing OpenBot",
    fraction: next.best,
    left: where.left === null ? null : Math.round(next.shown.left),
  };
}

/** A Quit's journey: what it is doing, one bar, the time left and the time so far. */
function QuitJourney({
  steps,
  clock,
}: {
  steps: readonly Progress[];
  /** The quit's clock, kept by the screen for the whole quit (`ShuttingDown`). */
  clock: { current: QuitClock | null };
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();
  const ticked = quitTick(clock.current, steps, now);
  clock.current = ticked.clock;
  const elapsed = Math.floor((now - ticked.clock.began) / 1000);
  return (
    <section className="journey" aria-label="How far along">
      <div className="journey-head">
        <span className="step-spinner" aria-hidden="true" />
        <span className="journey-said">{ticked.said}</span>
        <span className="journey-time">
          {leftSaid(ticked.left)}
          <span aria-hidden="true">
            {" · "}
            {formatElapsed(elapsed)} so far
          </span>
        </span>
      </div>
      <progress
        aria-label="How far along"
        aria-valuetext={`${Math.round(ticked.fraction * 100)}%, ${leftSaid(ticked.left)}`}
        value={ticked.fraction}
        max={1}
      />
    </section>
  );
}

/**
 * What the person sees between choosing Quit and the app closing. Nothing to press. While it runs,
 * the same journey a Start shows: what it is doing, one bar, and the time left. On Windows D it
 * showed only "Stopping OpenBot · In progress · 12s elapsed".
 */
export function ShuttingDown({ status }: { status: QuitStatus | null }) {
  const steps = status?.steps ?? [];
  const failed = steps.some((step) => !step.ok);
  /*
   * The journey stays for the whole quit, with its clock kept here. It was shown only while a
   * step ran, so in the moment between "Stopping OpenBot" finishing and its services starting to
   * stop it went away and came back with a new clock: on Windows F the bar went from 46% to 7% and
   * "14s so far" to "1s so far".
   */
  const clock = useRef<QuitClock | null>(null);
  const running = !failed && status !== null;
  return (
    <main>
      <div className="sheet connection-sheet">
        <h1>Shutting down OpenBot</h1>
        <p className="lede" role="status">
          {failed
            ? "Part of it could not be stopped. OpenBot says what happened the next time it opens."
            : "OpenBot is stopping what it started on this computer, then it closes."}
        </p>
        {running && <QuitJourney steps={steps} clock={clock} />}
        <SetupProgress
          steps={steps}
          label="Shutdown progress"
          showElapsed={!running}
        />
      </div>
    </main>
  );
}

/** The whole window when the native side opened the setup page on this screen. */
export function ShuttingDownWindow() {
  return <ShuttingDown status={useQuitStatus(true)} />;
}
