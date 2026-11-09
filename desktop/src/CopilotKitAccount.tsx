import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CopilotKitLogo } from "./CopilotKitLogo";
import { CopilotKitSignInWait } from "./CopilotKitSignInWait";
import { ExternalLink } from "./ExternalLink";
import {
  cancelLocalEval,
  connectCopilotKitApps,
  type LocalTerms,
  localEvalTerms,
  signInToCopilotKit,
} from "./localEvalCli";
import { engineTooSmallSaid } from "./localReadiness";
import { InlineFailure, type Problem } from "./Problem";
import { Sections } from "./Sections";
import { StatusLine } from "./SetupProgress";
import { Command } from "./WindowsBlocker";

type Seen =
  | { at: "checking" }
  /** No engine answers yet, so the CLI can't check the account. Install is bringing one up. */
  | { at: "waiting-for-engine" }
  | { at: "signed-out" }
  | { at: "signing-in"; attempt: string }
  | { at: "agreement"; terms: Extract<LocalTerms, { status: "required" }> }
  | { at: "apps"; version: string | null }
  | { at: "apps-failed"; version: string | null; problem: Problem }
  | { at: "failed"; said: string }
  /** The CLI refused the container engine. Trying again by itself would not change it. */
  | { at: "unsupported-engine"; said: string; switchEngine: boolean };

const COULD_NOT_CHECK = "Couldn’t check your CopilotKit account. Try again.";
const SETTING_UP_ENGINE =
  "OpenBot is setting up the software it runs on. Your CopilotKit sign-in comes next.";
const ENGINE_REFUSED =
  "OpenBot's back end can't run on the container engine this computer uses.";
const BLOCKED = "OpenBot's back end can't run on this computer as it's set up.";

/**
 * How long the account check waits for a container engine, and how often it asks again. A new
 * Windows computer installs Podman and its machine while the person signs in, a few minutes at
 * most; an engine that never comes is Install's failure to show, not this step's.
 */
const ENGINE_WAIT_MS = 2000;
const ENGINE_WAIT_LIMIT_MS = 15 * 60 * 1000;

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
 *
 * Signed in, it connects this installation's apps before moving on: CopilotKit makes or replays
 * the installation's Composio project for this account. That can only add apps. A failure says
 * so, with Connect apps to try again and Continue to go on without them, and every Start tries
 * again by itself.
 */
export function CopilotKitAccount({
  root,
  onDone,
  failure,
  handOff = null,
  engine = null,
}: {
  /** The installation folder the apps are connected for. */
  root: string;
  /**
   * What another app's window wants while Install, behind this step, waits on it: Docker Desktop
   * starting, or a password prompt. See `handOffNow`.
   */
  handOff?: string | null;
  /**
   * What Install, behind this step, is doing to bring the engine up, as its own row says it
   * ("Preparing the engine machine."), the hand-off included. See `engineNow`. Said while the
   * account check waits for an engine.
   */
  engine?: string | null;
  /** Signed in and agreed: the version accepted here, or null when nothing needed accepting. */
  onDone: (acceptedVersion: string | null) => void;
  /** A failure from setup itself, shown inside this card rather than under it. */
  failure?: ReactNode;
}) {
  const [seen, setSeen] = useState<Seen>({ at: "checking" });
  const attempt = useRef<string | null>(null);
  const finished = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  const installation = useRef(root);
  installation.current = root;

  const finish = useCallback((version: string | null) => {
    if (finished.current) return;
    finished.current = true;
    done.current(version);
  }, []);

  /** Signed in and agreed: connect this installation's apps, then move on. */
  const connectApps = useCallback(
    (version: string | null) => {
      setSeen({ at: "apps", version });
      const started = connectCopilotKitApps(installation.current);
      attempt.current = started.attempt;
      started.connected.then(
        () => {
          if (attempt.current !== started.attempt) return;
          attempt.current = null;
          finish(version);
        },
        (problem: Problem) => {
          if (attempt.current !== started.attempt) return;
          attempt.current = null;
          setSeen({ at: "apps-failed", version, problem });
        },
      );
    },
    [finish],
  );

  /** When the account check first found no engine answering, while it waits for one. */
  const waitingSince = useRef<number | null>(null);
  const askAgain = useRef<ReturnType<typeof setTimeout> | null>(null);
  const check = useCallback(() => {
    // While it waits for the engine, each check asked again keeps saying what it waits on.
    if (waitingSince.current === null) setSeen({ at: "checking" });
    const started = localEvalTerms();
    attempt.current = started.attempt;
    started.terms.then(
      (terms) => {
        if (attempt.current !== started.attempt) return;
        attempt.current = null;
        if (terms.status === "engine-not-ready") {
          // Install is still bringing the engine up: keep checking rather than fail, and say so.
          // On a new Mac that is minutes of Podman installing, under "Checking your account".
          const since = waitingSince.current ?? Date.now();
          waitingSince.current = since;
          if (Date.now() - since < ENGINE_WAIT_LIMIT_MS) {
            setSeen({ at: "waiting-for-engine" });
            askAgain.current = setTimeout(
              () => checkAgain.current(),
              ENGINE_WAIT_MS,
            );
            return;
          }
        }
        waitingSince.current = null;
        if (terms.status === "engine-too-small")
          setSeen({ at: "failed", said: engineTooSmallSaid(terms) });
        // Refused, not missing: said at once, in the CLI's own sentence when it gave one.
        else if (
          terms.status === "blocked" &&
          terms.reason === "unsupported-engine"
        )
          setSeen({
            at: "unsupported-engine",
            said: terms.said ?? ENGINE_REFUSED,
            switchEngine: terms.switchEngine === true,
          });
        else if (terms.status === "blocked")
          setSeen({ at: "failed", said: terms.said ?? BLOCKED });
        else if (terms.status === "signed-out") setSeen({ at: "signed-out" });
        else if (terms.status === "required" && !terms.accepted)
          setSeen({ at: "agreement", terms });
        else if (terms.status === "unavailable")
          setSeen({
            at: "failed",
            said: "The license agreement isn’t available right now. Try again later.",
          });
        // Accepted already, or none needed: nothing to accept here.
        else if (terms.status === "required" || terms.status === "not-required")
          connectApps(null);
        // A status this window does not know is never taken as nothing to do.
        else setSeen({ at: "failed", said: COULD_NOT_CHECK });
      },
      () => {
        if (attempt.current !== started.attempt) return;
        attempt.current = null;
        waitingSince.current = null;
        setSeen({ at: "failed", said: COULD_NOT_CHECK });
      },
    );
  }, [connectApps]);
  const checkAgain = useRef(check);
  checkAgain.current = check;

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival.
  useEffect(() => {
    check();
    return () => {
      // Leaving stops whatever is still waiting, the browser sign-in included.
      if (askAgain.current) clearTimeout(askAgain.current);
      if (attempt.current) cancelLocalEval(attempt.current).catch(() => {});
      attempt.current = null;
    };
  }, []);

  async function signIn() {
    const started = signInToCopilotKit();
    attempt.current = started.attempt;
    setSeen({ at: "signing-in", attempt: started.attempt });
    try {
      const signedIn = await started.signedIn;
      if (attempt.current !== started.attempt) return;
      attempt.current = null;
      if (signedIn) check();
      else setSeen({ at: "failed", said: "Sign-in didn’t finish. Try again." });
    } catch {
      if (attempt.current !== started.attempt) return;
      attempt.current = null;
      setSeen({ at: "failed", said: "Sign-in didn’t finish. Try again." });
    }
  }

  /** Stop the CLI's sign-in and go back to the start of this step. */
  function cancelSignIn() {
    const running = attempt.current;
    attempt.current = null;
    if (running) cancelLocalEval(running).catch(() => {});
    setSeen({ at: "signed-out" });
  }

  const agreement = seen.at === "agreement" ? seen.terms : null;
  // Signed in and agreed already: what is left to say is about the apps. Said while they connect
  // too, a few seconds after Accept, which flashed "Sign in to CopilotKit" and its sign-in lede.
  const connecting = seen.at === "apps";
  const appsFailed = seen.at === "apps-failed";
  const refused = seen.at === "unsupported-engine" ? seen : null;
  const waitingForEngine = seen.at === "waiting-for-engine";
  return (
    <div className="sheet">
      {/* OpenBot is what is being set up, so its mark heads this step as it heads every other.
          The account is CopilotKit's, so its logotype leads the step itself. */}
      <Sections at="Account" />
      <CopilotKitLogo />
      <h1>
        {agreement
          ? "Accept the license agreement"
          : connecting
            ? "Setting up your apps"
            : appsFailed
              ? "Connect your apps"
              : refused
                ? refused.switchEngine
                  ? "Switch to Docker Desktop or Podman"
                  : "Change your container engine setup"
                : "Sign in to CopilotKit"}
      </h1>
      <p className="lede">
        {agreement
          ? `To run OpenBot on this computer, accept the CopilotKit license agreement for ${agreement.organizationName}.`
          : connecting || appsFailed
            ? "OpenBot uses your CopilotKit account to set up apps like Gmail and Slack."
            : refused
              ? refused.said
              : waitingForEngine
                ? SETTING_UP_ENGINE
                : "OpenBot runs on this computer with your CopilotKit account. Sign in, then accept the license agreement."}
      </p>
      {refused?.switchEngine && (
        <ol className="blocker-steps">
          <li>
            Open Docker Desktop. To use Podman instead, quit the engine you use
            now and start Podman.
          </li>
          <li>
            If Docker still uses another engine, run this in a terminal to
            switch it to Docker Desktop:
            <Command lines={["docker context use desktop-linux"]} />
          </li>
          <li>Choose Try again.</li>
        </ol>
      )}
      {refused && !refused.switchEngine && (
        <p className="footnote">Make the change, then choose Try again.</p>
      )}
      {!agreement && !connecting && !appsFailed && !refused && (
        <p className="footnote">
          Your conversations and files are stored on this computer. Signing in
          does not send them to CopilotKit.
        </p>
      )}

      {/* The account check waits on the engine too. While it does, this says what Install is doing
          to bring it up, as Install's own row says it. While Docker Desktop starts or a password
          prompt is up, it says what the person may have to do in that window, whatever the step
          is at. */}
      {waitingForEngine ? (
        <StatusLine>
          {engine ?? handOff ?? "Preparing this computer…"}
        </StatusLine>
      ) : (
        handOff && <StatusLine>{handOff}</StatusLine>
      )}
      {seen.at === "checking" && !handOff && (
        <StatusLine>Checking your CopilotKit account…</StatusLine>
      )}
      {seen.at === "signing-in" && (
        <CopilotKitSignInWait
          attempt={seen.attempt}
          waiting="Finish signing in to CopilotKit in your browser…"
          onCancel={cancelSignIn}
        />
      )}
      {seen.at === "apps" && <StatusLine>Connecting your apps…</StatusLine>}
      {seen.at === "apps-failed" && (
        <>
          <InlineFailure problem={seen.problem} />
          <p className="footnote">
            You can continue without them. OpenBot tries again each time it
            starts.
          </p>
        </>
      )}
      {agreement && (
        <p className="footnote">
          <ExternalLink href={agreement.url}>Read the agreement</ExternalLink> (
          {agreement.version})
        </p>
      )}
      {seen.at === "failed" && (
        <p className="footnote inline-error">{seen.said}</p>
      )}
      {failure}

      <div className="row">
        {seen.at === "signed-out" && (
          <button type="button" onClick={signIn}>
            Sign in to CopilotKit
          </button>
        )}
        {agreement && (
          <button type="button" onClick={() => connectApps(agreement.version)}>
            Accept
          </button>
        )}
        {seen.at === "apps-failed" && (
          <>
            <button type="button" onClick={() => connectApps(seen.version)}>
              Connect apps
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => finish(seen.version)}
            >
              Continue
            </button>
          </>
        )}
        {(seen.at === "failed" || refused) && (
          <button type="button" onClick={check}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
