// What this browser's Recorder is doing, told to the OpenBot it is connected to (`recorderActivitySchema` in
// shared/recorder-api.ts): whenever its recording phase or its recording changes, and every 30 s while a recording runs,
// so OpenBot can show it (the Browser button's red dot) wherever the person records, their own everyday browser or the
// OpenBot browser. Every connection reports, whatever made it.
//
// Best effort. Nothing here holds up Record or Stop, and nothing here can fail them: a report goes out on its own, one at
// a time, always with the newest state, and OpenBot not answering, or answering anything but signed out, is let go
// (OpenBot treats a report older than 90 s as stale, so one that never arrives ends the red dot rather than freezing
// it). A signed-out answer goes the way any other signed-out answer goes.
import {
  type RecorderActivity,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import type { RecorderState } from "../protocol/messages";
import { OpenBotError, openbotJson } from "../shared/openbot-client";

/** How often a running recording reports, well inside the 90 s after which OpenBot treats a report as stale. */
export const ACTIVITY_REPORT_MS = 30_000;
/** A report OpenBot has not answered in this long is let go, so the next one is not held behind it. */
const REPORT_WAIT_MS = 10_000;
/** `recorderActivitySchema`'s longest title. */
const TITLE_MAX = 200;

/** The connection a report goes with: the live recording's, else the stored one. */
export type ActivityTarget = {
  openbotUrl: string;
  token: string;
  userId: string;
};

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type ActivityDeps = {
  state: () => RecorderState;
  target: () => Promise<ActivityTarget | null>;
  /** OpenBot answered a report signed out: the recording controller's own sign-out path. */
  signedOut: (
    reason: "revoked" | "removed" | "organization",
    target: ActivityTarget,
  ) => Promise<void>;
  timers: Timers;
};

/** The report for a recorder state, as the contract types it. */
export function activityOf(state: RecorderState): RecorderActivity {
  return {
    phase: state.phase,
    ...(state.recordingId ? { recordingId: state.recordingId } : {}),
    ...(state.title !== undefined
      ? { title: state.title.slice(0, TITLE_MAX) }
      : {}),
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    actions: state.actions,
  };
}

export type ActivityReport = {
  /** The phase or the recording changed (or a restarted service worker found one running): report now, and every 30 s
   * from here while a recording runs. */
  changed(): void;
};

export function createActivityReport(deps: ActivityDeps): ActivityReport {
  let sending = false;
  let again = false;
  let heartbeat: unknown = null;

  async function post(): Promise<void> {
    const target = await deps.target();
    if (!target) return;
    try {
      await openbotJson(target, recorderPaths.activity, {
        body: activityOf(deps.state()),
        signal: AbortSignal.timeout(REPORT_WAIT_MS),
      });
    } catch (error) {
      if (error instanceof OpenBotError && error.signedOut)
        await deps.signedOut(error.body?.reason ?? "revoked", target);
      // OpenBot refusing the report itself (400, or 415 for a body that is not JSON) is the Recorder's own mistake: said
      // in the worker's console, and the next report goes as usual.
      else if (
        error instanceof OpenBotError &&
        (error.status === 400 || error.status === 415)
      )
        console.error("Recorder: OpenBot refused its activity report", error);
      // Anything else (OpenBot unreachable, slow, or one with no activity route yet) waits for the next report.
    }
  }

  /** One report at a time, in order, each with the state as it is when it leaves: a change while one is out sends once
   * more after it, so the last state is always the last one OpenBot hears. */
  function send(): void {
    if (sending) {
      again = true;
      return;
    }
    sending = true;
    void (async () => {
      try {
        do {
          again = false;
          await post();
        } while (again);
      } catch (error) {
        console.error("Recorder: reporting what it records failed", error);
      } finally {
        sending = false;
      }
    })();
  }

  function beat(): void {
    if (heartbeat !== null) deps.timers.clear(heartbeat);
    heartbeat = null;
    if (deps.state().phase === "idle") return;
    heartbeat = deps.timers.set(() => {
      heartbeat = null;
      send();
      beat();
    }, ACTIVITY_REPORT_MS);
  }

  return {
    changed() {
      send();
      beat();
    },
  };
}
