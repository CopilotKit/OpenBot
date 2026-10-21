import { useEffect, useRef, useState } from "react";
import {
  cancelLocalEval,
  LocalEvalError,
  type LocalFailure,
  type LocalReport,
  runLocalEval,
  setUpLocalEval,
} from "./localEvalCli";
import { localReadiness, type ReadinessRow } from "./localReadiness";
import { asProblem, Failure, type Problem } from "./Problem";

type Call = { attempt: string; report: Promise<LocalReport> };

/**
 * Intelligence on this computer, run by the Intelligence CLI.
 *
 * Shown only when this build has a CLI to run. It sets the stack up and says where each part
 * stands. Start stays closed: the CLI does not report readiness yet, and has no credential to give
 * OpenBot for a local stack.
 */
export function LocalIntelligence({
  root,
  stack: recorded,
  developer = import.meta.env.DEV,
  onLeave,
}: {
  root: string;
  stack: string | null;
  developer?: boolean;
  onLeave: () => void;
}) {
  const [stack, setStack] = useState<string | null>(recorded);
  const [answer, setAnswer] = useState<LocalReport | LocalFailure | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function settle(call: Call): Promise<boolean> {
    setAttempt(call.attempt);
    setProblem(null);
    try {
      const report = await call.report;
      if (!mounted.current) return false;
      setAnswer(report);
      if (report.stack) setStack(report.stack.id);
      return report.outcome === "completed";
    } catch (error) {
      if (!mounted.current) return false;
      if (error instanceof LocalEvalError) {
        if (error.category === "unrecognized") {
          setProblem({
            said: "OpenBot did not understand the Intelligence CLI's answer.",
          });
        } else {
          setAnswer(error.category);
        }
      } else {
        setProblem(asProblem(error));
      }
      return false;
    } finally {
      if (mounted.current) setAttempt(null);
    }
  }

  // A recorded stack is asked about, never assumed to be in the state it was last seen in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: checked once per recorded stack.
  useEffect(() => {
    if (recorded) void settle(runLocalEval("status", recorded));
  }, [recorded]);

  const setUp = () => settle(setUpLocalEval(root));
  const check = () => stack && settle(runLocalEval("status", stack));
  const restart = async () => {
    if (!stack) return;
    if (!(await settle(runLocalEval("stop", stack)))) return;
    if (!(await settle(runLocalEval("start", stack)))) return;
    await settle(runLocalEval("status", stack));
  };

  const rows = localReadiness({
    runtime: "unknown",
    intelligence: answer,
    openBot: "unknown",
    provider: "unvalidated",
  });
  const report = typeof answer === "object" ? answer : null;
  const termsPending = report?.reason === "eula-acceptance-required";
  const busy = attempt !== null;

  function act(row: ReadinessRow) {
    if (busy) return null;
    if (row.action === "retry") {
      return (
        <button type="button" className="quiet" onClick={stack ? check : setUp}>
          Retry
        </button>
      );
    }
    if (row.action === "restart-intelligence" && stack) {
      return (
        <button type="button" className="quiet" onClick={restart}>
          Restart Intelligence
        </button>
      );
    }
    return null;
  }

  return (
    <section aria-label="Intelligence on this computer">
      <p className="lede">
        Intelligence runs on this computer in Docker Desktop. The Intelligence
        CLI sets it up and manages it.
      </p>
      <ul className="readiness">
        {(
          [
            ["Docker Desktop", rows.runtime],
            ["Intelligence", rows.intelligence],
            ["OpenBot", rows.openBot],
            ["AI provider", rows.provider],
          ] as const
        ).map(([label, row]) => (
          <li key={label} aria-label={label} data-state={row.state}>
            <strong>{label}</strong> <span>{row.said}</span> {act(row)}
          </li>
        ))}
      </ul>
      {stack && <p className="footnote">Stack {stack}</p>}
      {termsPending &&
        (developer ? (
          <p className="footnote">
            Development build: run <code>copilotkit local accept-terms</code> in
            Terminal, then choose Set up local Intelligence again.
          </p>
        ) : (
          <p className="footnote">
            Accepting the evaluation terms in OpenBot is not available yet.
          </p>
        ))}
      <p className="footnote">
        OpenBot cannot start against local Intelligence yet. The Intelligence
        CLI does not report readiness or give OpenBot a credential.
      </p>
      {problem && <Failure problem={problem} />}
      <div className="row">
        {busy ? (
          <button
            type="button"
            className="quiet"
            onClick={() => attempt && void cancelLocalEval(attempt)}
          >
            Cancel
          </button>
        ) : (
          <>
            {(!stack || report?.outcome !== "completed") && (
              <button type="button" onClick={setUp}>
                Set up local Intelligence
              </button>
            )}
            {stack && (
              <button type="button" className="quiet" onClick={check}>
                Check again
              </button>
            )}
            <button type="button" className="quiet" onClick={onLeave}>
              Use CopilotKit's service instead
            </button>
          </>
        )}
      </div>
    </section>
  );
}
