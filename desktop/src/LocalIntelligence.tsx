import { useEffect, useRef, useState } from "react";
import { CopilotKitSignInWait } from "./CopilotKitSignInWait";
import { ExternalLink } from "./ExternalLink";
import {
  backEndWaitEnded,
  cancelLocalEval,
  chatGate,
  connectLocalEval,
  type LocalConnection,
  LocalEvalError,
  type LocalFailure,
  type LocalReason,
  type LocalReport,
  type LocalTerms,
  localEvalDownload,
  localEvalSteps,
  localEvalTerms,
  localEvalUpdateStep,
  onInstalledRelease,
  runLocalEval,
  setUpLocalEval,
  signInToCopilotKit,
  updateStepSaid,
  wakeEngine,
} from "./localEvalCli";
import { localReadiness, onInstalledReleaseSaid } from "./localReadiness";
import {
  asProblem,
  Failure,
  type Problem,
  TroubleshootingLogs,
} from "./Problem";
import { Lockup } from "./Sections";
import {
  type Downloads,
  type Progress,
  SetupProgress,
  StatusLine,
} from "./SetupProgress";
import { StartJourney } from "./StartJourney";

type Call<T> = { attempt: string; answer: Promise<T> };

/**
 * What Start OpenBot is given for a local stack: its addresses. The key is in the vault.
 *
 * `notice` when the back end is ready on the release it had and an update did not finish: said on
 * the running screen, and the person opens OpenBot from there.
 */
export type LocalStartable = {
  apiUrl: string;
  gatewayWsUrl: string;
  notice?: string;
};

/**
 * What became of one Start OpenBot.
 *
 * `deferred` is a Start that did not run yet because something else has to happen first, such as
 * the installation that Start found it needs. Whoever deferred it gives the go-ahead again once
 * that is done, so it is not a failure and is never said as one.
 */
export type StartOutcome = "started" | "failed" | "deferred";

/**
 * Between status checks while Intelligence reports that it is starting: about three minutes in
 * all, then the person is told and can check again.
 */
const POLL_DELAYS: number[] = [2_000, 4_000, 8_000, ...Array(12).fill(15_000)];

/** How often a running setup or update asks how far its download has got. */
const DOWNLOAD_EVERY_MS = 1_000;

const unreadable: Problem = {
  said: "OpenBot got an answer it couldn't read. Retry. If it happens again, copy the logs below.",
};

type Phase = "setup" | "connect" | "wait" | "start";

/*
 * In the person's words: the back end, its releases and the CLI are the log's business. Every row
 * says what OpenBot is doing for them, and the running one how far along it is ("Step 3 of 4").
 */
const PHASES: [Phase, string][] = [
  ["setup", "Setting up OpenBot"],
  ["connect", "Connecting OpenBot"],
  ["wait", "Getting OpenBot ready"],
  // Not "Starting OpenBot": that is the screen's own heading.
  ["start", "Opening OpenBot"],
];

/** The readiness sentence for one CLI answer or failure category. */
function said(intelligence: LocalReport | LocalFailure): string {
  return localReadiness({
    runtime: "unknown",
    intelligence,
    openBot: "unknown",
    provider: "unvalidated",
  }).intelligence.said;
}

function connectionSaid(answered: LocalConnection): string {
  // A conflict has no reason of its own, so it is said in this window's words.
  if (answered.conflicted) {
    return "Settings OpenBot saved were changed since, so it didn't connect. Retry, or repair the installation.";
  }
  return said({
    outcome: answered.outcome,
    stack: answered.stack,
    reason: answered.reason,
    readiness: "unknown",
    licence: "unknown",
    licenceExpiresAt: null,
    checksPassed: false,
  });
}

function isReady(report: LocalReport): boolean {
  return chatGate({
    intelligence: report,
    openBot: "connected",
    provider: "validated",
  }).open;
}

type State = {
  at: Phase | null;
  running: boolean;
  /** When the current row began, so its elapsed time survives a change of screen. */
  since: number | null;
  blocked: { said: string; reason: LocalReason | null } | null;
  problem: Problem | null;
  /**
   * The agreement version setup was given and still answered "acceptance required" to. The CLI
   * refuses an acceptance it believes a coding agent passed on, so offering the same Accept again
   * would only loop.
   */
  refused: string | null;
  /** What the running row is doing, when it says more than its label. */
  detail: string | null;
  /** How much of the back end's download has arrived, while OpenBot downloads it. */
  download: Downloads | null;
  /**
   * The back end could not be updated to the release this app installs. Said, and not a stop: the
   * release it had is still there and still runs.
   */
  updateFailed: string | null;
  /** The phase this run began at, and when: the whole journey on screen counts from here. */
  began: Phase | null;
  runSince: number | null;
  /** The CLI's steps the running setup or update has finished (`local_eval_steps`), and which. */
  trail: string[];
  trailKind: "setup" | "update" | null;
  /** When the running setup or update began. */
  trailSince: number | null;
  /** This run updated the back end, or is updating it now. */
  updating: boolean;
  /** Of the back end's services, how many the last status said were ready. */
  services: { ready: number; total: number } | null;
};

const idle: State = {
  at: null,
  running: false,
  since: null,
  blocked: null,
  problem: null,
  refused: null,
  detail: null,
  download: null,
  updateFailed: null,
  began: null,
  runSince: null,
  trail: [],
  trailKind: null,
  trailSince: null,
  updating: false,
  services: null,
};

/** The row an update that failed is said on, under the back end's. */
const UPDATING = "Updating OpenBot";

/**
 * The back end's row while it updates. How long it takes and what it is doing now are the
 * journey's (`StartJourney`): the row says only what this part is, and that nothing is lost.
 */
export const UPDATING_SAID =
  "Updating OpenBot. Your Bots and data stay as they are.";

/** The start's row while Start updates OpenBot itself (`upgrade::now_said`). */
export const RELEASE_SAID =
  "Updating OpenBot. Your Bots, sign-ins and data stay as they are.";

/**
 * An update that failed, and where it stopped once the CLI's record says (`failedStep`), in plain
 * words. The step's own name and the releases are in the log (`log_update_due`). Its data is kept
 * either way: `local update` never deletes it, and the next Start repairs what a stopped update left
 * and tries again.
 */
function updateFailedSaid(step: string | null): string {
  const where = step ? ` It stopped while ${updateStepSaid(step)}.` : "";
  return `OpenBot couldn't finish updating, so it runs the version it had.${where} Your data is kept, and OpenBot tries again the next time it starts.`;
}

export type LocalSequence = State & {
  /** Set up, connected and reported ready and valid, and waiting for the go-ahead to start. */
  ready: boolean;
  /** Stopped at its row with a reason; Retry resumes there. */
  stopped: boolean;
  steps: Progress[];
  /** Runs set up, connect and wait, and stops before Start. */
  prepare: () => void;
  /** The go-ahead: runs what is left and starts OpenBot once Intelligence is ready. */
  start: () => void;
  retry: () => void;
  /** The person accepted this agreement version in the window: set up again with it. */
  acceptTerms: (version: string) => void;
  /** Stops the running CLI call and says so. */
  cancel: () => void;
  /** Forgets the rows, as after Stop OpenBot. */
  reset: () => void;
};

/**
 * Intelligence on this computer, run by the Intelligence CLI, then OpenBot started against it.
 *
 * Held by the window rather than by a screen, so moving between screens never cancels it. Four
 * steps, each idempotent, run in order without a button: set up, connect (the installation is the
 * consent, and the native side keeps the key the CLI wrote), wait until the CLI itself reports
 * readiness "ready" and licence "valid", then start OpenBot. `prepare` runs the first three while
 * the person chooses an AI provider; Start waits for `start`. A recorded, connected stack starts
 * at waiting. A step that is blocked or fails stops there with its reason, and Retry resumes at
 * that step. A CLI that does not report ready and valid never reaches Start.
 */
export function useLocalSequence({
  root,
  stack,
  connected = false,
  onStart,
  onRecorded = () => {},
  pollDelays = POLL_DELAYS,
}: {
  root: string;
  stack: string | null;
  /** OpenBot already holds the key `local connect` gave it for this stack. */
  connected?: boolean;
  /** Starts OpenBot against the stack, or says it failed or was deferred. */
  onStart: (startable: LocalStartable) => Promise<StartOutcome>;
  /** A stack was set up, or connected. */
  onRecorded?: (stack: string, connected: boolean) => void;
  pollDelays?: number[];
}): LocalSequence {
  const [state, setState] = useState<State>(idle);
  const now = useRef(state);
  const latest = useRef({ root, stack, connected, onStart, onRecorded });
  latest.current = { root, stack, connected, onStart, onRecorded };
  // Bumped to stop a run: by Cancel, by leaving, and by any newer run.
  const generation = useRef(0);
  const attempt = useRef<string | null>(null);
  const wake = useRef<(() => void) | null>(null);
  const queued = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startable = useRef<LocalStartable | null>(null);
  // Start OpenBot once Intelligence is ready. Spent when it starts.
  const go = useRef(false);
  // The agreement version the person accepted, carried to the next setup and spent once it works.
  const accepted = useRef<string | null>(null);

  function update(patch: Partial<State>) {
    now.current = { ...now.current, ...patch };
    setState(now.current);
  }

  function halt() {
    generation.current += 1;
    wake.current?.();
    if (queued.current !== null) clearTimeout(queued.current);
    queued.current = null;
    const inFlight = attempt.current;
    attempt.current = null;
    if (inFlight) void cancelLocalEval(inFlight);
  }

  // Closing the window stops whatever is running, the CLI call included.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on leaving.
  useEffect(() => halt, []);

  /** Runs one call; a failure category or a problem stops the step. */
  async function call<T>(started: Call<T>, token: number): Promise<T | null> {
    attempt.current = started.attempt;
    try {
      const value = await started.answer;
      return generation.current === token ? value : null;
    } catch (error) {
      if (generation.current !== token) return null;
      if (error instanceof LocalEvalError) {
        if (error.category === "unrecognized") update({ problem: unreadable });
        else update({ blocked: { said: said(error.category), reason: null } });
      } else {
        update({ problem: asProblem(error) });
      }
      return null;
    } finally {
      if (attempt.current === started.attempt) attempt.current = null;
    }
  }

  /**
   * While `attempt` runs, how much of the back end's download has arrived, so a slow line can be
   * told from a stuck one: the Start journey's bar counts it (`StartJourney`), and a screen about
   * something else says it in its own row (`LocalStatus`). OpenBot downloads the images before the
   * CLI pulls them. Returns what stops it.
   */
  function followDownload(attempt: string, token: number): () => void {
    let following = true;
    let shown = false;
    let next: ReturnType<typeof setTimeout> | null = null;
    // The first answer with bytes in it, so the speed so far can say how long is left.
    let first: { at: number; bytes: number } | null = null;
    /*
     * Only while the run it reports on is current. Halting it (the window closed, or Cancel) only asks the CLI to stop,
     * and the call it followed settles once the CLI has, so a poll that waited for that went on asking every second from
     * a window no longer there.
     */
    const current = () => following && generation.current === token;
    const ask = () => {
      if (!current()) return;
      localEvalDownload(attempt)
        .then(
          (found) => {
            if (!current()) return;
            if (found) {
              shown = true;
              const at = Date.now();
              first ??= { at, bytes: found.done };
              const seconds = (at - first.at) / 1000;
              update({
                download: {
                  bytes: found.done,
                  size: found.total,
                  ...(seconds >= 3 && found.done > first.bytes
                    ? { bytesPerSecond: (found.done - first.bytes) / seconds }
                    : {}),
                },
              });
            } else if (shown) {
              shown = false;
              update({ download: null });
            }
          },
          () => {},
        )
        .finally(() => {
          if (current()) next = setTimeout(ask, DOWNLOAD_EVERY_MS);
        });
    };
    ask();
    return () => {
      following = false;
      if (next) clearTimeout(next);
      if (shown && generation.current === token) update({ download: null });
    };
  }

  /**
   * While `attempt` runs, which of the CLI's steps it has finished, so the screen can say what it
   * is doing now and how far along it is (`journey.ts`). Returns what stops it.
   */
  function followSteps(
    attempt: string,
    token: number,
    kind: "setup" | "update",
  ): () => void {
    let following = true;
    let next: ReturnType<typeof setTimeout> | null = null;
    const current = () => following && generation.current === token;
    update({ trail: [], trailKind: kind, trailSince: Date.now() });
    const ask = () => {
      if (!current()) return;
      localEvalSteps(attempt)
        .then(
          (found) => {
            // Every answer, so what is said and the time left move on while a step runs.
            if (current() && found) update({ trail: found.ended });
          },
          () => {},
        )
        .finally(() => {
          if (current()) next = setTimeout(ask, DOWNLOAD_EVERY_MS);
        });
    };
    ask();
    return () => {
      following = false;
      if (next) clearTimeout(next);
    };
  }

  function pause(ms: number, token: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake.current = null;
        resolve(generation.current === token);
      }, ms);
      wake.current = () => {
        clearTimeout(timer);
        wake.current = null;
        resolve(false);
      };
    });
  }

  /**
   * Install the release this app's CLI installs over a stack an older app set up, with the CLI's
   * own `local update`, which keeps the stack's data and app connections. Once per wait. A failure
   * is said and does not stop the sequence: the release the stack had is still there, and OpenBot
   * starts on it. False only when the run was stopped meanwhile.
   */
  async function updateIntelligence(
    id: string,
    token: number,
  ): Promise<boolean> {
    // The releases it updates from and to are in the log (`log_update_due`), not on the screen.
    const updating = UPDATING_SAID;
    update({ detail: updating, download: null, updating: true });
    const started = runLocalEval("update", id);
    attempt.current = started.attempt;
    const unfollowTrail = followSteps(started.attempt, token, "update");
    const unfollow = followDownload(started.attempt, token);
    const unfollowSteps = followUpdateSteps(started.attempt, token, updating);
    let updated = false;
    let stalled = false;
    try {
      updated = (await started.report).outcome === "completed";
    } catch (error) {
      updated = false;
      stalled =
        error instanceof LocalEvalError &&
        error.category === "download-stalled";
    } finally {
      unfollowTrail();
      unfollowSteps();
      unfollow();
      if (attempt.current === started.attempt) attempt.current = null;
    }
    // The update is done; its services coming up is the wait's, counted from here.
    if (generation.current === token)
      update({ trailKind: null, since: Date.now() });
    if (generation.current !== token) return false;
    update({
      detail: null,
      download: null,
      updateFailed: updated
        ? null
        : stalled
          ? "The update stopped downloading, so OpenBot runs the version it had. It picks up the download the next time it starts."
          : updateFailedSaid(null),
    });
    return true;
  }

  /**
   * While the update `attempt` runs, a Job of it that failed, said on its row at once rather than
   * ten minutes later, when the CLI gives up waiting on it. Which step it is in and how far along
   * it is are the journey's (`StartJourney`). Returns what stops it.
   */
  function followUpdateSteps(
    attempt: string,
    token: number,
    updating: string,
  ): () => void {
    let following = true;
    let next: ReturnType<typeof setTimeout> | null = null;
    const current = () => following && generation.current === token;
    const ask = () => {
      if (!current()) return;
      localEvalUpdateStep(attempt)
        .then(
          (found) => {
            if (!current() || !found?.failedJob) return;
            // The Job's name is in the log (`watch_jobs`).
            update({
              detail: `${updating} Part of the update didn't work, so it will stop. OpenBot waits up to 10 minutes for it first. Your data is kept.`,
            });
          },
          () => {},
        )
        .finally(() => {
          if (current()) next = setTimeout(ask, DOWNLOAD_EVERY_MS);
        });
    };
    ask();
    return () => {
      following = false;
      if (next) clearTimeout(next);
    };
  }

  /**
   * Status until the CLI reports ready and valid, or anything that waiting will not change.
   * Only "starting" is waited on: unknown is what an older CLI always says. A stopped stack is
   * started once, as its own readiness row offers.
   */
  async function waitForReady(
    id: string,
    token: number,
  ): Promise<LocalStartable | null> {
    const report = (action: "status" | "start") => {
      const started = runLocalEval(action, id);
      return call({ attempt: started.attempt, answer: started.report }, token);
    };
    const stuck = (found: LocalReport) => {
      if (generation.current === token) {
        backEndWaitEnded(said(found));
        update({ blocked: { said: said(found), reason: found.reason } });
      }
      return null;
    };
    let startedIntelligence = false;
    let updatedIntelligence = false;
    // The update ran on a stack found stopped. It starts the cluster itself, so the release the
    // stack had comes back up after a failed one, and is waited on like a stack that is starting.
    let woken = false;
    // The release an update that just failed was moving to, until the next answer says where.
    let failedTo: string | null = null;
    for (let tries = 0; ; tries += 1) {
      const found = await report("status");
      if (!found) return null;
      // How many of its services are up: how far along the back end's start is.
      const services = found.stack?.observed?.services;
      if (services?.length)
        update({
          services: {
            ready: services.filter((service) => service.ready).length,
            total: services.length,
          },
        });
      const unfinished = found.stack?.unfinishedUpdate ?? null;
      const kept = onInstalledRelease(found);
      /*
       * A stack an older app set up runs an older release than this app installs: updated once,
       * before OpenBot starts on it, so OpenBot runs on the release it was built with.
       *
       * ONLY ONCE IT IS UP. The CLI's update rolls the running stack forward and waits for each
       * service to come back (`kubectl rollout status`, three minutes). On a stack Quit had stopped
       * there is nothing running to roll, the wait ran out, and the update failed every time; on the
       * same stack started first it finished in 86 seconds. So a stopped stack is started below as
       * usual, and the update runs on the next answer, when it reports ready.
       *
       * AN UPDATE THAT DID NOT FINISH is tried again the same way, on a stack ready on the release
       * it had. On a stopped one too: there the CLI refuses `start` while the update is on record,
       * and `local update` is the only call that starts the stack.
       */
      if (
        found.updateTo &&
        found.stack &&
        !updatedIntelligence &&
        (found.readiness === "ready" ||
          kept !== null ||
          (found.readiness === "stopped" && unfinished !== null))
      ) {
        updatedIntelligence = true;
        woken = found.readiness === "stopped";
        const going = await updateIntelligence(id, token);
        if (!going) return null;
        if (now.current.updateFailed === updateFailedSaid(null)) {
          failedTo = found.updateTo;
        }
        continue;
      }
      // Where the update that just failed stopped, from the record the CLI kept of it.
      const failedStep = unfinished?.failedStep;
      if (failedTo && failedStep) {
        update({ updateFailed: updateFailedSaid(failedStep) });
      }
      failedTo = null;
      if (isReady(found)) {
        if (!found.stack) {
          update({ blocked: { said: said("missing-stack"), reason: null } });
          return null;
        }
        return {
          apiUrl: found.stack.urls.api,
          gatewayWsUrl: found.stack.urls.gateway,
          ...(kept ? { notice: onInstalledReleaseSaid(kept) } : {}),
        };
      }
      const row = localReadiness({
        runtime: "unknown",
        intelligence: found,
        openBot: "unknown",
        provider: "unvalidated",
      }).intelligence;
      // Not with an update on record: the CLI refuses `start` then (see above).
      if (
        row.action === "start-intelligence" &&
        !startedIntelligence &&
        unfinished === null
      ) {
        startedIntelligence = true;
        const started = await report("start");
        if (!started) return null;
        if (started.outcome !== "completed") return stuck(started);
        continue;
      }
      const waking =
        woken && found.readiness === "degraded" && unfinished !== null;
      if (
        !waking &&
        (found.readiness !== "starting" || row.state === "blocked")
      ) {
        return stuck(found);
      }
      if (tries >= pollDelays.length) {
        const timedOut =
          "OpenBot didn't get ready in time. Retry to check again.";
        // The log says how long it waited and what the back end last said (`back_end_wait_ended`).
        backEndWaitEnded(timedOut);
        update({ blocked: { said: timedOut, reason: null } });
        return null;
      }
      if (!(await pause(pollDelays[tries], token))) return null;
    }
  }

  async function run(from: Phase): Promise<void> {
    halt();
    const token = generation.current;
    update({
      blocked: null,
      problem: null,
      detail: null,
      download: null,
      updateFailed: null,
    });
    const { root } = latest.current;
    let id = latest.current.stack;
    const stop = (reason?: { said: string; reason?: LocalReason | null }) => {
      if (generation.current !== token) return;
      update({
        running: false,
        ...(reason
          ? { blocked: { said: reason.said, reason: reason.reason ?? null } }
          : {}),
      });
    };
    /*
     * The engine first. Every CLI call below needs it, and a relaunch after a restart finds Docker
     * Desktop quit or OpenBot's Podman machine stopped. Without this the CLI answered
     * "docker-unavailable" and the sequence stopped at "Waiting for the back end", before Start,
     * which is where the engine used to be woken. The screen says Docker's hand-off meanwhile (see
     * `handOffNow`), and OpenBot comes back to the front once Docker answers. Start wakes the
     * engine again itself, so a run that only starts OpenBot skips this.
     */
    const began = Date.now();
    // A new run counts from here; Start OpenBot after a run that got ready carries on its journey.
    if (from !== "start" || now.current.began === null)
      update({
        began: from,
        runSince: began,
        trail: [],
        trailKind: null,
        trailSince: null,
        updating: false,
        services: null,
      });
    if (from !== "start") {
      update({ at: from, running: true, since: began });
      try {
        await wakeEngine(root);
      } catch (error) {
        if (generation.current !== token) return;
        update({ problem: asProblem(error) });
        return stop();
      }
      if (generation.current !== token) return;
    }
    for (const [phase] of PHASES.slice(PHASES.findIndex(([p]) => p === from))) {
      if (generation.current !== token) return;
      // Ready, and waiting for the go-ahead.
      if (phase === "start" && !go.current) return stop();
      // The first row keeps the time the engine took, so its elapsed time does not start over.
      update({
        at: phase,
        running: true,
        since: phase === from ? began : Date.now(),
      });
      if (phase === "setup") {
        const carried = accepted.current;
        const started = setUpLocalEval(root, carried);
        const unfollowTrail = followSteps(started.attempt, token, "setup");
        // A setup that resumes a stack downloads the images it still needs first.
        const unfollow = followDownload(started.attempt, token);
        const report = await call(
          { attempt: started.attempt, answer: started.report },
          token,
        ).finally(() => {
          unfollow();
          unfollowTrail();
        });
        if (!report) return stop();
        update({
          refused:
            report.reason === "eula-acceptance-required" ? carried : null,
        });
        if (report.outcome !== "completed") {
          return stop({ said: said(report), reason: report.reason });
        }
        if (!report.stack) return stop({ said: said("missing-stack") });
        accepted.current = null;
        id = report.stack.id;
        latest.current.onRecorded(id, false);
      }
      if (phase === "connect") {
        const started = connectLocalEval(root);
        const answered = await call(
          { attempt: started.attempt, answer: started.connection },
          token,
        );
        if (!answered) return stop();
        if (answered.outcome !== "completed" || answered.conflicted) {
          return stop({
            said: connectionSaid(answered),
            reason: answered.reason,
          });
        }
        id = answered.stack?.id ?? id;
        if (!id) return stop({ said: said("missing-stack") });
        latest.current.onRecorded(id, true);
      }
      if (phase === "wait") {
        if (!id) return stop({ said: said("missing-stack") });
        const found = await waitForReady(id, token);
        if (!found) return stop();
        startable.current = found;
      }
      if (phase === "start") {
        const target = startable.current;
        if (!target) return run("wait");
        const outcome = await latest.current.onStart(target);
        if (outcome === "failed") {
          return stop({ said: "OpenBot did not start." });
        }
        go.current = false;
        // Waiting on something else, which gives the go-ahead again when it is done.
        if (outcome === "deferred") return stop();
      }
    }
    stop();
  }

  const first = (): Phase =>
    latest.current.stack && latest.current.connected ? "wait" : "setup";
  const stopped =
    !state.running &&
    state.at !== null &&
    (state.blocked !== null || state.problem !== null);
  const ready = !state.running && state.at === "wait" && !stopped;

  function prepare() {
    if (now.current.running) return;
    void run(first());
  }

  function start() {
    go.current = true;
    const { at, running, blocked, problem } = now.current;
    // A running sequence starts OpenBot when it gets there; a stopped one waits for Retry.
    if (running || blocked || problem) return;
    const from: Phase = at === "wait" ? "start" : first();
    // Deferred a tick: the screen that gave the go-ahead has rendered what it chose by then, and a
    // development double mount runs the CLI once.
    update({ running: true });
    queued.current = setTimeout(() => {
      queued.current = null;
      void run(from);
    }, 0);
  }

  function retry() {
    const { at } = now.current;
    if (at) void run(at);
  }

  function acceptTerms(version: string) {
    accepted.current = version;
    retry();
  }

  function cancel() {
    halt();
    // Before its first row, nothing ran: there is nothing to retry.
    update(
      now.current.at === null
        ? { running: false }
        : {
            running: false,
            blocked: { said: said("cancelled"), reason: null },
          },
    );
  }

  function reset() {
    halt();
    go.current = false;
    startable.current = null;
    update(idle);
  }

  const reached = state.at
    ? PHASES.findIndex(([phase]) => phase === state.at)
    : -1;
  const steps: Progress[] = PHASES.slice(0, reached + 1).flatMap(
    ([phase, label], index): Progress[] => {
      const row: Progress =
        index < reached
          ? { step: label, ok: true, detail: "" }
          : state.running
            ? {
                step: label,
                ok: true,
                running: true,
                // What is happening now and how long is left is the journey's (`StartJourney`): the
                // row says only what is particular to it, such as an update's download.
                detail: state.detail ?? "",
                downloads: state.download ?? undefined,
                startedAt: state.since ?? undefined,
                position: { at: index + 1, of: PHASES.length },
              }
            : stopped
              ? { step: label, ok: false, detail: state.blocked?.said ?? "" }
              : { step: label, ok: true, detail: "" };
      return phase === "wait" && state.updateFailed
        ? [row, { step: UPDATING, ok: false, detail: state.updateFailed }]
        : [row];
    },
  );

  return {
    ...state,
    ready,
    stopped,
    steps,
    prepare,
    start,
    retry,
    acceptTerms,
    cancel,
    reset,
  };
}

/**
 * The local sequence's rows and its one control at a time: Cancel while a CLI call runs, Retry
 * once it stopped, and Start OpenBot when nothing has run yet and `offerStart` is set.
 */
export function LocalIntelligence({
  sequence,
  offerStart = false,
  handOff = null,
  open = [],
  releaseDue = false,
}: {
  sequence: LocalSequence;
  offerStart?: boolean;
  /** Start updates OpenBot itself (`upgrade_due`): the journey counts it from the start. */
  releaseDue?: boolean;
  /** What Docker Desktop's window may want while the engine wakes: see `handOffNow`. */
  handOff?: string | null;
  /** What OpenBot's own start reports (`setup:progress`): the journey's last stretch. */
  open?: readonly Progress[];
}) {
  const { at, running, stopped, problem } = sequence;
  // While it runs, one journey says what is happening and how far along the whole Start is. The
  // rows then say which part is done and which is left, and nothing twice.
  const journeying = offerStart && running && !stopped;
  // Its download's bar is the journey's too: the running row keeps only what is particular to it.
  const releasing = open.some((row) => row.step === "release" && row.running);
  const rows = journeying
    ? sequence.steps.map((row) =>
        row.running
          ? {
              ...row,
              downloads: undefined,
              detail: at === "start" && releasing ? RELEASE_SAID : row.detail,
            }
          : row,
      )
    : sequence.steps;

  return (
    <section aria-label="OpenBot on this computer">
      {journeying && (
        <StartJourney
          sequence={sequence}
          open={open}
          now={handOff}
          releaseDue={releaseDue}
        />
      )}
      <SetupProgress steps={rows} showElapsed={!journeying} />
      {handOff && !journeying && <StatusLine>{handOff}</StatusLine>}
      <LocalNeeds sequence={sequence} />
      {stopped && problem && <Failure problem={problem} />}
      <div className="row">
        {running && at !== "start" && (
          <button type="button" className="quiet" onClick={sequence.cancel}>
            Cancel
          </button>
        )}
        {stopped && (
          <button type="button" onClick={sequence.retry}>
            Retry
          </button>
        )}
        {offerStart && !running && at === null && (
          <button type="button" onClick={sequence.start}>
            Start OpenBot
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Intelligence on a screen that is about something else: nothing while it works, and a card that
 * cannot be missed when it stops. The person is installing OpenBot or choosing an AI here; a second
 * progress line competed with that, and its full progress has its own step later. A stop is shown
 * at once, because finding out only at that later step would waste the minutes since: one they
 * clear themselves (signing in, accepting the agreement) with its action, anything else with Retry.
 */
export function LocalStatus({
  sequence,
  download = true,
}: {
  sequence: LocalSequence;
  /** Its download's row too. Off where the background install's row says it already. */
  download?: boolean;
}) {
  if (!sequence.stopped) {
    // The rest of OpenBot downloads behind the screen in front: say how far, so the wait is visible.
    if (!download || !sequence.running || !sequence.download) return null;
    return (
      <SetupProgress
        label="OpenBot download"
        showElapsed={false}
        steps={[
          {
            step: "Downloading the rest of OpenBot",
            ok: true,
            running: true,
            // The row says the time left from the download's own speed.
            detail: "",
            downloads: sequence.download,
            // The install's third part, alongside the second on the Install step.
            position: { at: 3, of: 4 },
          },
        ]}
      />
    );
  }
  const needs = needsPerson(sequence);
  // Stopped at Start: Intelligence got as far as ready and licensed, and OpenBot is what failed.
  const openBot = !needs && sequence.at === "start";
  return (
    <section
      className={`local-alert${needs ? " needs" : ""}`}
      role="alert"
      aria-label={openBot ? "OpenBot" : "Setup"}
    >
      <h2>
        {needs
          ? "Setup needs you"
          : openBot
            ? "OpenBot did not start"
            : "Setup stopped"}
      </h2>
      {needs ? (
        <LocalNeeds sequence={sequence} />
      ) : (
        <>
          <p>
            {openBot
              ? "Everything else is ready. Retry starts OpenBot again."
              : (sequence.blocked?.said ?? sequence.problem?.said)}
          </p>
          <div className="row">
            <button type="button" onClick={sequence.retry}>
              Retry
            </button>
          </div>
          <TroubleshootingLogs
            problem={
              sequence.problem ??
              (sequence.blocked ? { said: sequence.blocked.said } : null)
            }
          />
        </>
      )}
    </section>
  );
}

/**
 * What the person does when local setup stops for them, in the window where it stopped: sign in,
 * or read and accept the evaluation agreement. Setup then carries on by itself.
 *
 * The agreement is the person's to accept. They read it at its own address and click Accept here;
 * that click is passed to the CLI as the version they accepted (a product decision of 2026-10-22).
 * Nothing accepts it without the click.
 */
export function LocalNeeds({ sequence }: { sequence: LocalSequence }) {
  if (!needsPerson(sequence)) return null;
  const reason = sequence.blocked?.reason;
  if (reason === "authentication-required")
    return <SignInToCopilotKit onSignedIn={sequence.retry} />;
  if (reason === "eula-acceptance-required")
    return (
      <AcceptTerms
        refused={sequence.refused}
        onAccept={sequence.acceptTerms}
        onRetry={sequence.retry}
      />
    );
  return null;
}

function needsPerson(sequence: LocalSequence): boolean {
  const reason = sequence.stopped ? sequence.blocked?.reason : null;
  return (
    reason === "authentication-required" ||
    reason === "eula-acceptance-required"
  );
}

function SignInToCopilotKit({ onSignedIn }: { onSignedIn: () => void }) {
  /** The sign-in being waited on, if one is. */
  const [waiting, setWaiting] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const attempt = useRef<string | null>(null);
  // Leaving stops the wait for the browser.
  useEffect(
    () => () => {
      if (attempt.current) cancelLocalEval(attempt.current).catch(() => {});
    },
    [],
  );

  async function signIn() {
    setFailed(null);
    const started = signInToCopilotKit();
    attempt.current = started.attempt;
    setWaiting(started.attempt);
    try {
      const signedIn = await started.signedIn;
      if (attempt.current !== started.attempt) return;
      if (signedIn) onSignedIn();
      else setFailed("Sign-in did not finish. Try again.");
    } catch (error) {
      if (attempt.current !== started.attempt) return;
      setFailed(
        error instanceof LocalEvalError && error.category !== "unrecognized"
          ? said(error.category)
          : "Sign-in did not finish. Try again.",
      );
    } finally {
      if (attempt.current === started.attempt) {
        attempt.current = null;
        setWaiting(null);
      }
    }
  }

  /** Stop the CLI's sign-in and offer it again. */
  function cancel() {
    const running = attempt.current;
    attempt.current = null;
    if (running) cancelLocalEval(running).catch(() => {});
    setWaiting(null);
  }

  return (
    <div className="local-needs">
      <Lockup byCopilotKit />
      <p>Sign in to finish setting up OpenBot.</p>
      {waiting ? (
        <CopilotKitSignInWait
          attempt={waiting}
          waiting="Finish signing in to OpenBot in your browser…"
          onCancel={cancel}
        />
      ) : (
        <div className="row">
          <button type="button" onClick={signIn}>
            Sign in to OpenBot
          </button>
        </div>
      )}
      {failed && <p className="footnote">{failed}</p>}
    </div>
  );
}

function AcceptTerms({
  refused,
  onAccept,
  onRetry,
}: {
  /** The version setup was already given and did not take. */
  refused: string | null;
  onAccept: (version: string) => void;
  onRetry: () => void;
}) {
  const [terms, setTerms] = useState<LocalTerms | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    const started = localEvalTerms();
    started.terms.then(
      (read) => current && setTerms(read),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
      cancelLocalEval(started.attempt).catch(() => {});
    };
  }, []);

  if (failed || (terms && terms.status !== "required"))
    return (
      <div className="local-needs">
        <p className="footnote">
          The license agreement could not be shown. Try again.
        </p>
        <div className="row">
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  if (terms?.status !== "required")
    return <StatusLine>Getting the license agreement…</StatusLine>;
  if (terms.version === refused)
    return (
      <div className="local-needs">
        <p className="footnote">
          OpenBot couldn't record your acceptance. If a coding agent or a script
          opened OpenBot, quit it, open it yourself, and accept again.
        </p>
        <div className="row">
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  return (
    <div className="local-needs">
      {/* The organization and the agreement's version are the log's, as on the Account step. */}
      <p>
        To run OpenBot on this computer, accept the OpenBot by CopilotKit
        license agreement.
      </p>
      <p className="footnote">
        <ExternalLink href={terms.url}>Read the license agreement</ExternalLink>
      </p>
      <div className="row">
        <button type="button" onClick={() => onAccept(terms.version)}>
          Accept
        </button>
      </div>
    </div>
  );
}
