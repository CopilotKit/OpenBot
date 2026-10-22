import { useEffect, useRef, useState } from "react";
import {
  cancelLocalEval,
  chatGate,
  connectLocalEval,
  type LocalConnection,
  LocalEvalError,
  type LocalFailure,
  type LocalReason,
  type LocalReport,
  runLocalEval,
  setUpLocalEval,
} from "./localEvalCli";
import { localReadiness } from "./localReadiness";
import { asProblem, Failure, type Problem } from "./Problem";
import { type Progress, SetupProgress } from "./SetupProgress";

type Call<T> = { attempt: string; answer: Promise<T> };

/** What Start OpenBot is given for a local stack: its addresses. The key is in the vault. */
export type LocalStartable = { apiUrl: string; gatewayWsUrl: string };

/**
 * Between status checks while Intelligence reports that it is starting: about three minutes in
 * all, then the person is told and can check again.
 */
const POLL_DELAYS: number[] = [2_000, 4_000, 8_000, ...Array(12).fill(15_000)];

const unreadable: Problem = {
  said: "OpenBot did not understand the Intelligence CLI's answer.",
};

type Phase = "setup" | "connect" | "wait" | "start";

const PHASES: [Phase, string][] = [
  ["setup", "Setting up Intelligence on this computer"],
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
    return "Settings the Intelligence CLI wrote for OpenBot were changed since. OpenBot did not connect.";
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

/**
 * Intelligence on this computer, run by the Intelligence CLI, then OpenBot started against it.
 *
 * Shown only when this build has a CLI to run, and only once the person has chosen it. Four
 * steps, each idempotent, run in order without a button: set up, connect (the choice is the
 * consent, and the native side keeps the key the CLI wrote), wait until the CLI itself reports
 * readiness "ready" and licence "valid", then start OpenBot. A recorded, connected stack starts at
 * waiting. A step that is blocked or fails stops there with its reason, and Retry resumes at that
 * step. A CLI that does not report ready and valid never reaches Start.
 */
export function LocalIntelligence({
  root,
  stack: recorded,
  connected: recordedConnection = false,
  auto,
  developer = import.meta.env.DEV,
  onCancel,
  onStart,
  onConnected = () => {},
  pollDelays = POLL_DELAYS,
}: {
  root: string;
  stack: string | null;
  /** OpenBot already holds the key `local connect` gave it for this stack. */
  connected?: boolean;
  /** Run the steps as soon as this is shown. Otherwise they wait for Start OpenBot. */
  auto: boolean;
  developer?: boolean;
  /** Cancel also leaves, back to the choice. Without it, Cancel stops at its row with Retry. */
  onCancel?: () => void;
  /** Starts OpenBot against the stack; true when it started. */
  onStart: (startable: LocalStartable) => Promise<boolean>;
  onConnected?: (stack: string) => void;
  pollDelays?: number[];
}) {
  const [stack, setStack] = useState<string | null>(recorded);
  const [connected, setConnected] = useState(recordedConnection);
  const [at, setAt] = useState<Phase | null>(null);
  const [running, setRunning] = useState(false);
  const [blocked, setBlocked] = useState<{
    said: string;
    reason: LocalReason | null;
  } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Bumped to stop a run: by Cancel, by leaving, and by any newer run.
  const generation = useRef(0);
  const attempt = useRef<string | null>(null);
  const wake = useRef<(() => void) | null>(null);
  const startable = useRef<LocalStartable | null>(null);

  function halt() {
    generation.current += 1;
    wake.current?.();
    const inFlight = attempt.current;
    attempt.current = null;
    if (inFlight) void cancelLocalEval(inFlight);
  }

  // Leaving stops whatever is running, the CLI call included.
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
        if (error.category === "unrecognized") setProblem(unreadable);
        else setBlocked({ said: said(error.category), reason: null });
      } else {
        setProblem(asProblem(error));
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
        setBlocked({ said: said(found), reason: found.reason });
      }
      return null;
    };
    let startedIntelligence = false;
    for (let tries = 0; ; tries += 1) {
      const found = await report("status");
      if (!found) return null;
      if (isReady(found)) {
        if (!found.stack) {
          setBlocked({ said: said("missing-stack"), reason: null });
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
        setBlocked({
          said: "Intelligence did not report ready in time.",
          reason: null,
        });
        return null;
      }
      if (!(await pause(pollDelays[tries], token))) return null;
    }
  }

  async function run(from: Phase): Promise<void> {
    halt();
    const token = generation.current;
    setBlocked(null);
    setProblem(null);
    let id = stack;
    const stop = (reason?: { said: string; reason?: LocalReason | null }) => {
      if (generation.current !== token) return;
      if (reason) {
        setBlocked({ said: reason.said, reason: reason.reason ?? null });
      }
      setRunning(false);
    };
    for (const [phase] of PHASES.slice(PHASES.findIndex(([p]) => p === from))) {
      if (generation.current !== token) return;
      setAt(phase);
      setRunning(true);
      if (phase === "setup") {
        const started = setUpLocalEval(root);
        const report = await call(
          { attempt: started.attempt, answer: started.report },
          token,
        );
        if (!report) return stop();
        if (report.outcome !== "completed") {
          return stop({ said: said(report), reason: report.reason });
        }
        if (!report.stack) return stop({ said: said("missing-stack") });
        id = report.stack.id;
        setStack(id);
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
        setStack(id);
        setConnected(true);
        onConnected(id);
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
        if (!(await onStart(target))) {
          return stop({ said: "OpenBot did not start." });
        }
      }
    }
    stop();
  }

  function cancel() {
    halt();
    setRunning(false);
    if (onCancel) return onCancel();
    setBlocked({ said: said("cancelled"), reason: null });
  }

  const from: Phase = stack && connected ? "wait" : "setup";
  // Deferred a tick, so a development double mount runs the CLI once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when auto is turned on.
  useEffect(() => {
    if (!auto || at !== null) return;
    const timer = setTimeout(() => void run(from), 0);
    return () => clearTimeout(timer);
  }, [auto]);

  const reached = at ? PHASES.findIndex(([phase]) => phase === at) : -1;
  const steps: Progress[] = PHASES.slice(0, reached + 1).map(
    ([phase, label], index) =>
      index < reached
        ? { step: label, ok: true, detail: "" }
        : running
          ? { step: label, ok: true, running: true, detail: "" }
          : blocked || problem
            ? { step: label, ok: false, detail: blocked?.said ?? "" }
            : { step: label, ok: phase === "start", detail: "" },
  );
  const stopped = !running && at !== null && (blocked || problem);
  const reason = stopped ? blocked?.reason : null;

  return (
    <section aria-label="Intelligence on this computer">
      <SetupProgress steps={steps} />
      {reason === "eula-acceptance-required" &&
        (developer ? (
          <p className="footnote">
            Development build: run <code>copilotkit local accept-terms</code> in
            Terminal, then choose Retry.
          </p>
        ) : (
          <p className="footnote">
            Accepting the evaluation terms in OpenBot is not available yet.
          </p>
        ))}
      {reason === "authentication-required" && developer && (
        <p className="footnote">
          Development build: run <code>copilotkit login</code> in Terminal, then
          choose Retry.
        </p>
      )}
      {stopped && problem && <Failure problem={problem} />}
      <div className="row">
        {running && at !== "start" && (
          <button type="button" className="quiet" onClick={cancel}>
            Cancel
          </button>
        )}
        {stopped && at && (
          <button type="button" onClick={() => run(at)}>
            Retry
          </button>
        )}
        {!running && at === null && !auto && (
          <button type="button" onClick={() => run(from)}>
            Start OpenBot
          </button>
        )}
      </div>
    </section>
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
  chosen: IntelligenceMode;
  onChoose: (mode: IntelligenceMode) => void;
}) {
  const rows: [IntelligenceMode, string, string][] = [
    [
      "local",
      "Run Intelligence on this computer",
      "For evaluation. Uses Docker Desktop; the first setup takes a few minutes.",
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
