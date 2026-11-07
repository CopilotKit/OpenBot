import { useEffect, useRef, useState } from "react";
import { CopilotKitSignInWait } from "./CopilotKitSignInWait";
import { ExternalLink } from "./ExternalLink";
import {
  cancelLocalEval,
  chatGate,
  connectLocalEval,
  type LocalConnection,
  LocalEvalError,
  type LocalFailure,
  type LocalReason,
  type LocalReport,
  type LocalTerms,
  localEvalTerms,
  runLocalEval,
  setUpLocalEval,
  signInToCopilotKit,
} from "./localEvalCli";
import { localReadiness } from "./localReadiness";
import { asProblem, Failure, type Problem } from "./Problem";
import { type Progress, SetupProgress, StatusLine } from "./SetupProgress";

type Call<T> = { attempt: string; answer: Promise<T> };

/** What Start OpenBot is given for a local stack: its addresses. The key is in the vault. */
export type LocalStartable = { apiUrl: string; gatewayWsUrl: string };

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

const unreadable: Problem = {
  said: "OpenBot did not understand its back end's answer.",
};

type Phase = "setup" | "connect" | "wait" | "start";

const PHASES: [Phase, string][] = [
  ["setup", "Setting up OpenBot"],
  ["connect", "Connecting OpenBot"],
  ["wait", "Waiting for the back end"],
  ["start", "Starting OpenBot"],
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
    return "Settings the back end wrote for OpenBot were changed since. OpenBot did not connect.";
  }
  return said({
    outcome: answered.outcome,
    stack: answered.stack,
    reason: answered.reason,
    readiness: "unknown",
    licence: "unknown",
    licenceExpiresAt: null,
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
  /**
   * The back end could not be updated to the release this app installs. Said, and not a stop: the
   * release it had is still there and still runs.
   */
  updateFailed: string | null;
};

const idle: State = {
  at: null,
  running: false,
  since: null,
  blocked: null,
  problem: null,
  refused: null,
  detail: null,
  updateFailed: null,
};

/** The row an update that failed is said on, under the back end's. */
const UPDATING = "Updating the back end";

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
    to: string,
    from: string,
    token: number,
  ): Promise<boolean> {
    update({ detail: `Updating the back end to ${to}. Its data stays.` });
    const started = runLocalEval("update", id);
    attempt.current = started.attempt;
    let updated = false;
    try {
      updated = (await started.report).outcome === "completed";
    } catch {
      updated = false;
    } finally {
      if (attempt.current === started.attempt) attempt.current = null;
    }
    if (generation.current !== token) return false;
    update({
      detail: null,
      updateFailed: updated
        ? null
        : `The back end could not be updated to ${to}, so it stays on ${from}. OpenBot tries again the next time it starts.`,
    });
    return true;
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
        update({ blocked: { said: said(found), reason: found.reason } });
      }
      return null;
    };
    let startedIntelligence = false;
    let updatedIntelligence = false;
    for (let tries = 0; ; tries += 1) {
      const found = await report("status");
      if (!found) return null;
      /*
       * A stack an older app set up runs an older release than this app installs: updated once,
       * before OpenBot starts on it, so OpenBot runs on the release it was built with.
       *
       * ONLY ONCE IT IS UP. The CLI's update rolls the running stack forward and waits for each
       * service to come back (`kubectl rollout status`, three minutes). On a stack Quit had stopped
       * there is nothing running to roll, the wait ran out, and the update failed every time; on the
       * same stack started first it finished in 86 seconds. So a stopped stack is started below as
       * usual, and the update runs on the next answer, when it reports ready.
       */
      if (
        found.updateTo &&
        found.stack &&
        !updatedIntelligence &&
        found.readiness === "ready"
      ) {
        updatedIntelligence = true;
        const going = await updateIntelligence(
          id,
          found.updateTo,
          found.stack.installedRelease,
          token,
        );
        if (!going) return null;
        continue;
      }
      if (isReady(found)) {
        if (!found.stack) {
          update({ blocked: { said: said("missing-stack"), reason: null } });
          return null;
        }
        return {
          apiUrl: found.stack.urls.api,
          gatewayWsUrl: found.stack.urls.gateway,
        };
      }
      const row = localReadiness({
        runtime: "unknown",
        intelligence: found,
        openBot: "unknown",
        provider: "unvalidated",
      }).intelligence;
      if (row.action === "start-intelligence" && !startedIntelligence) {
        startedIntelligence = true;
        const started = await report("start");
        if (!started) return null;
        if (started.outcome !== "completed") return stuck(started);
        continue;
      }
      if (found.readiness !== "starting" || row.state === "blocked") {
        return stuck(found);
      }
      if (tries >= pollDelays.length) {
        update({
          blocked: {
            said: "The back end did not report ready in time.",
            reason: null,
          },
        });
        return null;
      }
      if (!(await pause(pollDelays[tries], token))) return null;
    }
  }

  async function run(from: Phase): Promise<void> {
    halt();
    const token = generation.current;
    update({ blocked: null, problem: null, detail: null, updateFailed: null });
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
    for (const [phase] of PHASES.slice(PHASES.findIndex(([p]) => p === from))) {
      if (generation.current !== token) return;
      // Ready, and waiting for the go-ahead.
      if (phase === "start" && !go.current) return stop();
      update({ at: phase, running: true, since: Date.now() });
      if (phase === "setup") {
        const carried = accepted.current;
        const started = setUpLocalEval(root, carried);
        const report = await call(
          { attempt: started.attempt, answer: started.report },
          token,
        );
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
                detail: state.detail ?? "",
                startedAt: state.since ?? undefined,
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
}: {
  sequence: LocalSequence;
  offerStart?: boolean;
}) {
  const { at, running, stopped, problem } = sequence;

  return (
    <section aria-label="Back end on this computer">
      <SetupProgress steps={sequence.steps} />
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
export function LocalStatus({ sequence }: { sequence: LocalSequence }) {
  if (!sequence.stopped) return null;
  const needs = needsPerson(sequence);
  // Stopped at Start: Intelligence got as far as ready and licensed, and OpenBot is what failed.
  const openBot = !needs && sequence.at === "start";
  return (
    <section
      className={`local-alert${needs ? " needs" : ""}`}
      role="alert"
      aria-label={openBot ? "OpenBot" : "Back end"}
    >
      <h2>
        {needs
          ? "Setup needs you"
          : openBot
            ? "OpenBot did not start"
            : "Back end setup stopped"}
      </h2>
      {needs ? (
        <LocalNeeds sequence={sequence} />
      ) : (
        <>
          <p>
            {openBot
              ? "The back end is ready. Retry starts OpenBot again."
              : (sequence.blocked?.said ?? sequence.problem?.said)}
          </p>
          <div className="row">
            <button type="button" onClick={sequence.retry}>
              Retry
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * What the person does when local setup stops for them, in the window where it stopped: sign in to
 * CopilotKit, or read and accept the evaluation agreement. Setup then carries on by itself.
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
      <p>OpenBot's back end needs your CopilotKit account.</p>
      {waiting ? (
        <CopilotKitSignInWait
          attempt={waiting}
          waiting="Finish signing in in your browser…"
          onCancel={cancel}
        />
      ) : (
        <div className="row">
          <button type="button" onClick={signIn}>
            Sign in to CopilotKit
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
          The back end did not take the acceptance from OpenBot. If a coding
          agent or a script opened OpenBot, quit it, open it yourself, and
          accept again.
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
      <p>
        To run OpenBot on this computer, accept the CopilotKit license agreement
        for {terms.organizationName}.
      </p>
      <p className="footnote">
        <ExternalLink href={terms.url}>Read the agreement</ExternalLink> (
        {terms.version})
      </p>
      <div className="row">
        <button type="button" onClick={() => onAccept(terms.version)}>
          Accept
        </button>
      </div>
    </div>
  );
}
