import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { PausePodman, PodmanGoAhead } from "./PodmanGoAhead";
import { InlineFailure, type Problem } from "./Problem";
import { Sections } from "./Sections";
import {
  BehindSlot,
  type Progress,
  SetupProgress,
  StatusLine,
  StepFooter,
} from "./SetupProgress";
import { Command } from "./WindowsBlocker";

type Seen =
  | { at: "checking" }
  /**
   * Signed in, and no engine answers yet, so the CLI can't read the agreement. Install is bringing
   * one up.
   */
  | { at: "waiting-for-engine" }
  | { at: "signed-out" }
  | { at: "signing-in"; attempt: string }
  | { at: "agreement"; terms: Extract<LocalTerms, { status: "required" }> }
  | { at: "apps"; version: string | null }
  | { at: "apps-failed"; version: string | null; problem: Problem }
  /** `retry` is what Try again starts again: the sign-in, or the check after it. */
  | { at: "failed"; said: string; retry: "sign-in" | "check" }
  /** The CLI refused the container engine. Trying again by itself would not change it. */
  | { at: "unsupported-engine"; said: string; switchEngine: boolean };

const COULD_NOT_CHECK = "Couldn’t check your OpenBot account. Try again.";

/**
 * The signed-out step's footnote, in Atai's words (2026-11-10). One string so a change of wording
 * is one line. "Traffic data" is being checked with Atai: setup and usage telemetry go to
 * CopilotKit by default (desktop_telemetry.rs, server/src/telemetry/product.ts). A privacy line
 * names the company as OpenBot by CopilotKit, never CopilotKit alone.
 */
const WHAT_SIGNING_IN_SENDS =
  "Your conversations and files stay on this computer. Signing in gets your free local license key and does NOT send traffic data to OpenBot by CopilotKit.";
/** The signed-out step's lede, in Atai's words, less the name of what the license key is for. */
const SELF_CONTAINED =
  "This version of OpenBot runs self-contained on this computer. It requires a free license key.";
const SIGN_IN_DID_NOT_FINISH = "Sign-in didn’t finish. Try again.";
const SETTING_UP_ENGINE =
  "You're signed in. OpenBot is setting up the software it runs on. The license agreement comes next.";
/*
 * OpenBot's own sentences, not the CLI's: its words name rootful Podman and engines, which go to
 * the log (`terms_said`). The steps under them name the apps the person switches in.
 */
const ENGINE_REFUSED =
  "OpenBot can't run with the app this computer uses to run its software. It works with Docker Desktop or Podman.";
const BLOCKED = "OpenBot can't run on this computer as it's set up.";

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
 * The sign-in comes first, the moment the step opens, and waits for nothing. The CLI's `login`
 * needs no container engine: it answers at once for a sign-in it already has, and otherwise opens
 * the browser. Only the agreement waits for the engine (`onboard local-terms` checks it first). On a
 * new Mac that is minutes of Podman installing behind this step, and the sign-in waited behind it
 * too: people who left in that time had never signed in, so nobody knew who they were.
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
  goAhead = null,
  pauseOffer = null,
  behind,
  engineSettled = true,
  engineUpdating = false,
  retried = 0,
}: {
  /** The installation folder the apps are connected for. */
  root: string;
  /**
   * Install has the software OpenBot runs on answering and new enough, or is done. Until then a
   * refusal of the engine is not this step's to say: Install may be updating it. Docker Desktop
   * 4.31 calls itself "Docker Desktop (containerized)", which the CLI refuses, and a Windows tester
   * was told to switch to Docker Desktop while OpenBot was updating it. The step waits instead, and
   * says what Install is doing.
   */
  engineSettled?: boolean;
  /**
   * Install is updating the engine now. The check is not asked at all meanwhile: the engine being
   * updated refuses it. It is asked once Install has settled the engine.
   */
  engineUpdating?: boolean;
  /**
   * Setup's own Try again, in its failure card, was chosen: whatever this step stopped at is asked
   * again with it. With that card up the step offers no Try again of its own, so there is one.
   */
  retried?: number;
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
  /**
   * Install, behind this step, waits for the person's go-ahead before macOS asks for their
   * password to install Podman: its line, from `goAheadNow`. Once signed in, the step explains and
   * offers Continue.
   */
  goAhead?: string | null;
  /**
   * On a Mac whose own Podman OpenBot can't use, Install behind this step waits for the person's
   * yes before it pauses theirs: its line, from `pauseOfferNow`, said with the button that says yes.
   */
  pauseOffer?: string | null;
  /**
   * What is installing behind this step, as one row: what it is doing, how far along, and for how
   * long (`installingBehind`). Shown under every part of the step, so the person always knows
   * OpenBot is still installing. It carries the engine's line and any hand-off, so those are not
   * said twice. Its slot is held even while it is null; without it, there is none.
   */
  behind?: Progress | null;
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
  const settled = useRef(engineSettled);
  settled.current = engineSettled;
  const updating = useRef(engineUpdating);
  updating.current = engineUpdating;
  /** The check waited for Install to settle the engine, and is asked once it has. */
  const checkWhenSettled = useRef(false);

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
    /*
     * Not asked at all until Install has the engine answering and new enough. The check reaches the
     * engine, and one being updated is refused: on a Windows tester's old Docker Desktop it answered
     * "blocked (UnsupportedEngine) ... (containerized)" fourteen times in forty seconds while
     * OpenBot updated it. The step waits, saying what Install is doing, and asks once it has.
     */
    if (updating.current) {
      checkWhenSettled.current = true;
      setSeen({ at: "waiting-for-engine" });
      return;
    }
    // While it waits for the engine, each check asked again keeps saying what it waits on.
    if (waitingSince.current === null) setSeen({ at: "checking" });
    const started = localEvalTerms();
    attempt.current = started.attempt;
    started.terms.then(
      (terms) => {
        if (attempt.current !== started.attempt) return;
        attempt.current = null;
        // Refused while Install may still update the engine: not the person's to act on yet.
        const refusedBeforeUpdate =
          !settled.current &&
          terms.status === "blocked" &&
          terms.reason === "unsupported-engine";
        // Refused before Install has settled the engine: asked once more when it has, not every two
        // seconds meanwhile.
        if (refusedBeforeUpdate) {
          checkWhenSettled.current = true;
          setSeen({ at: "waiting-for-engine" });
          return;
        }
        if (terms.status === "engine-not-ready") {
          // Install is still bringing the engine up: keep checking rather than fail, and say so.
          // On a new Mac that is minutes of Podman installing, under "Checking your account".
          // While Install has not settled the engine, the wait has no limit: an update can take
          // longer, and an install that stops says so in its own card.
          if (!settled.current) waitingSince.current = null;
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
          setSeen({
            at: "failed",
            said: engineTooSmallSaid(terms),
            retry: "check",
          });
        // Refused, not missing: said at once, in the CLI's own sentence when it gave one.
        else if (
          terms.status === "blocked" &&
          terms.reason === "unsupported-engine"
        )
          setSeen({
            at: "unsupported-engine",
            said: ENGINE_REFUSED,
            switchEngine: terms.switchEngine === true,
          });
        else if (terms.status === "blocked")
          setSeen({
            at: "failed",
            said: BLOCKED,
            retry: "check",
          });
        else if (terms.status === "signed-out") setSeen({ at: "signed-out" });
        else if (terms.status === "required" && !terms.accepted)
          setSeen({ at: "agreement", terms });
        else if (terms.status === "unavailable")
          setSeen({
            at: "failed",
            said: "The license agreement isn’t available right now. Try again later.",
            retry: "check",
          });
        // Accepted already, or none needed: nothing to accept here.
        else if (terms.status === "required" || terms.status === "not-required")
          connectApps(null);
        // A status this window does not know is never taken as nothing to do.
        else setSeen({ at: "failed", said: COULD_NOT_CHECK, retry: "check" });
      },
      () => {
        if (attempt.current !== started.attempt) return;
        attempt.current = null;
        waitingSince.current = null;
        setSeen({ at: "failed", said: COULD_NOT_CHECK, retry: "check" });
      },
    );
  }, [connectApps]);
  const checkAgain = useRef(check);
  checkAgain.current = check;

  // Install settled the engine: the check that waited for it is asked now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the engine settles, not each render.
  useEffect(() => {
    if (!engineSettled || !checkWhenSettled.current) return;
    checkWhenSettled.current = false;
    check();
  }, [engineSettled]);

  /**
   * The CLI's `login`: done at once when it already has a sign-in, otherwise it opens the browser
   * and waits for the person to approve. Then the agreement.
   */
  const signIn = useCallback(async () => {
    const started = signInToCopilotKit();
    attempt.current = started.attempt;
    setSeen({ at: "signing-in", attempt: started.attempt });
    const failed = () =>
      setSeen({ at: "failed", said: SIGN_IN_DID_NOT_FINISH, retry: "sign-in" });
    try {
      const signed = await started.signedIn;
      if (attempt.current !== started.attempt) return;
      attempt.current = null;
      if (!signed) return failed();
      checkAgain.current();
    } catch {
      if (attempt.current !== started.attempt) return;
      attempt.current = null;
      failed();
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival.
  useEffect(() => {
    void signIn();
    return () => {
      // Leaving stops whatever is still waiting, the browser sign-in included.
      if (askAgain.current) clearTimeout(askAgain.current);
      if (attempt.current) cancelLocalEval(attempt.current).catch(() => {});
      attempt.current = null;
    };
  }, []);

  // Setup's Try again: whatever this step stopped at is asked again with the install.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each Try again, not each render.
  useEffect(() => {
    if (retried === 0) return;
    if (seen.at === "failed") {
      if (seen.retry === "sign-in") void signIn();
      else check();
    } else if (seen.at === "unsupported-engine") check();
  }, [retried]);

  /** Stop the CLI's sign-in and go back to the start of this step. */
  function cancelSignIn() {
    const running = attempt.current;
    attempt.current = null;
    if (running) cancelLocalEval(running).catch(() => {});
    setSeen({ at: "signed-out" });
  }

  const agreement = seen.at === "agreement" ? seen.terms : null;
  // Signed in and agreed already: what is left to say is about the apps. Said while they connect
  // too, a few seconds after Accept, which flashed the sign-in heading and its sign-in lede.
  const connecting = seen.at === "apps";
  const appsFailed = seen.at === "apps-failed";
  const refused = seen.at === "unsupported-engine" ? seen : null;
  const waitingForEngine = seen.at === "waiting-for-engine";
  // The person closed macOS's password prompt: said in a card of its own, with Try again, on
  // whatever this step shows. Install asks again by itself meanwhile.
  const asking = goAhead !== null;
  return (
    <div className="sheet">
      {/* OpenBot is what is being set up, so its mark heads this step as it heads every other,
          and here it says "by CopilotKit" beside the name. CopilotKit's logotype here made the step
          read as signing up for a CopilotKit product. */}
      <Sections at="Account" byCopilotKit />
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
                  : "Change this computer's setup"
                : waitingForEngine
                  ? "Setting up this computer"
                  : "Self-contained OpenBot"}
      </h1>
      <p className="lede">
        {agreement
          ? // The organization and the agreement's version are the log's: on Windows F the
            // lede ended "for CopilotKit🪁." and the link read "(developer-edition-2026-10-01-web)".
            "To run OpenBot on this computer, accept the OpenBot by CopilotKit license agreement."
          : connecting || appsFailed
            ? "OpenBot uses your account to set up apps like Gmail and Slack."
            : refused
              ? refused.said
              : waitingForEngine
                ? SETTING_UP_ENGINE
                : SELF_CONTAINED}
      </p>
      {refused?.switchEngine && (
        <ol className="blocker-steps">
          <li>
            Open Docker Desktop. To use Podman instead, quit the app you use now
            and start Podman.
          </li>
          <li>
            If Docker still uses the other app, run this in a terminal to switch
            it to Docker Desktop:
            <Command lines={["docker context use desktop-linux"]} />
          </li>
          <li>Choose Try again.</li>
        </ol>
      )}
      {refused && !refused.switchEngine && (
        <p className="footnote">Make the change, then choose Try again.</p>
      )}
      {/* Said where signing in is what the step is about, not once it is done. */}
      {!agreement &&
        !connecting &&
        !appsFailed &&
        !refused &&
        !waitingForEngine && (
          // What signing in sends, in Atai's words. Never "only gets the license key": once
          // signed in, this step also sets up apps. Nothing broader, such as "no data leaves this
          // computer": setup and usage telemetry, the AI provider and connected apps all reach the
          // network.
          <p className="footnote">{WHAT_SIGNING_IN_SENDS}</p>
        )}

      {/* The agreement waits on the engine. While it does, this says what Install is doing to bring
          it up, as Install's own row says it. While Docker Desktop starts or a password prompt is
          coming or up, it says what the person may have to do in that window, whatever the step
          is at. Nobody is asked to click before a prompt: a closed one has its card, with Try
          again. */}
      {asking && <PodmanGoAhead asking={goAhead} />}
      {pauseOffer && <PausePodman key={pauseOffer} offer={pauseOffer} />}
      {/* Not while setup's failure is shown: the install that brings the engine up has stopped,
          and a spinner saying it is coming waited forever under it. Its Try again starts it. */}
      {waitingForEngine
        ? !behind &&
          !failure && (
            <StatusLine>
              {engine ?? handOff ?? "Preparing this computer…"}
            </StatusLine>
          )
        : handOff && !behind && <StatusLine>{handOff}</StatusLine>}
      {seen.at === "checking" && !handOff && !asking && (
        <StatusLine>Checking your OpenBot account…</StatusLine>
      )}
      {seen.at === "signing-in" && (
        <CopilotKitSignInWait
          attempt={seen.attempt}
          before="Checking your OpenBot account…"
          waiting="Finish signing in to OpenBot in your browser…"
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
          <ExternalLink href={agreement.url}>
            Read the license agreement
          </ExternalLink>
        </p>
      )}
      {seen.at === "failed" && (
        <p className="footnote inline-error">{seen.said}</p>
      )}
      {failure}

      {/* The step's actions and the background install, pinned in view (`StepFooter`). */}
      <StepFooter>
        <div className="row">
          {seen.at === "signed-out" && (
            <button type="button" onClick={signIn}>
              Sign in for a free local license key
            </button>
          )}
          {agreement && (
            <button
              type="button"
              onClick={() => connectApps(agreement.version)}
            >
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
          {/* One Try again: setup's failure card has its own, which asks this again too. */}
          {seen.at === "failed" && !failure && (
            <button
              type="button"
              onClick={() => (seen.retry === "sign-in" ? signIn() : check())}
            >
              Try again
            </button>
          )}
          {refused && !failure && (
            <button type="button" onClick={check}>
              Try again
            </button>
          )}
        </div>
        {/* Last, under whatever the step asks: OpenBot is still installing meanwhile. */}
        {behind !== undefined && (
          <BehindSlot>
            {behind && (
              <SetupProgress steps={[behind]} label="Background install" />
            )}
          </BehindSlot>
        )}
      </StepFooter>
    </div>
  );
}
