import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink } from "./ExternalLink";
import {
  cancelLocalEval,
  type LocalTerms,
  localEvalTerms,
  signInToCopilotKit,
} from "./localEvalCli";
import { StatusLine } from "./SetupProgress";

type Seen =
  | { at: "checking" }
  | { at: "signed-out" }
  | { at: "signing-in" }
  | { at: "agreement"; terms: Extract<LocalTerms, { status: "required" }> }
  | { at: "failed"; said: string };

const COULD_NOT_CHECK =
  "OpenBot could not check your CopilotKit account. Try again.";

/**
 * The CopilotKit account step of a local first run: sign in, then read and accept the evaluation
 * agreement, before anything licensed is set up.
 *
 * Its own step, after the software is installed and before the AI provider is chosen, because the
 * local evaluation licence is issued to this account and under this agreement. Somebody already
 * signed in who has accepted the current agreement passes through it without a click.
 *
 * Accepting is the person's own act: they read the agreement at its address and click Accept here,
 * and that click is what setup later passes to the CLI as the version they accepted (a product
 * decision of 2026-10-22). Nothing accepts it without the click.
 */
export function CopilotKitAccount({
  stepLabel,
  onDone,
}: {
  stepLabel: string;
  /** Signed in and agreed: the version accepted here, or null when nothing needed accepting. */
  onDone: (acceptedVersion: string | null) => void;
}) {
  const [seen, setSeen] = useState<Seen>({ at: "checking" });
  const attempt = useRef<string | null>(null);
  const finished = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;

  const finish = useCallback((version: string | null) => {
    if (finished.current) return;
    finished.current = true;
    done.current(version);
  }, []);

  const check = useCallback(() => {
    setSeen({ at: "checking" });
    const started = localEvalTerms();
    attempt.current = started.attempt;
    started.terms.then(
      (terms) => {
        if (attempt.current !== started.attempt) return;
        attempt.current = null;
        if (terms.status === "signed-out") setSeen({ at: "signed-out" });
        else if (terms.status === "required" && !terms.accepted)
          setSeen({ at: "agreement", terms });
        else if (terms.status === "unavailable")
          setSeen({
            at: "failed",
            said: "The evaluation agreement is not available right now. Try again later.",
          });
        // Accepted already, or none needed: nothing to do here.
        else finish(null);
      },
      () => {
        if (attempt.current !== started.attempt) return;
        attempt.current = null;
        setSeen({ at: "failed", said: COULD_NOT_CHECK });
      },
    );
  }, [finish]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival.
  useEffect(() => {
    check();
    return () => {
      // Leaving stops whatever is still waiting, the browser sign-in included.
      if (attempt.current) cancelLocalEval(attempt.current).catch(() => {});
      attempt.current = null;
    };
  }, []);

  async function signIn() {
    setSeen({ at: "signing-in" });
    const started = signInToCopilotKit();
    attempt.current = started.attempt;
    try {
      const signedIn = await started.signedIn;
      if (attempt.current !== started.attempt) return;
      attempt.current = null;
      if (signedIn) check();
      else
        setSeen({ at: "failed", said: "Sign-in did not finish. Try again." });
    } catch {
      if (attempt.current !== started.attempt) return;
      attempt.current = null;
      setSeen({ at: "failed", said: "Sign-in did not finish. Try again." });
    }
  }

  const agreement = seen.at === "agreement" ? seen.terms : null;
  return (
    <div className="sheet">
      <p className="steps-of">{stepLabel}</p>
      <h1>
        {agreement
          ? "Accept the evaluation agreement"
          : "Sign in to CopilotKit"}
      </h1>
      <p className="lede">
        {agreement
          ? `To run Intelligence on this computer, accept the CopilotKit Intelligence evaluation agreement for ${agreement.organizationName}.`
          : "Intelligence runs on this computer under your CopilotKit account. Sign in, then accept the evaluation agreement."}
      </p>

      {seen.at === "checking" && (
        <StatusLine>Checking your CopilotKit account…</StatusLine>
      )}
      {seen.at === "signing-in" && (
        <StatusLine>Finish signing in in your browser…</StatusLine>
      )}
      {agreement && (
        <p className="footnote">
          <ExternalLink href={agreement.url}>Read the agreement</ExternalLink> (
          {agreement.version})
        </p>
      )}
      {seen.at === "failed" && <p className="footnote">{seen.said}</p>}

      <div className="row">
        {seen.at === "signed-out" && (
          <button type="button" onClick={signIn}>
            Sign in to CopilotKit
          </button>
        )}
        {agreement && (
          <button type="button" onClick={() => finish(agreement.version)}>
            Accept
          </button>
        )}
        {seen.at === "failed" && (
          <button type="button" onClick={check}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
