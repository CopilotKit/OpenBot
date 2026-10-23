import { useEffect, useRef, useState } from "react";
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
import {
  formatElapsed,
  type Progress,
  SetupProgress,
  StatusLine,
  useElapsed,
} from "./SetupProgress";

type Call<T> = { attempt: string; answer: Promise<T> };

/** What Start OpenBot is given for a local stack: its addresses. The key is in the vault. */
export type LocalStartable = { apiUrl: string; gatewayWsUrl: string };

/**
 * Between status checks while Intelligence reports that it is starting: about three minutes in
 * all, then the person is told and can check again.
 */
const POLL_DELAYS: number[] = [2_000, 4_000, 8_000, ...Array(12).fill(15_000)];

const unreadable: Problem = {
  said: "OpenBot did not understand Intelligence's answer.",
};

type Phase = "setup" | "connect" | "wait" | "start";

const PHASES: [Phase, string][] = [
  ["setup", "Setting up Intelligence"],
  ["connect", "Connecting OpenBot"],
  ["wait", "Waiting for Intelligence"],
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
    return "Settings Intelligence wrote for OpenBot were changed since. OpenBot did not connect.";
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
};

const idle: State = {
  at: null,
  running: false,
  since: null,
  blocked: null,
  problem: null,
};

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
  /** Starts OpenBot against the stack; true when it started. */
  onStart: (startable: LocalStartable) => Promise<boolean>;
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
    for (let tries = 0; ; tries += 1) {
      const found = await report("status");
      if (!found) return null;
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
            said: "Intelligence did not report ready in time.",
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
    update({ blocked: null, problem: null });
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
        const started = setUpLocalEval(root, accepted.current);
        const report = await call(
          { attempt: started.attempt, answer: started.report },
          token,
        );
        if (!report) return stop();
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
        if (!(await latest.current.onStart(target))) {
          return stop({ said: "OpenBot did not start." });
        }
        go.current = false;
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
  const steps: Progress[] = PHASES.slice(0, reached + 1).map(
    ([, label], index) =>
      index < reached
        ? { step: label, ok: true, detail: "" }
        : state.running
          ? {
              step: label,
              ok: true,
              running: true,
              detail: "",
              startedAt: state.since ?? undefined,
            }
          : stopped
            ? { step: label, ok: false, detail: state.blocked?.said ?? "" }
            : { step: label, ok: true, detail: "" },
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
    <section aria-label="Intelligence on this computer">
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
 * One line for the screen in front: the current row and how long it has taken. A stop the person
 * clears themselves (signing in, accepting the agreement) shows what to do instead of the line.
 */
export function LocalStatus({ sequence }: { sequence: LocalSequence }) {
  const current = sequence.steps.at(-1);
  const elapsed = useElapsed(sequence.running, sequence.since);
  if (!current) return null;
  if (needsPerson(sequence)) return <LocalNeeds sequence={sequence} />;
  return (
    <>
      <p className="local-status" role="status">
        {sequence.running
          ? `${current.step} · ${formatElapsed(elapsed)} elapsed`
          : sequence.ready
            ? "Intelligence is ready."
            : sequence.stopped
              ? (sequence.blocked?.said ?? sequence.problem?.said)
              : `${current.step}: complete.`}
      </p>
    </>
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
      <AcceptTerms onAccept={sequence.acceptTerms} onRetry={sequence.retry} />
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
  const [waiting, setWaiting] = useState(false);
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
    setWaiting(true);
    setFailed(null);
    const started = signInToCopilotKit();
    attempt.current = started.attempt;
    try {
      if (await started.signedIn) onSignedIn();
      else setFailed("Sign-in did not finish. Try again.");
    } catch (error) {
      setFailed(
        error instanceof LocalEvalError && error.category !== "unrecognized"
          ? said(error.category)
          : "Sign-in did not finish. Try again.",
      );
    } finally {
      attempt.current = null;
      setWaiting(false);
    }
  }

  return (
    <div className="local-needs">
      <p>Intelligence on this computer needs your CopilotKit account.</p>
      {waiting ? (
        <StatusLine>Finish signing in in your browser…</StatusLine>
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
  onAccept,
  onRetry,
}: {
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
          The evaluation agreement could not be shown. Try again.
        </p>
        <div className="row">
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  if (terms?.status !== "required")
    return <StatusLine>Getting the evaluation agreement…</StatusLine>;
  return (
    <div className="local-needs">
      <p>
        To run Intelligence on this computer, accept the CopilotKit Intelligence
        evaluation agreement for {terms.organizationName}.
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

export type IntelligenceMode = "local" | "hosted";

/**
 * Where Intelligence runs, asked before anything is set up.
 *
 * Local setup downloads several gigabytes, so it waits for this answer rather than starting on
 * arrival and offering hosted as an interruption. Continue, which belongs to the screen, commits it.
 */
export function IntelligenceChoice({
  chosen,
  onChoose,
}: {
  /** Null until somebody picks one, so neither is assumed. */
  chosen: IntelligenceMode | null;
  onChoose: (mode: IntelligenceMode) => void;
}) {
  const rows: [IntelligenceMode, string, string][] = [
    [
      "local",
      "Run Intelligence on this computer",
      "For evaluation. The first setup takes about 10 minutes.",
    ],
    [
      "hosted",
      "Use CopilotKit's hosted Intelligence",
      "Signs in to your CopilotKit account.",
    ],
  ];
  return (
    <fieldset className="picker">
      <legend className="sr-only">Where Intelligence runs</legend>
      {rows.map(([mode, name, summary]) => (
        <label
          key={mode}
          className={`tile intelligence-choice${chosen === mode ? " chosen" : ""}`}
        >
          <input
            type="radio"
            name="intelligence"
            className="tile-input"
            value={mode}
            checked={chosen === mode}
            onChange={() => onChoose(mode)}
          />
          <span className="tile-name">{name}</span>
          <span className="tile-summary">{summary}</span>
        </label>
      ))}
    </fieldset>
  );
}
