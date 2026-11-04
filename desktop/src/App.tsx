import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { Ask } from "./Ask";
import { CopilotKitAccount } from "./CopilotKitAccount";
import { useWindowFitsContent } from "./fitWindow";
import { DEFAULT_HARNESS, type HarnessChoice } from "./harness";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { IntelligenceOpening } from "./IntelligenceOpening";
import {
  LocalIntelligence,
  type LocalStartable,
  LocalStatus,
  useLocalSequence,
} from "./LocalIntelligence";
import {
  intelligenceStopProblem,
  offerLocalIntelligence,
  openLocalIntelligence,
  splitStopFailure,
} from "./localEvalCli";
import { asProblem, Failure, type Problem } from "./Problem";
import {
  type HeldConfiguration,
  type ModelChoice,
  ProviderPicker,
  recordedModel,
} from "./ProviderPicker";
import { Sections } from "./Sections";
import { StartFresh } from "./StartFresh";
import {
  INSTALL_BLURB,
  type Progress,
  plainInstallSteps,
  SetupProgress,
  StatusLine,
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

function installationKeyFor(root: string, harness: HarnessChoice | null) {
  return JSON.stringify([
    root.trim(),
    harness?.id ?? DEFAULT_HARNESS,
    harness?.agentUrl?.trim() ?? "",
  ]);
}

export function App() {
  useWindowFitsContent();
  return (
    <>
      <Setup />
      <IntelligenceOpening />
    </>
  );
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

  const [step, setStep] = useState<SetupStep>("welcome");
  const [steps, setSteps] = useState<Progress[]>([]);
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
    checkingResume || blockerFailure || blocker || (running && step !== "ask")
      ? null
      : step;
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
  }, []);
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
  // A recorded stack: the dashboard can be opened, from here and from the menus.
  const intelligenceOffered = localStack !== null;
  // What the menus were last told. Starts hidden, so nothing is said before a stack is recorded.
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
        if (installed) {
          const key = installationKeyFor(found, installed.harness);
          setHarness(installed.harness);
          setPreparation({ key, status: "complete" });
          if (configured?.localEval) {
            setModel(resumedModel);
            if (configured.launch) savedLaunch.current = key;
            setStep(resumedModel ? "connect" : "model");
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
        if (interrupted || configured.autoStart === false) return;
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
  function beginLocalInstall(): Promise<boolean> {
    if (localInstall.current) return localInstall.current;
    const choice = { id: DEFAULT_HARNESS };
    setHarness(choice);
    if (
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

  /** Shows the install until it completes, then the AI provider screen. */
  async function installLocally() {
    setStep("install");
    if (await beginLocalInstall()) {
      setSteps([]);
      setStep("model");
    }
  }

  /** True when OpenBot started. */
  async function start(
    nextModel = model,
    intelligence: LocalStartable | null = null,
  ): Promise<boolean> {
    if (!installationReady) {
      setStep("install");
      return false;
    }
    // OpenBot starts only from a stack its CLI reports ready and licensed.
    if (!intelligence) {
      setStep("connect");
      return false;
    }
    setBusy(true);
    setFailure(null);
    setSteps([]);
    try {
      await invoke("start_stack", {
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
      });
      setSteps((current) => settleProgress(current));
      setRunning(true);
      setRecoveryFailure(null);
      // Refreshing a connection does not turn an existing installation into a first run. A first
      // run asks its question: Intelligence reporting ready says nothing about the model.
      if (savedLaunch.current === installationKey) {
        setStep("connect");
        setRefreshIntelligence(false);
        await invoke("show_openbot");
        return true;
      }
      /*
       * One screen short of the handover, on purpose.
       *
       * The window used to become OpenBot here, the moment the stack was up. But up is not the
       * same as working: a refused key or a lapsed plan gives a stack that starts clean and a Bot
       * that cannot answer, and handing over at this point means somebody discovers that inside
       * the product with no idea which of their answers caused it. So the last screen asks a
       * question, and the handover waits for an answer to come back.
       */
      setStep("ask");
      return true;
    } catch (error) {
      recoverFromStart(error);
      return false;
    } finally {
      setBusy(false);
    }
  }

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

  function modelCanStart() {
    if (!model) return false;
    if (!model.saved) return true;
    if (model.provider === "google" || model.provider === "xai") {
      return model.login === "oauth" && Boolean(model.model?.trim());
    }
    if (model.provider === "openai-compatible") {
      return (
        model.login === "endpoint" &&
        isHttpEndpointUrl(model.baseUrl ?? "") &&
        Boolean(model.model?.trim())
      );
    }
    if (model.provider !== "openai" && model.provider !== "anthropic") {
      return false;
    }
    return model.login === "plan" || model.login === "api-key";
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

  async function changeModelAfterAskFailure() {
    setBusy(true);
    setFailure(null);
    try {
      if (await stopStack()) {
        local.reset();
        setRunning(false);
        setRecoveryFailure(null);
        setStep("model");
      }
    } finally {
      setBusy(false);
    }
  }

  /*
   * Starts local Intelligence without a click: a recorded stack on a first run that was not
   * interrupted, or a connected one on relaunch with auto-start on. Never after Stop OpenBot.
   */
  const localAuto =
    !checkingResume &&
    !running &&
    !stoppedByChoice.current &&
    step === "connect" &&
    modelCanStart() &&
    (returningToInstallation
      ? !refreshIntelligence && localAutoStart
      : !interruptedAtLaunch.current);
  // biome-ignore lint/correctness/useExhaustiveDependencies: when it turns on.
  useEffect(() => {
    if (localAuto) local.start();
  }, [localAuto]);

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
          <SetupProgress steps={plainInstallSteps(steps, busy)} />
          {/* Intelligence sets itself up alongside, once the install has Docker answering. */}
          <LocalStatus sequence={local} />
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
   * Shown while the stack is running, which every other screen is skipped for. This is the one
   * screen that needs a running stack: it is the proof, and there is nothing to ask before there
   * is something to ask.
   */
  if (step === "ask") {
    return (
      <main>
        <Ask
          onAsk={(question) =>
            invoke<string>("ask_the_bot", { root, question })
          }
          onOpen={() => {
            savedLaunch.current = installationKey;
            return invoke<void>("show_openbot").catch((error) =>
              recoverFromStart(error),
            );
          }}
          onBack={changeModelAfterAskFailure}
          onViewIntelligence={
            intelligenceOffered
              ? () => openLocalIntelligence(root).opened
              : undefined
          }
          failure={displayedFailure && <Failure problem={displayedFailure} />}
        />
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
          failure={displayedFailure && <Failure problem={displayedFailure} />}
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
          status={<LocalStatus sequence={local} />}
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

  if (!running && returningToInstallation && !refreshIntelligence) {
    return (
      <main>
        <div className="sheet connection-sheet">
          <h1>{localStarting ? "Starting OpenBot" : "OpenBot is stopped"}</h1>
          <p className="lede">
            {localStarting
              ? "Starting Intelligence and OpenBot on this computer."
              : "Your installation and saved connections are ready to reopen."}
          </p>
          <LocalIntelligence sequence={local} offerStart />
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
          <h1>Getting ready</h1>
          <p className="lede">
            OpenBot is setting up on this computer and starts by itself when
            it’s ready. This can take a few minutes.
          </p>
          <LocalIntelligence sequence={local} offerStart />
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
        {!displayedFailure && (
          <p className="lede">
            OpenBot is open in this window. You can also show it or stop it from
            the menu bar.
          </p>
        )}
        <SetupProgress steps={steps} />
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
             * threw it away. The Ask screen's copy of this call always showed it.
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
      </div>
    </main>
  );
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
