import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { Ask } from "./Ask";
import { CopilotKitAccount } from "./CopilotKitAccount";
import { DatabaseReset } from "./DatabaseReset";
import { useWindowFitsContent } from "./fitWindow";
import {
  DEFAULT_HARNESS,
  type HarnessChoice,
  HarnessPicker,
} from "./HarnessPicker";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { IntelligenceOpening } from "./IntelligenceOpening";
import {
  IntelligenceChoice,
  type IntelligenceMode,
  LocalIntelligence,
  LocalStatus,
  useLocalSequence,
} from "./LocalIntelligence";
import {
  intelligenceStopProblem,
  listLocalEval,
  offerLocalIntelligence,
  openLocalIntelligence,
  splitStopFailure,
} from "./localEvalCli";
import { OrganizationSignIn } from "./OrganizationSignIn";
import { asProblem, Failure, type Problem } from "./Problem";
import {
  type HeldConfiguration,
  type ModelChoice,
  ProviderPicker,
  recordedModel,
} from "./ProviderPicker";
import { Sections } from "./Sections";
import {
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

type EngineStatus = {
  engine: "docker" | "podman" | null;
  responding: boolean;
  engine_socket: string | null;
  detail: string;
};

type AlreadyConfigured = {
  values: Record<string, string>;
  saved: NonNullable<HeldConfiguration["saved"]>;
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

const MANAGED_INTELLIGENCE_API_URL = "https://api.intelligence.copilotkit.ai";
const MANAGED_INTELLIGENCE_GATEWAY_WS_URL =
  "wss://realtime.intelligence.copilotkit.ai";

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
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  // A Windows fix made earlier that only counts once Windows has restarted, and it has not.
  const [restartPending, setRestartPending] = useState(false);
  const [blockerFailure, setBlockerFailure] = useState<Problem | null>(null);
  const [instruction, setInstruction] = useState("");
  const [root, setRoot] = useState("");
  const [reuseIntelligence, setReuseIntelligence] = useState(false);
  // Offered only when this build has an Intelligence CLI to run; a local stack is its own mode,
  // not another setup step.
  const [localAvailable, setLocalAvailable] = useState(false);
  // The CLI answered either way, so the first screen knows which choice it offers.
  const [localChecked, setLocalChecked] = useState(false);
  // Null until somebody presses Continue on the choice, or a recorded local stack implies it.
  // Held per root in memory, so returning to step 4 does not ask again.
  const [intelligenceChoice, setIntelligenceMode] =
    useState<IntelligenceMode | null>(null);
  // The choice screen's selection, before Continue commits it.
  const [pickedIntelligence, setPickedIntelligence] =
    useState<IntelligenceMode | null>(null);
  const [localStack, setLocalStack] = useState<string | null>(null);
  const [localConnected, setLocalConnected] = useState(false);
  // A relaunch found a connected stack it may start, as a hosted launch resumes.
  const [localAutoStart, setLocalAutoStart] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [organizationAuthorityUrl, setOrganizationAuthorityUrl] = useState<
    string | null
  >(null);
  const [refreshOrganization, setRefreshOrganization] = useState(false);
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
  // A hosted connection somebody chose earlier: a saved key, or their own server's address.
  const hostedChosen =
    Boolean(alreadyHeld.saved?.intelligenceApiKey) ||
    Boolean(alreadyHeld.INTELLIGENCE_API_URL);
  // Before a choice, the preselection: local only when the CLI answered and nothing hosted is saved.
  const intelligenceMode =
    intelligenceChoice ??
    (localAvailable && !hostedChosen ? "local" : "hosted");
  // Step 4 asks first, and runs nothing until Continue. Only when the first screen did not ask.
  const choosingIntelligence = localAvailable && intelligenceChoice === null;
  // Local mode: three steps, and nothing a person reads about the software underneath.
  const localFlow = localAvailable && intelligenceChoice === "local";
  const [projects, setProjects] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [projectName, setProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [intelligenceSignInKind, setIntelligenceSignInKind] = useState<
    "managed" | "self-hosted"
  >("managed");
  const [selfHostedActive, setSelfHostedActive] = useState(false);
  const selfHostedAttempt = useRef(0);
  const selfHostedActiveRef = useRef(false);
  const cancelSelfHostedSignIn = useCallback(async () => {
    if (!selfHostedActiveRef.current) return;
    selfHostedActiveRef.current = false;
    selfHostedAttempt.current += 1;
    setSelfHostedActive(false);
    setSigningIn(false);
    setProjects(null);
    try {
      await invoke("cancel_self_hosted_intelligence_sign_in");
    } catch (error) {
      setFailure(asProblem(error));
    }
  }, []);

  async function signInToSelfHostedIntelligence() {
    await cancelSelfHostedSignIn();
    const attempt = ++selfHostedAttempt.current;
    selfHostedActiveRef.current = true;
    setSelfHostedActive(true);
    setIntelligenceSignInKind("self-hosted");
    setSigningIn(true);
    setFailure(null);
    setProjects(null);
    setApiKey("");
    setReuseIntelligence(false);
    try {
      const available = await invoke<{ id: string; name: string }[]>(
        "begin_self_hosted_intelligence_sign_in",
        { root, apiUrl },
      );
      if (selfHostedAttempt.current === attempt) setProjects(available);
    } catch (error) {
      if (selfHostedAttempt.current === attempt) {
        setFailure(asProblem(error));
        selfHostedActiveRef.current = false;
        setSelfHostedActive(false);
      }
    } finally {
      if (selfHostedAttempt.current === attempt) setSigningIn(false);
    }
  }

  /*
   * The address the browser was sent to, kept so the screen can show it.
   *
   * Both plan sign-ins already do this, for the reason written next to them: an open that silently
   * did nothing, or a machine with no registered browser, leaves somebody watching a spinner with
   * no idea where they are meant to go. This one threw the address away, so that case had no way
   * out at all.
   */
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  // The project whose key is being made, named while it is.
  const [connectingProject, setConnectingProject] = useState<string | null>(
    null,
  );
  // Running-screen actions that wait on the native side, said while they do.
  const [stopping, setStopping] = useState(false);
  const [showing, setShowing] = useState(false);

  async function signInToCopilotKit() {
    await cancelSelfHostedSignIn();
    setIntelligenceSignInKind("managed");
    setSigningIn(true);
    setFailure(null);
    setSignInUrl(null);
    try {
      setSignInUrl(await invoke<string>("begin_intelligence_sign_in"));
      setProjects(
        await invoke<{ id: string; name: string }[]>(
          "finish_intelligence_sign_in",
        ),
      );
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setSigningIn(false);
      setSignInUrl(null);
    }
  }

  async function pickProject(id: string) {
    setSigningIn(true);
    setConnectingProject(
      projects?.find((project) => project.id === id)?.name ?? null,
    );
    setFailure(null);
    const selfHosted = intelligenceSignInKind === "self-hosted";
    const attempt = selfHostedAttempt.current;
    try {
      const key = await invoke<string>(
        selfHosted
          ? "finish_self_hosted_intelligence_sign_in"
          : "intelligence_key_for",
        selfHosted ? { root, project: id } : { project: id },
      );
      if (selfHosted && selfHostedAttempt.current !== attempt) return;
      setApiKey(key);
      setProjects(null);
    } catch (error) {
      if (!selfHosted || selfHostedAttempt.current === attempt) {
        setFailure(asProblem(error));
        if (selfHosted) setProjects(null);
      }
    } finally {
      if (!selfHosted || selfHostedAttempt.current === attempt) {
        setSigningIn(false);
        setConnectingProject(null);
        if (selfHosted) {
          selfHostedActiveRef.current = false;
          setSelfHostedActive(false);
        }
      }
    }
  }
  async function createProject() {
    const name = projectName.trim();
    if (!name || signingIn) return;
    setSigningIn(true);
    setCreatingProject(true);
    setFailure(null);
    try {
      const project = await invoke<{ id: string; name: string }>(
        "create_intelligence_project",
        { name },
      );
      setProjects((current) => [...(current ?? []), project]);
      setProjectName("");
      await pickProject(project.id);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setSigningIn(false);
      setCreatingProject(false);
    }
  }

  function chooseIntelligence(mode: IntelligenceMode | null) {
    setIntelligenceMode(mode);
  }

  function continueWithIntelligence() {
    const mode = pickedIntelligence ?? intelligenceMode;
    chooseIntelligence(mode);
    // Continue with local is the go-ahead.
    if (mode === "local" && modelCanStart()) local.start();
    // Hosted begins at the sign-in, unless a connection is already saved to be checked at Start.
    if (
      mode === "hosted" &&
      !hostedChosen &&
      !apiKey.trim() &&
      !reuseIntelligence
    ) {
      void signInToCopilotKit();
    }
  }

  const [step, setStep] = useState<SetupStep>("welcome");
  const [apiUrl, setApiUrl] = useState(MANAGED_INTELLIGENCE_API_URL);
  const [wsUrl, setWsUrl] = useState(MANAGED_INTELLIGENCE_GATEWAY_WS_URL);
  const [steps, setSteps] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [checkingResume, setCheckingResume] = useState(true);
  const savedLaunch = useRef<string | null>(null);
  // An interrupted run needs an explicit Start, local Intelligence included.
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
   * A local first run sets Intelligence up alongside the OpenBot install, not after it: from the
   * moment the install reports the container engine ready (Intelligence runs on the same Docker,
   * and the install is what starts or installs it), or at once when the install is already done.
   * Queued by the CopilotKit account step, which runs first.
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
    checkingResume ||
    resuming ||
    blockerFailure ||
    blocker ||
    (running && step !== "ask")
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
  const configuredRunRef = useRef(0);
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
    if (problem.connection === "organization") setRefreshOrganization(true);
  }, []);
  // A local Intelligence stack OpenBot could not stop. Shown, but it never holds a start.
  const [intelligenceNotice, setIntelligenceNotice] = useState<Problem | null>(
    null,
  );
  const displayedFailure = failure ?? recoveryFailure ?? intelligenceNotice;
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
  // Local mode with a recorded stack: the dashboard can be opened, from here and from the menus.
  const intelligenceOffered = localFlow && localStack !== null;
  // What the menus were last told. Starts hidden, so a hosted run never calls.
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
  const credentialContext = useRef([
    root,
    model,
    apiKey,
    apiUrl,
    wsUrl,
    harness,
    step,
    reuseIntelligence,
  ]);
  useEffect(() => {
    const next = [
      root,
      model,
      apiKey,
      apiUrl,
      wsUrl,
      harness,
      step,
      reuseIntelligence,
    ];
    if (
      next.some((value, index) => value !== credentialContext.current[index])
    ) {
      credentialContext.current = next;
      setFailure(null);
    }
  }, [root, model, apiKey, apiUrl, wsUrl, harness, step, reuseIntelligence]);

  const clearRootScopedSavedState = useCallback(() => {
    void cancelSelfHostedSignIn();
    setIntelligenceSignInKind("managed");
    savedLaunch.current = null;
    setRefreshIntelligence(false);
    setRefreshOrganization(false);
    setOrganizationAuthorityUrl(null);
    setApiKey("");
    setReuseIntelligence(false);
    setIntelligenceMode(null);
    setPickedIntelligence(null);
    setLocalStack(null);
    setLocalConnected(false);
    setLocalAutoStart(false);
    setApiUrl(MANAGED_INTELLIGENCE_API_URL);
    setWsUrl(MANAGED_INTELLIGENCE_GATEWAY_WS_URL);
    setAlreadyHeld({});
  }, [cancelSelfHostedSignIn]);

  const loadConfiguredRoot = useCallback(
    async (nextRoot: string) => {
      const trimmedRoot = nextRoot.trim();
      const run = configuredRunRef.current + 1;
      configuredRunRef.current = run;
      clearRootScopedSavedState();
      if (!trimmedRoot) return;
      try {
        const configured = await invoke<AlreadyConfigured>(
          "already_configured",
          { root: trimmedRoot },
        );
        if (configuredRunRef.current !== run) return;
        const { values, saved } = configured;
        if (values.INTELLIGENCE_API_KEY) setApiKey(values.INTELLIGENCE_API_KEY);
        if (values.INTELLIGENCE_API_URL) setApiUrl(values.INTELLIGENCE_API_URL);
        if (values.INTELLIGENCE_GATEWAY_WS_URL)
          setWsUrl(values.INTELLIGENCE_GATEWAY_WS_URL);
        setAlreadyHeld({ ...values, saved });
        if (configured.localEval) {
          setLocalStack(configured.localEval.stack);
          setLocalConnected(configured.localEval.connected === true);
          setIntelligenceMode("local");
        }
        setOrganizationAuthorityUrl(
          values.OPENBOT_ORGANIZATION_AUTH_URL ?? null,
        );
        return configured;
      } catch {
        if (configuredRunRef.current === run) {
          setAlreadyHeld({});
        }
      }
    },
    [clearRootScopedSavedState],
  );

  useEffect(() => {
    let active = true;
    invoke<EngineStatus>("detect_engine")
      .then(setEngine)
      .catch(() => undefined);
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
    // A build without a pinned CLI answers `unavailable`, and local Intelligence is not offered.
    listLocalEval()
      .listing.then(() => {
        if (active) setLocalAvailable(true);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLocalChecked(true);
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
        const configured = await loadConfiguredRoot(found);
        if (!active) return;
        const installed = configured?.launch ?? configured?.installation;
        const resumedModel = configured
          ? recordedModel({
              ...configured.values,
              saved: configured.saved,
            })
          : null;
        if (installed) {
          const key = installationKeyFor(found, installed.harness);
          setHarness(installed.harness);
          setModel(resumedModel);
          setPreparation({ key, status: "complete" });
          if (configured?.launch) savedLaunch.current = key;
          setStep(resumedModel ? "connect" : "model");
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
        if (!active || !canResume || !configured?.launch || !resumedModel)
          return;
        const resumedHarness = configured.launch.harness;
        // An interrupted run needs an explicit Start, with its saved setup still available.
        if (interrupted || configured.autoStart === false) return;
        // Local Intelligence must report ready and licensed first, which only its screen asks.
        if (configured.localEval) {
          if (configured.localEval.connected) setLocalAutoStart(true);
          return;
        }
        setBusy(true);
        setResuming(true);
        try {
          // Only a successful previous setup supplies launch intent. Reopening uses its saved
          // connections and already installed assets; the native start still validates both.
          await invoke("start_stack", {
            root: found,
            apiKey: "",
            apiUrl:
              configured.values.INTELLIGENCE_API_URL ||
              MANAGED_INTELLIGENCE_API_URL,
            gatewayWsUrl:
              configured.values.INTELLIGENCE_GATEWAY_WS_URL ||
              MANAGED_INTELLIGENCE_GATEWAY_WS_URL,
            model: resumedModel,
            harness: resumedHarness,
            ...(configured.values.OPENBOT_ORGANIZATION_AUTH_URL
              ? {
                  organizationAuthUrl:
                    configured.values.OPENBOT_ORGANIZATION_AUTH_URL,
                }
              : {}),
          });
          if (!active) return;
          setSteps((current) => settleProgress(current));
          setRunning(true);
          setRecoveryFailure(null);
          await invoke("show_openbot");
        } catch (error) {
          if (active) recoverFromStart(error);
        } finally {
          if (active) {
            setBusy(false);
            setResuming(false);
          }
        }
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
  }, [loadConfiguredRoot, recoverFromStart]);

  /** True when the installation completed. */
  async function install(nextHarness = harness): Promise<boolean> {
    if (busy || !root.trim()) return false;
    const installationKey = installationKeyFor(root, nextHarness);
    setBusy(true);
    setFailure(null);
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
   * Local mode installs on the first screen's click, with the default Bot in the default folder:
   * one installation per computer. It needs no CopilotKit account, so it runs while the person
   * signs in; only Intelligence waits for the agreement. Once it completes, Intelligence sets up
   * behind the AI provider screen rather than after it.
   */
  const localInstall = useRef<Promise<boolean> | null>(null);
  function beginLocalInstall(): Promise<boolean> {
    if (localInstall.current) return localInstall.current;
    const choice = { id: DEFAULT_HARNESS };
    setHarness(choice);
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
    local: { apiUrl: string; gatewayWsUrl: string } | null = null,
  ): Promise<boolean> {
    if (!installationReady) {
      setStep("install");
      return false;
    }
    // Local Intelligence starts only from a stack its CLI reports ready and licensed.
    if (intelligenceMode === "local" && !local) {
      setStep("connect");
      return false;
    }
    setBusy(true);
    setFailure(null);
    setSteps([]);
    try {
      await invoke("start_stack", {
        root: root.trim(),
        apiUrl: local?.apiUrl ?? apiUrl,
        gatewayWsUrl: local?.gatewayWsUrl ?? wsUrl,
        // Empty for a local stack: Start takes the key `local connect` gave OpenBot from the vault.
        apiKey: local ? "" : apiKey,
        // The whole answer from the model screen, so the Rust side decides which keys that
        // implies. Sending a bare key here is what made `ANTHROPIC_API_KEY` and a plan token
        // expressible at the same time.
        model: nextModel,
        // By id only. The image, the port and how it is dialled are facts about the harness, and
        // the window carrying them would be a second list to keep in step with the catalogue.
        harness,
        ...(organizationAuthorityUrl !== null
          ? { organizationAuthUrl: organizationAuthorityUrl }
          : {}),
      });
      setSteps((current) => settleProgress(current));
      setRunning(true);
      setRecoveryFailure(null);
      // Refreshing credentials does not turn an existing installation into a first run. A first
      // local run asks its question too: Intelligence reporting ready says nothing about the model.
      if (
        savedLaunch.current === installationKey ||
        organizationAuthorityUrl?.trim()
      ) {
        savedLaunch.current = installationKey;
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
      invoke<EngineStatus>("detect_engine")
        .then(setEngine)
        .catch(() => undefined);
    }
  }

  async function resetLeftoverDatabase(volume: string) {
    setBusy(true);
    try {
      await invoke("reset_leftover_database", {
        root: root.trim(),
        volume,
        confirmed: true,
      });
      setFailure(null);
      setRecoveryFailure(null);
      setSteps([]);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
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
   * Starts local Intelligence without a click where a hosted setup would: a recorded stack on a
   * first run that was not interrupted, or a connected one on relaunch with auto-start on. Never
   * after Stop OpenBot.
   */
  const localAuto =
    !checkingResume &&
    !running &&
    !stoppedByChoice.current &&
    step === "connect" &&
    intelligenceMode === "local" &&
    !choosingIntelligence &&
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
        <h1>OpenBot could not check Windows setup</h1>
        <Failure problem={blockerFailure} />
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

  if (
    resuming ||
    checkingResume ||
    (!running && step === "welcome" && !localChecked)
  ) {
    return (
      <main>
        <div className="sheet connection-sheet">
          <h1>{resuming ? "Starting OpenBot" : "Getting OpenBot ready"}</h1>
          <p className="lede" role="status">
            {resuming
              ? "Loading your saved setup…"
              : "Checking your saved setup…"}
          </p>
          <SetupProgress steps={steps} />
        </div>
      </main>
    );
  }

  if (refreshOrganization) {
    return (
      <main>
        <OrganizationSignIn
          root={root}
          authorityUrl={organizationAuthorityUrl ?? ""}
          onBack={() => {
            setRefreshOrganization(false);
            setRefreshIntelligence(true);
            setRunning(false);
          }}
          onSignedIn={async () => {
            try {
              await invoke("show_openbot");
              setRefreshOrganization(false);
              setRecoveryFailure(null);
              setRunning(true);
            } catch (error) {
              recoverFromStart(error);
            }
          }}
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  /*
   * Install local software before showing either sign-in. A completed installation is retained
   * while somebody changes or retries their connection; changing its folder or Bot invalidates it.
   *
   * Skipped entirely when a stack is already up: somebody returning to a running OpenBot is not
   * setting one up, and asking them to pick a Bot again would be the wizard asking twice.
   */
  if (!running && step === "welcome") {
    return (
      <main>
        <Welcome
          onStart={() => setStep("harness")}
          local={
            localAvailable
              ? {
                  onInstall: () => {
                    chooseIntelligence("local");
                    // The default Bot, recorded as its Continue would.
                    recordSetupEvent(harnessChoiceEvent(DEFAULT_HARNESS));
                    // The account is the first screen; OpenBot installs behind it meanwhile.
                    setStep("account");
                    void beginLocalInstall();
                  },
                }
              : undefined
          }
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  if (!running && step === "harness") {
    return (
      <main>
        <HarnessPicker
          chosen={harness}
          onChoose={(choice) => {
            if (
              choice.id !== harness?.id ||
              choice.agentUrl !== harness?.agentUrl
            ) {
              setPreparation(null);
              setSteps([]);
            }
            setHarness(choice);
          }}
          onContinue={() => {
            recordSetupEvent(
              harnessChoiceEvent(harness?.id ?? DEFAULT_HARNESS),
            );
            setHarness((choice) =>
              choice?.id === "byo-url"
                ? { ...choice, agentUrl: choice.agentUrl?.trim() }
                : choice,
            );
            setStep("install");
          }}
          onBack={() => setStep("welcome")}
        />
      </main>
    );
  }

  if (!running && step === "install") {
    return (
      <main>
        <div className="sheet">
          <Sections local={localFlow} at="Install" />
          <h1>
            {installationReady
              ? "Installation complete"
              : localFlow
                ? "Installing OpenBot"
                : "Install OpenBot"}
          </h1>
          <p className="lede">
            {installationReady
              ? "OpenBot’s local software is ready. Next, connect your AI and CopilotKit accounts."
              : localFlow
                ? "OpenBot is installing what it needs on this computer. This can take a few minutes."
                : "Install the software OpenBot needs on this computer. This can take a few minutes. You’ll sign in after installation finishes."}
          </p>
          {!localFlow && !installationReady && engine?.responding && (
            <p className="footnote">
              Using {engine.engine === "docker" ? "Docker" : "Podman"} for local
              services.
            </p>
          )}
          {!localFlow && (
            <div className="field">
              <label htmlFor="root">Where OpenBot lives</label>
              <input
                id="root"
                disabled={busy}
                value={root}
                onChange={(event) => {
                  configuredRunRef.current += 1;
                  setRoot(event.target.value);
                  setModel(null);
                  setPreparation(null);
                  setSteps([]);
                  clearRootScopedSavedState();
                }}
                onBlur={(event) => loadConfiguredRoot(event.target.value)}
                spellCheck={false}
              />
            </div>
          )}
          <SetupProgress
            steps={localFlow ? plainInstallSteps(steps, busy) : steps}
          />
          {/* Intelligence sets itself up alongside, once the install has Docker answering. */}
          {localFlow && <LocalStatus sequence={local} />}
          {displayedFailure && <Failure problem={displayedFailure} />}
          {busy && !localFlow && (
            <p role="status">Installing local software…</p>
          )}
          {installationReady && !localFlow && (
            <details>
              <summary>Installation options</summary>
              <button type="button" className="quiet" onClick={() => install()}>
                Repair installation
              </button>
            </details>
          )}
          <div className="row">
            {!(localFlow && busy) && (
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => setStep(localFlow ? "welcome" : "harness")}
              >
                Back
              </button>
            )}
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
            ) : localFlow && busy ? null : (
              <button
                type="button"
                disabled={busy || !root.trim()}
                onClick={() => (localFlow ? installLocally() : install())}
              >
                {busy
                  ? "Installing…"
                  : preparation?.status === "failed"
                    ? "Retry installation"
                    : "Install OpenBot"}
              </button>
            )}
          </div>
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
          local={localFlow}
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
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  /*
   * A local first run signs in to CopilotKit and accepts the evaluation agreement as a step of its
   * own, after the software is installed and before anything licensed is set up. Intelligence then
   * sets itself up behind the AI provider screen, with the version accepted here.
   */
  if (!running && step === "account") {
    return (
      <main>
        <CopilotKitAccount
          onDone={(acceptedVersion) => {
            if (acceptedVersion) local.acceptTerms(acceptedVersion);
            // Intelligence sets itself up once the install has Docker answering; see below. The
            // install may have got there during sign-in, and that change has already been seen.
            if (engineReady || installationReady) local.prepare();
            else intelligenceQueued.current = true;
            if (installationReady) {
              setSteps([]);
              setStep("model");
            } else void installLocally();
          }}
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
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
          local={localFlow}
          status={localFlow && <LocalStatus sequence={local} />}
          onChoose={(choice) => {
            recordSetupEvent(modelChoiceEvent(choice));
            chosenModel.current = choice;
            setModel(choice);
            if (localFlow) {
              // The go-ahead: OpenBot starts once Intelligence is ready, wherever it has got to.
              setSteps([]);
              setStep("connect");
              local.start();
            } else if (returningToInstallation) void start(choice);
            else setStep("connect");
          }}
          // Local first runs have nothing behind this screen to go back to.
          onBack={
            localFlow && !returningToInstallation
              ? undefined
              : () => {
                  setSteps([]);
                  setStep(returningToInstallation ? "connect" : "install");
                }
          }
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  const localStarting = intelligenceMode === "local" && local.running;

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
          {intelligenceMode === "local" && (
            <LocalIntelligence sequence={local} offerStart />
          )}
          {intelligenceMode !== "local" && <SetupProgress steps={steps} />}
          {displayedFailure && <Failure problem={displayedFailure} />}
          {/* While a local step runs, its Cancel is the only control. */}
          {(intelligenceMode === "hosted" || !localStarting) && (
            <div className="row">
              {intelligenceMode === "hosted" && (
                <button
                  type="button"
                  disabled={busy || !installationReady || !modelCanStart()}
                  onClick={() => start()}
                >
                  {busy ? "Starting…" : "Start OpenBot"}
                </button>
              )}
              {!localStarting && (
                <>
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy}
                    onClick={() => setStep("model")}
                  >
                    Change AI connection
                  </button>
                  {intelligenceMode !== "local" && (
                    <button
                      type="button"
                      className="quiet"
                      disabled={busy}
                      onClick={() => {
                        // Changing it asks again where Intelligence runs.
                        chooseIntelligence(null);
                        setRefreshIntelligence(true);
                      }}
                    >
                      Change CopilotKit connection
                    </button>
                  )}
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
                </>
              )}
            </div>
          )}
          {!localStarting && (
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
          )}
        </div>
      </main>
    );
  }

  /*
   * Local Intelligence on step 4: its rows, and OpenBot starts by itself once the CLI reports it
   * ready and valid. While a CLI call runs, Cancel is the only control; leaving is offered only
   * once nothing runs.
   */
  if (!running && !choosingIntelligence && intelligenceMode === "local") {
    return (
      <main>
        <div className="sheet connection-sheet">
          {displayedFailure?.database_reset && (
            <DatabaseReset
              key={`${root}:${displayedFailure.database_reset}`}
              busy={busy}
              volume={displayedFailure.database_reset}
              onReset={resetLeftoverDatabase}
            />
          )}
          {!returningToInstallation && <Sections local at="Start" />}
          <h1>Getting ready</h1>
          <p className="lede">
            OpenBot starts as soon as Intelligence is ready. This can take a few
            minutes.
          </p>
          <LocalIntelligence sequence={local} offerStart />
          {displayedFailure && <Failure problem={displayedFailure} />}
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
              {localAvailable && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() => {
                    local.reset();
                    chooseIntelligence("hosted");
                  }}
                >
                  Use CopilotKit's hosted service instead
                </button>
              )}
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
        {!running && displayedFailure?.database_reset && (
          <DatabaseReset
            key={`${root}:${displayedFailure.database_reset}`}
            busy={busy}
            volume={displayedFailure.database_reset}
            onReset={resetLeftoverDatabase}
          />
        )}

        {!running && !returningToInstallation && (
          <Sections local={localFlow} at="Start" />
        )}
        <h1>
          {running && !displayedFailure
            ? "OpenBot is running"
            : choosingIntelligence && !running
              ? "Choose where Intelligence runs"
              : returningToInstallation
                ? "Refresh your CopilotKit connection"
                : "Connect to CopilotKit"}
        </h1>
        <p className="lede">
          {running && !displayedFailure
            ? "The stack is up. OpenBot is in this window; the menu bar has it too, and stops it."
            : choosingIntelligence && !running
              ? "OpenBot keeps your conversations in CopilotKit Intelligence. Nothing is set up until you continue."
              : returningToInstallation
                ? "Update this connection to reopen your existing OpenBot."
                : "Local installation is complete. Connect CopilotKit, then start OpenBot."}
        </p>

        {!running && choosingIntelligence && (
          <IntelligenceChoice
            chosen={pickedIntelligence ?? intelligenceMode}
            onChoose={setPickedIntelligence}
          />
        )}

        {!running && !choosingIntelligence && intelligenceMode === "hosted" && (
          <fieldset className="connection-form" disabled={busy}>
            {/*
            Sign in on the main path; paste behind the disclosure.

            This screen used to ask for a key whose only source was two terminal commands, which is
            the one thing the audience rule forbids. Somebody on managed CopilotKit now signs in and
            OpenBot creates the key for the project they pick. Somebody running their own
            Intelligence has a key this sign-in knows nothing about, so the field moves down there
            with the addresses it belongs with.
          */}
            {apiKey && !signingIn && !projects ? (
              <>
                <p className="lede">
                  {intelligenceSignInKind === "self-hosted"
                    ? "Connected to Intelligence."
                    : "Connected to CopilotKit."}
                </p>
                {returningToInstallation && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={signInToCopilotKit}
                  >
                    Sign in to CopilotKit again
                  </button>
                )}
              </>
            ) : (alreadyHeld.saved?.intelligenceApiKey || reuseIntelligence) &&
              !signingIn &&
              !projects ? (
              <>
                <p className="lede">
                  A saved CopilotKit connection will be checked when you start.
                </p>
                <button
                  type="button"
                  className="quiet"
                  onClick={signInToCopilotKit}
                >
                  Sign in to CopilotKit again
                </button>
              </>
            ) : signInUrl ? (
              <>
                <p className="lede">
                  Finish signing in to CopilotKit in your browser. If it did not
                  open, this is the address:
                </p>
                {/* Selectable text, not a link: the browser has already been asked to open it, and
                  what is needed here is something a person can copy. */}
                <p className="footnote" style={{ userSelect: "text" }}>
                  {signInUrl}
                </p>
                <StatusLine>Waiting for you to approve it…</StatusLine>
              </>
            ) : projects ? (
              <>
                <p className="lede">Which project should OpenBot use?</p>
                <fieldset className="picker">
                  <legend className="sr-only">Project</legend>
                  {projects.map((project) => (
                    <button
                      type="button"
                      key={project.id}
                      className="tile project-choice"
                      disabled={signingIn}
                      onClick={() => pickProject(project.id)}
                    >
                      <span className="tile-name">{project.name}</span>
                    </button>
                  ))}
                </fieldset>
                {connectingProject && (
                  <StatusLine>
                    Connecting OpenBot to {connectingProject}…
                  </StatusLine>
                )}
                {projects.length === 0 && (
                  <>
                    <p className="footnote">
                      {intelligenceSignInKind === "self-hosted"
                        ? "That account has no available projects. Ask your Intelligence administrator for access, or sign in with a different account."
                        : "That account has no projects yet. Create one below, or sign in with a different account."}
                    </p>
                    <button
                      type="button"
                      className="quiet"
                      disabled={signingIn}
                      onClick={
                        intelligenceSignInKind === "self-hosted"
                          ? signInToSelfHostedIntelligence
                          : signInToCopilotKit
                      }
                    >
                      {signingIn
                        ? "Waiting for your browser…"
                        : "Sign in again"}
                    </button>
                  </>
                )}
                {intelligenceSignInKind === "managed" && (
                  <form
                    className="new-project-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createProject();
                    }}
                  >
                    <div className="field">
                      <label htmlFor="new-project-name">New project name</label>
                      <input
                        id="new-project-name"
                        value={projectName}
                        onChange={(event) => setProjectName(event.target.value)}
                        disabled={signingIn}
                        autoComplete="off"
                      />
                    </div>
                    <button
                      type="submit"
                      className={projects.length > 0 ? "quiet" : undefined}
                      disabled={signingIn || !projectName.trim()}
                    >
                      {creatingProject ? "Creating project…" : "Create project"}
                    </button>
                  </form>
                )}
              </>
            ) : (
              <>
                <p className="lede">
                  OpenBot keeps your conversations in CopilotKit. Sign in and it
                  sets the rest up for you.
                </p>
                <div className="row connection-actions">
                  <button
                    type="button"
                    disabled={signingIn}
                    onClick={signInToCopilotKit}
                  >
                    {signingIn
                      ? "Waiting for your browser…"
                      : "Sign in to CopilotKit"}
                  </button>
                  {!apiKey &&
                    !reuseIntelligence &&
                    alreadyHeld.saved?.intelligenceApiKey == null &&
                    !signingIn && (
                      <button
                        type="button"
                        className="quiet"
                        onClick={() => setReuseIntelligence(true)}
                      >
                        Use a saved connection
                      </button>
                    )}
                </div>
                {/* Managed sign-in only: the self-hosted one says its own line below. */}
                {signingIn && intelligenceSignInKind === "managed" && (
                  <StatusLine>
                    Opening CopilotKit sign-in in your browser…
                  </StatusLine>
                )}
              </>
            )}
            {/*
            This used to be headed "Self-hosted Intelligence" over two fields pre-filled with the
            MANAGED service's addresses, which says the opposite of what it does: somebody opening
            it to check where their data goes read "self-hosted" and saw CopilotKit's own hosts.
            The heading now describes the action, and the note says what the defaults are.
          */}
            <details>
              <summary>Point at your own Intelligence server</summary>
              <p className="footnote" style={{ margin: "0.6rem 0 0.75rem" }}>
                Enter your Intelligence server’s addresses, then sign in to
                choose a project. OpenBot creates its Learning container for
                you. Sign-in requires Chrome or Microsoft Edge. You can also use
                an existing project key.
              </p>
              <div className="field">
                <label htmlFor="key">Project key</label>
                <input
                  id="key"
                  disabled={selfHostedActive}
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="the key from your own Intelligence"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="field" style={{ marginTop: "0.75rem" }}>
                <label htmlFor="api">API URL</label>
                <input
                  id="api"
                  disabled={selfHostedActive}
                  value={apiUrl}
                  onChange={(event) => setApiUrl(event.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label htmlFor="ws">Gateway WebSocket URL</label>
                <input
                  id="ws"
                  value={wsUrl}
                  onChange={(event) => setWsUrl(event.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="row connection-actions">
                <button
                  type="button"
                  disabled={signingIn || selfHostedActive || !apiUrl.trim()}
                  onClick={signInToSelfHostedIntelligence}
                >
                  Sign in to Intelligence
                </button>
                {selfHostedActive && (
                  <button
                    type="button"
                    className="quiet"
                    onClick={cancelSelfHostedSignIn}
                  >
                    Cancel Intelligence sign-in
                  </button>
                )}
              </div>
              {selfHostedActive && signingIn && !projects && (
                <p className="footnote" role="status">
                  Finish signing in in the Intelligence browser window…
                </p>
              )}
            </details>
            <details>
              <summary>Sign in through your organization</summary>
              <p className="footnote">
                Enter your organization’s OpenBot address to use its sign-in and
                access rules.
              </p>
              <div className="field">
                <label htmlFor="organization-authority">
                  Organization OpenBot URL
                </label>
                <input
                  id="organization-authority"
                  value={organizationAuthorityUrl ?? ""}
                  onChange={(event) =>
                    setOrganizationAuthorityUrl(event.target.value)
                  }
                  placeholder="https://openbot.your-company.com"
                  spellCheck={false}
                />
              </div>
            </details>
            {localAvailable && (
              <button
                type="button"
                className="quiet"
                disabled={signingIn}
                onClick={() => chooseIntelligence(null)}
              >
                Choose where Intelligence runs
              </button>
            )}
          </fieldset>
        )}

        <SetupProgress steps={steps} />

        {displayedFailure && <Failure problem={displayedFailure} />}

        {!running && !returningToInstallation && (
          <details>
            <summary>Installation options</summary>
            <button
              type="button"
              className="quiet"
              disabled={busy || signingIn}
              onClick={() => {
                setPreparation(null);
                setSteps([]);
                setStep("install");
              }}
            >
              Change installation
            </button>
          </details>
        )}
        {stopping && <StatusLine>Stopping OpenBot…</StatusLine>}
        {showing && <StatusLine>Loading OpenBot…</StatusLine>}
        <div className="row">
          {!running && (
            <button
              type="button"
              className="quiet"
              disabled={busy || signingIn}
              onClick={() =>
                returningToInstallation
                  ? setRefreshIntelligence(false)
                  : setStep("model")
              }
            >
              Back
            </button>
          )}
          {running ? (
            <>
              <button
                type="button"
                /*
                 * The refusal is shown, not swallowed.
                 *
                 * `show_openbot` answers with "OpenBot is not answering on port 3010 yet, so there
                 * is nothing to show" when the app host process is not up, and this button dropped
                 * it on the floor. Clicking it then did nothing at all, on a screen headed "OpenBot
                 * is running", which is the worst of both: a true sentence was available and the
                 * window threw it away. The Ask screen's copy of this call always showed it.
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
            </>
          ) : choosingIntelligence ? (
            <button type="button" onClick={continueWithIntelligence}>
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={() => start()}
              // The model is answered by its own screen now, so what is checked here is that it was
              // answered at all, not that some field on this screen is non-empty.
              disabled={
                busy ||
                signingIn ||
                !installationReady ||
                (intelligenceMode === "hosted" &&
                  apiKey.trim() === "" &&
                  !alreadyHeld.saved?.intelligenceApiKey &&
                  !reuseIntelligence) ||
                !modelCanStart() ||
                root.trim() === ""
              }
            >
              {busy ? "Working…" : "Start OpenBot"}
            </button>
          )}
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
