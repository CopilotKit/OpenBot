import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckForUpdates } from "./CheckForUpdates";
import { CopilotKitAccount } from "./CopilotKitAccount";
import {
  EarlyDownloadsLine,
  earlyDownload,
  useEarlyDownloads,
} from "./EarlyDownloads";
import { DEFAULT_HARNESS, type HarnessChoice } from "./harness";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import {
  LocalIntelligence,
  type LocalStartable,
  LocalStatus,
  type StartOutcome,
  useLocalSequence,
} from "./LocalIntelligence";
import {
  intelligenceStopProblem,
  offerLocalIntelligence,
  splitStopFailure,
} from "./localEvalCli";
import { asProblem, Failure, InlineFailure, type Problem } from "./Problem";
import {
  type HeldConfiguration,
  type ModelChoice,
  ProviderPicker,
  recordedModel,
} from "./ProviderPicker";
import { Sections } from "./Sections";
import { StartFresh } from "./StartFresh";
import { PausePodman, PodmanGoAhead } from "./PodmanGoAhead";
import {
  engineNow,
  goAheadNow,
  handOffNow,
  pauseOfferNow,
  BehindSlot,
  INSTALL_BLURB,
  installingBehind,
  type Progress,
  plainInstallSteps,
  SetupProgress,
  StatusLine,
  trayPlace,
} from "./SetupProgress";
import { ShuttingDown, useQuitStatus } from "./ShuttingDown";
import {
  harnessChoiceEvent,
  modelChoiceEvent,
  recordSetupEvent,
  type SetupStep,
} from "./telemetry";
import { Welcome } from "./Welcome";
import { type Blocker, WindowsBlocker, WindowsRestart } from "./WindowsBlocker";

type AlreadyConfigured = {
  values: Record<string, string>;
  saved: NonNullable<HeldConfiguration["saved"]>;
  /** Reported only for an installation with a local Intelligence stack recorded. */
  launch?: { harness: HarnessChoice | null } | null;
  installation?: { harness: HarnessChoice | null } | null;
  autoStart?: boolean;
  /** The local evaluation's checkpoint, when this installation has one. */
  localEval?: {
    stack: string;
    ownership: "created" | "shared";
    phase: string;
    /** OpenBot holds the key `local connect` gave it for this stack. */
    connected?: boolean;
  };
};

/** This installation is not on this app's own release, so Start upgrades it first. */
type ReleaseMove = { from: string; to: string };
type ReleaseOutcome = ReleaseMove & {
  moved: boolean;
  /** The upgrade did not happen and the previous version started again. */
  notice?: Problem | null;
};

function installationKeyFor(root: string, harness: HarnessChoice | null) {
  return JSON.stringify([
    root.trim(),
    harness?.id ?? DEFAULT_HARNESS,
    harness?.agentUrl?.trim() ?? "",
  ]);
}

/**
 * This window in front of whatever is there, for a step that is the person's next. The native side
 * activates the app, not only the window: see `bring_to_front` in main.rs. A window that could not
 * come forward is still where it was, so a failure here changes nothing.
 */
function comeForward(why: string) {
  invoke("bring_setup_to_front", { why }).catch(() => {});
}

/*
 * The window keeps the size and the place it opened with. It used to grow to fit a taller step and
 * move up to stay on screen: on Windows it grew 14 px when the sign-in card appeared, then jumped
 * 54 px up and 139 px taller on "Connect your AI". A step taller than the window scrolls inside its
 * card instead (`main > .sheet` in styles.css).
 */
export function App() {
  return <Setup />;
}

function Setup() {
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  // A Windows fix made earlier that only counts once Windows has restarted, and it has not.
  const [restartPending, setRestartPending] = useState(false);
  const [blockerFailure, setBlockerFailure] = useState<Problem | null>(null);
  const [instruction, setInstruction] = useState("");
  const [root, setRoot] = useState("");
  const [localStack, setLocalStack] = useState<string | null>(null);
  const [localConnected, setLocalConnected] = useState(false);
  // A relaunch found a connected stack it may start.
  const [localAutoStart, setLocalAutoStart] = useState(false);
  /*
   * Which Bot and which model, as two separate answers.
   *
   * Held here rather than inside the screens so going Back does not lose what was already chosen:
   * the flow is resumable at the screen it stopped on, and a wizard that asks twice is one nobody
   * finishes. `null` means not answered yet, which is what decides the screen below.
   */
  const [harness, setHarness] = useState<HarnessChoice | null>({
    id: DEFAULT_HARNESS,
  });
  const [model, setModel] = useState<ModelChoice | null>(null);
  /*
   * The model as of the latest choice, without waiting for a render.
   *
   * Local Intelligence starts OpenBot from its own sequence, a tick after the go-ahead. A choice
   * made by a click has rendered by then; one made from an effect (a sign-in that finished and moved
   * on by itself) may not have, and Start ran with the model from before it: null.
   */
  const chosenModel = useRef(model);
  // Follows every other change to the model, once committed; a choice sets it at once (below).
  useEffect(() => {
    chosenModel.current = model;
  }, [model]);
  /** Model credentials a previous run already wrote, so the provider screen arrives filled in. */
  const [alreadyHeld, setAlreadyHeld] = useState<HeldConfiguration>({});
  // Running-screen actions that wait on the native side, said while they do.
  const [stopping, setStopping] = useState(false);
  const [showing, setShowing] = useState(false);
  // Start could not move the deployment to this app's release, and started the one it had.
  const [releaseNotice, setReleaseNotice] = useState<Problem | null>(null);
  // The back end is ready on the release it had, and its update did not finish.
  const [backEndNotice, setBackEndNotice] = useState<string | null>(null);
  const [step, setStep] = useState<SetupStep>("welcome");
  const [steps, setSteps] = useState<Progress[]>([]);
  // When the install now running began: its row on the other screens counts from here.
  const [installSince, setInstallSince] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingResume, setCheckingResume] = useState(true);
  const savedLaunch = useRef<string | null>(null);
  // An interrupted run needs an explicit Start.
  const interruptedAtLaunch = useRef(false);
  const [refreshIntelligence, setRefreshIntelligence] = useState(false);
  const [preparation, setPreparation] = useState<{
    key: string;
    status: "preparing" | "complete" | "failed";
  } | null>(null);
  const installationKey = installationKeyFor(root, harness);
  const installationReady =
    preparation?.key === installationKey && preparation.status === "complete";
  /*
   * A first run sets Intelligence up alongside the OpenBot install, not after it: from the moment
   * the install reports the container engine ready (Intelligence runs on the same Docker, and the
   * install is what starts or installs it), or at once when the install is already done. Queued by
   * the CopilotKit account step, which runs first.
   */
  const intelligenceQueued = useRef(false);
  /** Setup's Try again on the account step, which asks that step's own check again too. */
  const [setupRetries, setSetupRetries] = useState(0);
  const engineReady = steps.some(
    (row) => row.step === "engine" && row.ok && !row.running,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the engine or install changes.
  useEffect(() => {
    if (!intelligenceQueued.current) return;
    if (!engineReady && !installationReady) return;
    intelligenceQueued.current = false;
    local.prepare();
  }, [engineReady, installationReady]);
  const returningToInstallation = savedLaunch.current === installationKey;
  const [running, setRunning] = useState(false);
  const visibleSetupStep =
    checkingResume || blockerFailure || blocker || running ? null : step;
  /*
   * The first screen starts the big downloads, without a click: the person opened OpenBot's setup
   * to install it. The native side downloads only what this computer's install will need, once per
   * run of the app (`early_downloads.rs`).
   */
  const onFirstScreen = visibleSetupStep === "welcome";
  useEffect(() => {
    if (!onFirstScreen || !root.trim()) return;
    invoke("start_early_downloads", { root: root.trim() }).catch(() => {});
  }, [onFirstScreen, root]);
  const lastViewedStep = useRef<SetupStep | null>(null);
  useEffect(() => {
    if (visibleSetupStep === lastViewedStep.current) return;
    lastViewedStep.current = visibleSetupStep;
    if (visibleSetupStep !== null) {
      recordSetupEvent({ kind: "step_viewed", step: visibleSetupStep });
    }
  }, [visibleSetupStep]);
  /*
   * A failure, in both registers.
   *
   * `said` is what a person reads and `detail` is the real output, kept behind a disclosure. One
   * string could not serve both: the plain sentence alone throws away the evidence, and the raw
   * engine output alone is how "pull access denied ... may require 'docker login'" ended up as the
   * headline on a setup screen. See `problem.rs`.
   */
  const [failure, setFailure] = useState<Problem | null>(null);
  // A supervisor notice belongs to the interrupted run, not to the form being hydrated.
  const [recoveryFailure, setRecoveryFailure] = useState<Problem | null>(null);
  const recoverFromStart = useCallback((error: unknown) => {
    const problem = asProblem(error);
    setSteps((current) => settleProgress(current, problem));
    setRecoveryFailure(problem);
    if (problem.connection === "model") setStep("model");
    if (problem.connection === "intelligence") {
      setRefreshIntelligence(true);
      setStep("connect");
    }
    // Start was refused until Install runs again: an earlier app's deployment this app cannot
    // start. Install does that by itself, as the person would otherwise be told to.
    if (problem.connection === "installation") setReinstall(true);
  }, []);
  const [reinstall, setReinstall] = useState(false);
  // A local Intelligence stack OpenBot could not stop. Shown, but it never holds a start.
  const [intelligenceNotice, setIntelligenceNotice] = useState<Problem | null>(
    null,
  );
  const displayedFailure = failure ?? recoveryFailure ?? intelligenceNotice;
  // An older shell offered only the database. The list is exactly what a reset may remove.
  const leftoverVolumes = displayedFailure?.leftover_reset?.length
    ? displayedFailure.leftover_reset
    : displayedFailure?.database_reset
      ? [displayedFailure.database_reset]
      : [];
  const leftoverContainers = displayedFailure?.leftover_containers ?? [];
  // Held here, above the screens, so changing screens never cancels it.
  const local = useLocalSequence({
    root,
    stack: localStack,
    connected: localConnected,
    onStart: (startable) => start(chosenModel.current, startable),
    onRecorded: (stack, connected) => {
      setLocalStack(stack);
      if (connected) setLocalConnected(true);
    },
  });
  /*
   * Whether this Start updates OpenBot itself, asked once the back end is waited on, so the Start
   * journey counts the update from the start rather than learning of it when it begins: on Windows
   * D the time left said "About a minute", then "About 2", then "About 3". Start uses this answer.
   */
  const releaseDueAsked = useRef<{
    root: string;
    answer: Promise<ReleaseMove | null>;
  } | null>(null);
  const [releaseDue, setReleaseDue] = useState(false);
  useEffect(() => {
    const at = root.trim();
    if (!local.running || local.at !== "wait" || !at) return;
    if (releaseDueAsked.current?.root === at) return;
    const answer = invoke<ReleaseMove | null>("upgrade_due", {
      root: at,
    }).catch(() => null);
    releaseDueAsked.current = { root: at, answer };
    void answer.then((due) => setReleaseDue(Boolean(due)));
  }, [local.running, local.at, root]);
  // A recorded stack: the OpenBot app's page may offer its dashboard (intelligence_bridge.rs).
  const intelligenceOffered = localStack !== null;
  // What the shell was last told. Starts hidden, so nothing is said before a stack is recorded.
  const offeredToMenus = useRef({ root: "", offered: false });
  useEffect(() => {
    const last = offeredToMenus.current;
    if (last.offered === intelligenceOffered && last.root === root) return;
    if (!last.offered && !intelligenceOffered) return;
    offeredToMenus.current = { root, offered: intelligenceOffered };
    offerLocalIntelligence(root, intelligenceOffered).catch(() => {});
  }, [root, intelligenceOffered]);
  // Stop OpenBot was chosen in this window: nothing local starts again on its own.
  const stoppedByChoice = useRef(false);
  const credentialContext = useRef([root, model, harness, step]);
  useEffect(() => {
    const next = [root, model, harness, step];
    if (
      next.some((value, index) => value !== credentialContext.current[index])
    ) {
      credentialContext.current = next;
      setFailure(null);
    }
  }, [root, model, harness, step]);

  useEffect(() => {
    let active = true;
    // A restart still owed comes first: a feature switched on reads as on before it runs.
    const windowsReady = invoke<boolean>("windows_restart_pending")
      .catch(() => false)
      .then(async (pending) => {
        if (pending) {
          setRestartPending(true);
          return false;
        }
        const found = await invoke<Blocker | null>("windows_blocker");
        setBlocker(found);
        if (found) {
          setInstruction(
            await invoke<string>("windows_blocker_instruction", {
              blocker: found,
            }),
          );
        }
        return found === null;
      })
      .catch((error) => {
        setBlockerFailure(asProblem(error));
        return false;
      });
    // Read once and kept apart from `last_failure`, which would hold auto-start.
    invoke<Problem | null>("last_local_eval_stop_failure")
      .then((found) => {
        if (active && found) setIntelligenceNotice(found);
      })
      .catch(() => {});
    // A supervisor that stopped retrying must stay stopped when it returns to this window.
    const interruptedRun = invoke<Problem | null>("last_failure")
      .then((found) => {
        if (found) {
          interruptedAtLaunch.current = true;
          setRecoveryFailure(found);
        }
        return found;
      })
      .catch(() => null);
    Promise.all([
      invoke<string | null>("selected_root").catch(() => null),
      invoke<string>("default_root"),
      windowsReady,
      interruptedRun,
    ])
      .then(async ([selected, fallback, canResume, interrupted]) => {
        if (!active) return;
        const found = selected || fallback;
        setRoot(found);
        /*
         * Arrive filled in when a previous run already wrote these.
         *
         * The alternative is asking somebody to find a key again, and "find it again" means opening
         * a dotfile in a text editor — the exact thing this product exists not to require. Their own
         * file, read back to them on their own machine.
         */
        const configured = await invoke<AlreadyConfigured>(
          "already_configured",
          { root: found.trim() },
        ).catch(() => null);
        if (!active) return;
        if (configured) {
          setAlreadyHeld({ ...configured.values, saved: configured.saved });
        }
        /*
         * Setup resumes part-way only for an installation with a local Intelligence stack recorded.
         * Anything else, including an installation an earlier app connected to a hosted
         * Intelligence, starts at the first screen. Its finished install is kept, so Install does
         * not run again for the same Bot, and nothing it saved is removed.
         */
        if (configured?.localEval) {
          setLocalStack(configured.localEval.stack);
          setLocalConnected(configured.localEval.connected === true);
        }
        const installed = configured?.localEval
          ? (configured.launch ?? configured.installation)
          : configured?.installation;
        const resumedModel =
          configured?.localEval && installed
            ? recordedModel({ ...configured.values, saved: configured.saved })
            : null;
        /*
         * Settings' Change on the AI model row stopped OpenBot to come here: open at the AI screen,
         * as this window's own Change AI connection does. Asked every load, and answered once.
         */
        const changeAiConnection = await invoke<boolean>(
          "take_ai_connection_change",
        ).catch(() => false);
        if (!active) return;
        if (installed) {
          const key = installationKeyFor(found, installed.harness);
          setHarness(installed.harness);
          setPreparation({ key, status: "complete" });
          if (configured?.localEval) {
            setModel(resumedModel);
            if (configured.launch) savedLaunch.current = key;
            setStep(resumedModel && !changeAiConnection ? "connect" : "model");
          }
        }
        if (interrupted?.connection) {
          recoverFromStart(interrupted);
          return;
        }
        // A stack this app started may still be up from a previous window. Ask, rather than
        // offering to set up something that is already running.
        if (
          await invoke<boolean>("already_running", { root: found }).catch(
            () => false,
          )
        ) {
          // Already up from a previous window: show it, rather than a screen about it.
          await invoke("show_openbot");
          setRunning(true);
          return;
        }
        if (
          !active ||
          !canResume ||
          !configured?.launch ||
          !configured.localEval ||
          !resumedModel
        )
          return;
        // An interrupted run needs an explicit Start, with its saved setup still available.
        // Nor one asked to change the AI connection: the new choice is what starts it.
        if (interrupted || configured.autoStart === false || changeAiConnection)
          return;
        // Intelligence must report ready and licensed first, which only its screen asks.
        if (configured.localEval.connected) setLocalAutoStart(true);
      })
      .catch((error) => {
        if (active) recoverFromStart(error);
      })
      .finally(() => {
        if (active) setCheckingResume(false);
      });
    const stop = listen<Progress>("setup:progress", (event) => {
      // One row per step, updated in place. A step that reports twice is the same step saying
      // more, and a list that grows a line each time reads as a log rather than as progress.
      setSteps((current) => {
        const at = current.findIndex(
          (step) => step.step === event.payload.step,
        );
        if (at === -1) return [...current, event.payload];
        const next = [...current];
        next[at] = event.payload;
        return next;
      });
    });
    return () => {
      active = false;
      stop.then((unlisten) => unlisten());
    };
  }, [recoverFromStart]);

  /** True when the installation completed. */
  async function install(nextHarness = harness): Promise<boolean> {
    if (busy || !root.trim()) return false;
    const installationKey = installationKeyFor(root, nextHarness);
    setBusy(true);
    setFailure(null);
    setRecoveryFailure(null);
    setInstallSince(Date.now());
    setSteps([
      {
        step: "engine",
        ok: true,
        running: true,
        detail: "Checking the software OpenBot needs.",
      },
    ]);
    setPreparation({ key: installationKey, status: "preparing" });
    try {
      await invoke("prepare_installation", {
        root: root.trim(),
        harness: nextHarness,
      });
      setSteps((current) => settleProgress(current));
      setPreparation({ key: installationKey, status: "complete" });
      return true;
    } catch (error) {
      const problem = asProblem(error);
      setSteps((current) => settleProgress(current, problem));
      setPreparation({ key: installationKey, status: "failed" });
      setFailure(problem);
      // The failure is the person's to act on, wherever they went while it installed.
      comeForward("the installation failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /*
   * Setup installs on the first screen's click, with the default Bot in the default folder: one
   * installation per computer. It needs no CopilotKit account, so it runs while the person signs
   * in; only Intelligence waits for the agreement. Once it completes, Intelligence sets up behind
   * the AI provider screen rather than after it. An installation already complete for the default
   * Bot is not installed again.
   */
  const localInstall = useRef<Promise<boolean> | null>(null);
  /** `again`: what was recorded as installed is not what this app starts, so install anyway. */
  function beginLocalInstall(again = false): Promise<boolean> {
    if (localInstall.current) return localInstall.current;
    const choice = { id: DEFAULT_HARNESS };
    setHarness(choice);
    if (
      !again &&
      preparation?.key === installationKeyFor(root, choice) &&
      preparation.status === "complete"
    ) {
      return Promise.resolve(true);
    }
    const started = install(choice).then((ok) => {
      // A failed install is started again by the next Install, not remembered.
      if (!ok) localInstall.current = null;
      return ok;
    });
    localInstall.current = started;
    return started;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per refused Start.
  useEffect(() => {
    // Once the refused Start has let go: Install will not begin while the window is busy.
    if (!reinstall || busy) return;
    setReinstall(false);
    // What was recorded as installed is not what this app starts, so it is installed again.
    localInstall.current = null;
    setPreparation(null);
    void installLocally(true);
  }, [reinstall, busy]);

  /*
   * Start carries on by itself after an install Start asked for, and has not started since. A Start
   * refused again then is said, rather than installing and starting round in a loop. The ref is for
   * the Start's own answer; the state is what starts it, through the same go-ahead as auto-start,
   * so the two never both start it.
   */
  const startedAfterReinstall = useRef(false);
  const [resumingStart, setResumingStart] = useState(false);

  /**
   * Shows the install until it completes, then the AI provider screen.
   *
   * `again` is the install a refused Start asked for. Nothing about the AI connection changed, so
   * one already saved is not asked for again: Start carries on with it. A saved connection that no
   * longer works is refused at Start, which sends the person to the AI screen for it.
   */
  async function installLocally(again = false) {
    setStep("install");
    if (!(await beginLocalInstall(again))) return;
    // The person was waiting on the install, and what comes next is theirs: the AI screen, or
    // Start carrying on. In front, wherever they went while it installed.
    comeForward("the installation is complete");
    setSteps([]);
    if (
      again &&
      !startedAfterReinstall.current &&
      modelCanStart(chosenModel.current)
    ) {
      startedAfterReinstall.current = true;
      setResumingStart(true);
      setStep("connect");
      return;
    }
    setStep("model");
  }

  /**
   * Starts OpenBot against a ready Intelligence.
   *
   * `started` only when OpenBot started. `deferred` when it has to be installed first: the window
   * goes to the install, and Start is asked for again after it. `failed` for anything else.
   */
  async function start(
    nextModel = model,
    intelligence: LocalStartable | null = null,
  ): Promise<StartOutcome> {
    if (!installationReady) {
      setStep("install");
      return "deferred";
    }
    // OpenBot starts only from a stack its CLI reports ready and licensed.
    if (!intelligence) {
      setStep("connect");
      return "deferred";
    }
    setBusy(true);
    setFailure(null);
    setReleaseNotice(null);
    setBackEndNotice(null);
    setSteps([]);
    try {
      const startWith = {
        root: root.trim(),
        // The key `local connect` gave OpenBot is in the vault; Start takes it from there.
        apiUrl: intelligence.apiUrl,
        gatewayWsUrl: intelligence.gatewayWsUrl,
        // The whole answer from the model screen, so the Rust side decides which keys that
        // implies. Sending a bare key here is what made `ANTHROPIC_API_KEY` and a plan token
        // expressible at the same time.
        model: nextModel,
        // By id only. The image, the port and how it is dialled are facts about the harness, and
        // the window carrying them would be a second list to keep in step with the catalogue.
        harness,
      };
      // The installation runs this app's own release: one that does not is upgraded as part of
      // this Start. An upgrade that fails is undone and the version it had starts instead.
      const asked =
        releaseDueAsked.current?.root === root.trim()
          ? releaseDueAsked.current.answer
          : null;
      // Asked afresh by the next Start.
      releaseDueAsked.current = null;
      const due = await (asked ??
        invoke<ReleaseMove | null>("upgrade_due", {
          root: root.trim(),
        }).catch(() => null));
      let outcome: ReleaseOutcome | null = null;
      if (due) {
        outcome = await invoke<ReleaseOutcome>("upgrade_and_start", startWith);
      } else {
        await invoke("start_stack", startWith);
      }
      setSteps((current) => settleProgress(current));
      setRunning(true);
      setRecoveryFailure(null);
      startedAfterReinstall.current = false;
      // The handover, on a first run as on a return: the window becomes OpenBot the moment the
      // stack is up. Recorded first, so a later Start of this installation reads as a return.
      savedLaunch.current = installationKey;
      setStep("connect");
      setRefreshIntelligence(false);
      // An upgrade that did not happen is said on the running screen first; Show OpenBot hands over.
      // So is a back end that runs the release it had because its own update did not finish.
      if (outcome?.notice || intelligence.notice) {
        // The notice says what the rows would: it is the one thing on the screen.
        setSteps([]);
        setReleaseNotice(outcome?.notice ?? null);
        setBackEndNotice(intelligence.notice ?? null);
        return "started";
      }
      await invoke("show_openbot");
      return "started";
    } catch (error) {
      recoverFromStart(error);
      // Refused until OpenBot is installed again, which the window now does by itself and then
      // starts. Only once: refused again straight after that install, it is a failure.
      return asProblem(error).connection === "installation" &&
        !startedAfterReinstall.current
        ? "deferred"
        : "failed";
    } finally {
      setBusy(false);
      // A Start carried on after its install has run, whatever it answered.
      setResumingStart(false);
    }
  }

  // OpenBot's own updates. The installation follows the app: Start upgrades it to the app's release.
  const appUpdates = <CheckForUpdates />;

  /** The leftovers go first, then Start carries on: starting fresh is one choice, not two. */
  async function startFresh(volumes: string[], containers: string[]) {
    setBusy(true);
    try {
      await invoke("reset_leftover_database", {
        root: root.trim(),
        volumes,
        containers,
        confirmed: true,
      });
    } catch (error) {
      setFailure(asProblem(error));
      return;
    } finally {
      // `start` sets `busy` itself, and its early return would never clear it.
      setBusy(false);
    }
    setFailure(null);
    setRecoveryFailure(null);
    setSteps([]);
    // Start again from the step that stopped, with the stack's addresses it already has.
    local.retry();
  }

  /** The model chosen can start OpenBot: a saved one must be complete enough to use. */
  function modelCanStart(choice = model) {
    if (!choice) return false;
    if (!choice.saved) return true;
    if (choice.provider === "google" || choice.provider === "xai") {
      return choice.login === "oauth" && Boolean(choice.model?.trim());
    }
    if (choice.provider === "openai-compatible") {
      return (
        choice.login === "endpoint" &&
        isHttpEndpointUrl(choice.baseUrl ?? "") &&
        Boolean(choice.model?.trim())
      );
    }
    if (choice.provider !== "openai" && choice.provider !== "anthropic") {
      return false;
    }
    return choice.login === "plan" || choice.login === "api-key";
  }

  /** True when OpenBot stopped, even if the local Intelligence stack it started did not. */
  async function stopStack(): Promise<boolean> {
    try {
      await invoke("stop_stack", { root });
      setIntelligenceNotice(null);
      return true;
    } catch (error) {
      const stopped = splitStopFailure(error);
      if (stopped.openBot === null && stopped.intelligence !== null) {
        setIntelligenceNotice(intelligenceStopProblem(stopped.intelligence));
        return true;
      }
      setFailure(asProblem(error));
      return false;
    }
  }

  async function stop() {
    setBusy(true);
    setStopping(true);
    // Stopped by choice: nothing starts again on its own in this session.
    setLocalAutoStart(false);
    stoppedByChoice.current = true;
    try {
      if (await stopStack()) {
        local.reset();
        setRunning(false);
        setRecoveryFailure(null);
        setStep("connect");
        setRefreshIntelligence(false);
      }
    } finally {
      setBusy(false);
      setStopping(false);
    }
  }

  async function showOpenBot() {
    setShowing(true);
    try {
      await invoke("show_openbot");
    } catch (error) {
      recoverFromStart(error);
    } finally {
      setShowing(false);
    }
  }

  /*
   * Starts local Intelligence without a click: a recorded stack on a first run that was not
   * interrupted, or a connected one on relaunch with auto-start on. Never after Stop OpenBot. And a
   * Start that waited for the install it asked for, which is carrying on, not starting anew.
   */
  const localAuto =
    !checkingResume &&
    !running &&
    step === "connect" &&
    modelCanStart() &&
    (resumingStart ||
      (!stoppedByChoice.current &&
        (returningToInstallation
          ? !refreshIntelligence && localAutoStart
          : !interruptedAtLaunch.current)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: when it turns on, or a Start resumes.
  useEffect(() => {
    if (localAuto) local.start();
  }, [localAuto, resumingStart]);

  // The person closed macOS's password prompt: whichever screen they are on says so, with Try
  // again, while Install asks again by itself. See `install::GoAhead`.
  const goAhead = goAheadNow(steps);
  // On a Mac whose own Podman OpenBot can't use: the offer to pause it while OpenBot runs, on
  // whichever screen the person is on, with the button that says yes. See `own_machine`.
  const pauseOffer = pauseOfferNow(steps);
  const pauseCard = pauseOffer && (
    <PausePodman key={pauseOffer} offer={pauseOffer} />
  );

  /*
   * What is installing behind a screen that asks the person for something else, as one row: the
   * account step and the AI step. It says what OpenBot is doing, how far along it is and for how
   * long, so the screen never looks stuck while minutes of install go on behind it.
   */
  // The downloads the first screen started, which the background row shows while they run.
  const earlyDownloads = useEarlyDownloads();
  const behind = (said: { waitingFor?: string; done?: string }) =>
    installingBehind({
      steps,
      installing: preparation?.status === "preparing",
      installed: installationReady,
      since: installSince,
      backEnd: local,
      early: earlyDownload(earlyDownloads),
      ...said,
    });

  // Quit outranks every screen: the app is closing, whatever was on it.
  const quitting = useQuitStatus(false);
  if (quitting) return <ShuttingDown status={quitting} />;

  // Nothing else on this screen can be done until the machine allows it, so nothing else is shown.
  if (blockerFailure) {
    return (
      <main>
        <div className="sheet">
          <h1>OpenBot could not check Windows setup</h1>
          <Failure problem={blockerFailure} />
        </div>
      </main>
    );
  }

  if (restartPending) return <WindowsRestart />;

  if (blocker) {
    return (
      <WindowsBlocker
        blocker={blocker}
        instruction={instruction}
        onRestartNeeded={() => setRestartPending(true)}
      />
    );
  }

  if (checkingResume) {
    return (
      <main>
        <div className="sheet connection-sheet">
          <h1>Getting OpenBot ready</h1>
          <p className="lede" role="status">
            Checking your saved setup…
          </p>
          <SetupProgress steps={steps} />
        </div>
      </main>
    );
  }

  /*
   * Skipped entirely when a stack is already up: somebody returning to a running OpenBot is not
   * setting one up.
   */
  if (!running && step === "welcome") {
    return (
      <main>
        <Welcome
          onInstall={() => {
            // The default Bot, recorded as a choice of it would be.
            recordSetupEvent(harnessChoiceEvent(DEFAULT_HARNESS));
            // The account is the first screen; OpenBot installs behind it meanwhile.
            setStep("account");
            void beginLocalInstall();
          }}
          failure={displayedFailure && <Failure problem={displayedFailure} />}
        />
      </main>
    );
  }

  if (!running && step === "install") {
    return (
      <main>
        <div className="sheet">
          <Sections at="Install" />
          <h1>
            {installationReady ? "Installation complete" : "Installing OpenBot"}
          </h1>
          <p className="lede">
            {installationReady
              ? "OpenBot’s local software is ready. Next, connect your AI."
              : INSTALL_BLURB}
          </p>
          {/* Intelligence sets itself up alongside, once the install has Docker answering. Its
              download is the list's third step, once the second is done. */}
          <SetupProgress
            steps={plainInstallSteps(
              steps,
              busy,
              installSince,
              !local.stopped && local.running ? local.download : null,
            )}
          />
          {/* The person closed macOS's password prompt: said, with Try again. */}
          {goAhead && <PodmanGoAhead asking={goAhead} />}
          {pauseCard}
          <LocalStatus sequence={local} download={false} />
          {/* The first screen's downloads, until a row of Install's own shows the one it waits on. */}
          {!steps.some((row) => row.running && row.downloads) && (
            <EarlyDownloadsLine />
          )}
          {displayedFailure && <Failure problem={displayedFailure} />}
          {!busy && (
            <div className="row">
              <button
                type="button"
                className="quiet"
                onClick={() => setStep("welcome")}
              >
                Back
              </button>
              {installationReady ? (
                <button
                  type="button"
                  onClick={() => {
                    setSteps([]);
                    setStep("model");
                  }}
                >
                  Continue to sign in
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!root.trim()}
                  onClick={() => installLocally()}
                >
                  {preparation?.status === "failed"
                    ? "Retry installation"
                    : "Install OpenBot"}
                </button>
              )}
            </div>
          )}
        </div>
      </main>
    );
  }

  /*
   * A first run signs in to CopilotKit and accepts the evaluation agreement as a step of its own,
   * before anything licensed is set up. Intelligence then sets itself up behind the AI provider
   * screen, with the version accepted here.
   */
  if (!running && step === "account") {
    return (
      <main>
        <CopilotKitAccount
          root={root.trim()}
          // Install runs behind this step. When it opens Docker Desktop, this step says so, and
          // while the account check waits on the engine, it says what Install is doing about it.
          handOff={handOffNow(steps)}
          engine={engineNow(steps)}
          // Once signed in, the step explains the password prompt Install waits to raise.
          goAhead={goAhead}
          // The engine answering and new enough: until then an engine refusal waits for Install.
          engineSettled={engineReady || installationReady}
          engineUpdating={steps.some(
            (row) => row.step === "engine" && row.running && row.updating,
          )}
          retried={setupRetries}
          // The offer to pause the person's own Podman, said on this step while it waits.
          pauseOffer={pauseOffer}
          // No slot once the install has failed: its failure is in the card, and nothing will
          // come into the slot until the person starts it again.
          behind={
            preparation?.status === "failed"
              ? undefined
              : behind({
                  waitingFor:
                    "The rest of the install starts after you sign in and accept the license agreement.",
                })
          }
          onDone={(acceptedVersion) => {
            if (acceptedVersion) local.acceptTerms(acceptedVersion);
            // Intelligence sets itself up once the install has Docker answering; see above. The
            // install may have got there during sign-in, and that change has already been seen.
            if (engineReady || installationReady) local.prepare();
            else intelligenceQueued.current = true;
            if (installationReady) {
              setSteps([]);
              setStep("model");
            } else void installLocally();
          }}
          failure={
            displayedFailure && (
              <Failure
                problem={displayedFailure}
                // The install behind this step failed: Try again runs it again, its check of the
                // software OpenBot runs on and any update or restart included. Nothing else on this
                // step would, and the account check waits on that software meanwhile.
                onRetry={
                  failure && preparation?.status === "failed"
                    ? () => {
                        setSetupRetries((count) => count + 1);
                        void beginLocalInstall();
                      }
                    : undefined
                }
              />
            )
          }
        />
      </main>
    );
  }

  if (!running && step === "model") {
    return (
      <main>
        <ProviderPicker
          held={alreadyHeld}
          root={root}
          chosen={model}
          returning={returningToInstallation}
          busy={busy}
          status={
            returningToInstallation ? (
              <LocalStatus sequence={local} />
            ) : (
              <BehindSlot>
                <BehindRow
                  row={behind({
                    done: "OpenBot starts as soon as you connect your AI.",
                  })}
                />
                <LocalStatus sequence={local} download={false} />
              </BehindSlot>
            )
          }
          onInstallRequired={(problem, choice) => {
            // The record is from an earlier run. Install again, keeping the provider chosen.
            localInstall.current = null;
            setPreparation(null);
            setSteps([]);
            setModel(choice);
            setRecoveryFailure(problem);
            setStep("install");
          }}
          onChoose={(choice) => {
            recordSetupEvent(modelChoiceEvent(choice));
            chosenModel.current = choice;
            setModel(choice);
            // The go-ahead: OpenBot starts once Intelligence is ready, wherever it has got to.
            setSteps([]);
            setStep("connect");
            local.start();
            // A Start the previous model was refused at stopped there: try it again with this one.
            if (local.stopped && local.at === "start") local.retry();
          }}
          // A first run has nothing behind this screen to go back to.
          onBack={
            returningToInstallation
              ? () => {
                  setSteps([]);
                  setStep("connect");
                }
              : undefined
          }
          failure={displayedFailure && <Failure problem={displayedFailure} />}
          // A failure from the provider tried before is not about the one chosen now.
          onProviderChange={() => {
            setFailure(null);
            setRecoveryFailure(null);
          }}
        />
      </main>
    );
  }

  const localStarting = local.running;
  // Start is moving the deployment to this app's release: said while it runs, which can be minutes.
  const updating = busy
    ? [...steps]
        .reverse()
        .find(
          (row) =>
            (row.step === "release" || row.step === "update-images") &&
            row.running,
        )
    : undefined;
  // One row while it updates, with its download's bar once there is one: "Installing OpenBot" sat
  // unchanged for minutes while the update's software downloaded. Not while the Start journey
  // shows, whose one bar counts the update too (`StartJourney`).
  const updatingLine = updating && !(local.running && !local.stopped) && (
    <SetupProgress
      label="Update progress"
      steps={[
        {
          step: "Updating OpenBot",
          ok: true,
          running: true,
          detail: updating.detail,
          unpacking: "Unpacking the update",
          downloads: steps.find((row) => row.step === "images" && row.running)
            ?.downloads,
        },
      ]}
    />
  );
  // Docker Desktop opened, or the engine machine started, before the back end starts, as after a
  // restart: said under the rows.
  const handOff = engineNow(steps);

  if (!running && returningToInstallation && !refreshIntelligence) {
    return (
      <main>
        <div className="sheet connection-sheet">
          <h1>{localStarting ? "Starting OpenBot" : "OpenBot is stopped"}</h1>
          <p className="lede">
            {localStarting
              ? "OpenBot is getting ready and opens by itself. This usually takes a minute or two."
              : "Your installation and saved connections are ready to reopen."}
          </p>
          <LocalIntelligence
            sequence={local}
            offerStart
            handOff={handOff}
            open={steps}
            releaseDue={releaseDue}
          />
          {goAhead && <PodmanGoAhead asking={goAhead} />}
          {pauseCard}
          {updatingLine}
          {displayedFailure && <Failure problem={displayedFailure} />}
          {/* While a local step runs, its Cancel is the only control. */}
          {!localStarting && (
            <>
              <div className="row">
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => setStep("model")}
                >
                  Change AI connection
                </button>
                {displayedFailure && (
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy}
                    onClick={() => install()}
                  >
                    Repair installation
                  </button>
                )}
              </div>
              {appUpdates}
              <details>
                <summary>Installation options</summary>
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => {
                    setPreparation(null);
                    setSteps([]);
                    setStep("install");
                  }}
                >
                  Change installation
                </button>
              </details>
            </>
          )}
        </div>
      </main>
    );
  }

  /*
   * The Start step: Intelligence's rows, and OpenBot starts by itself once the CLI reports it ready
   * and valid. While a CLI call runs, Cancel is the only control; leaving is offered only once
   * nothing runs.
   */
  if (!running) {
    return (
      <main>
        <div className="sheet connection-sheet">
          {leftoverVolumes.length > 0 && (
            <StartFresh
              key={`${root}:${leftoverVolumes.join(",")}:${leftoverContainers.join(",")}`}
              busy={busy}
              containers={leftoverContainers}
              database={Boolean(displayedFailure?.database_reset)}
              volumes={leftoverVolumes}
              onStartFresh={startFresh}
            />
          )}
          {!returningToInstallation && <Sections at="Start" />}
          {/* Not "Getting ready" over a "Getting OpenBot ready" row: Windows F read them as one. */}
          <h1>Finishing setup</h1>
          <p className="lede">
            OpenBot is setting up on this computer and starts by itself when
            it’s ready. This can take a few minutes.
          </p>
          <LocalIntelligence
            sequence={local}
            offerStart
            handOff={handOff}
            open={steps}
            releaseDue={releaseDue}
          />
          {goAhead && <PodmanGoAhead asking={goAhead} />}
          {pauseCard}
          {updatingLine}
          {/* Leftover data is a choice, offered above, not a failure to report here. */}
          {displayedFailure && leftoverVolumes.length === 0 && (
            <Failure problem={displayedFailure} />
          )}
          {!local.running && !busy && (
            <div className="row">
              <button
                type="button"
                className="quiet"
                onClick={() =>
                  returningToInstallation
                    ? setRefreshIntelligence(false)
                    : setStep("model")
                }
              >
                Back
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="sheet connection-sheet">
        {/* A failure outranks `running`. The supervisor gives up on a process and sends the window
          back here, and a heading that still says everything is running while the box underneath
          names the process that stopped is a screen arguing with itself. */}
        <h1>{displayedFailure ? "OpenBot stopped" : "OpenBot is running"}</h1>
        {/* The back end runs the release it had: information, said where the lede goes. Nothing
          failed, so it is not drawn as a failure and offers no help. */}
        {!displayedFailure && backEndNotice && (
          <p className="lede" role="status">
            {backEndNotice}
          </p>
        )}
        {!displayedFailure && !releaseNotice && !backEndNotice && (
          <p className="lede">
            OpenBot is open in this window. You can also show it or stop it from
            its icon in {trayPlace()}.
          </p>
        )}
        {/* Start went back to the version this installation had. Said before handing over. */}
        {!displayedFailure && releaseNotice && (
          <InlineFailure problem={releaseNotice} />
        )}
        {/* The start's rows only when something failed, to show where. Once OpenBot runs they are
          all done, and they flashed for the moment before it opened with the native side's own
          words ("settings written, credentials stored"). */}
        {displayedFailure && <SetupProgress steps={steps} />}
        {displayedFailure && <Failure problem={displayedFailure} />}
        {stopping && <StatusLine>Stopping OpenBot…</StatusLine>}
        {showing && <StatusLine>Loading OpenBot…</StatusLine>}
        <div className="row">
          <button
            type="button"
            /*
             * The refusal is shown, not swallowed.
             *
             * `show_openbot` answers with "OpenBot is not answering on port 3010 yet, so there is
             * nothing to show" when the app host process is not up, and this button dropped it on
             * the floor. Clicking it then did nothing at all, on a screen headed "OpenBot is
             * running", which is the worst of both: a true sentence was available and the window
             * threw it away.
             */
            onClick={showOpenBot}
            disabled={busy || showing}
          >
            Show OpenBot
          </button>
          <button
            type="button"
            className="quiet"
            onClick={stop}
            disabled={busy || showing}
          >
            Stop OpenBot
          </button>
        </div>
        {/* Under the buttons, as on the stopped screen. A disclosure draws a rule above itself, and
          first in the card it opened the card on a line with nothing above it. */}
        {returningToInstallation && appUpdates}
      </div>
    </main>
  );
}

/** The background install's row, when there is one. */
function BehindRow({ row }: { row: Progress | null }) {
  return row && <SetupProgress steps={[row]} label="Background install" />;
}

function settleProgress(steps: Progress[], problem?: Problem): Progress[] {
  return steps.map((step) =>
    step.running
      ? {
          ...step,
          running: false,
          ok: !problem,
          detail: problem?.said ?? "Finished.",
        }
      : step,
  );
}
