import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { Ask } from "./Ask";
import {
  DEFAULT_HARNESS,
  type HarnessChoice,
  HarnessPicker,
} from "./HarnessPicker";
import { isHttpEndpointUrl } from "./http-endpoint-url";
import { OrganizationSignIn } from "./OrganizationSignIn";
import { asProblem, Failure, type Problem } from "./Problem";
import {
  type HeldConfiguration,
  type ModelChoice,
  ProviderPicker,
  recordedModel,
} from "./ProviderPicker";
import {
  harnessChoiceEvent,
  modelChoiceEvent,
  recordSetupEvent,
  type SetupStep,
} from "./telemetry";
import { Welcome } from "./Welcome";

type EngineStatus = {
  engine: "docker" | "podman" | null;
  responding: boolean;
  engine_socket: string | null;
  detail: string;
};

type Blocker =
  | "wsl-absent"
  | "wsl-one"
  | "virtual-machine-platform-disabled"
  | "virtualization-disabled"
  | "not-administrator";

type Progress = {
  step: string;
  ok: boolean;
  detail: string;
  running?: boolean;
  downloadBytes?: number;
};

type AlreadyConfigured = {
  values: Record<string, string>;
  saved: NonNullable<HeldConfiguration["saved"]>;
  launch?: { harness: HarnessChoice | null } | null;
  installation?: { harness: HarnessChoice | null } | null;
  autoStart?: boolean;
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

/**
 * What the last screen offers to ask, mirroring `ask::SUGGESTED`.
 *
 * Two copies of one sentence, and a test in `ask.rs` pins what it has to contain. The window needs
 * it before it calls anything, and the Rust side needs it for the case where somebody clears the
 * field, so neither can be the only one that has it.
 */
const SUGGESTED_QUESTION = "What is 17 times 23?";

export function App() {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const [blockerFailure, setBlockerFailure] = useState<Problem | null>(null);
  const [instruction, setInstruction] = useState("");
  const [root, setRoot] = useState("");
  const [reuseIntelligence, setReuseIntelligence] = useState(false);
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
  /** Model credentials a previous run already wrote, so the provider screen arrives filled in. */
  const [alreadyHeld, setAlreadyHeld] = useState<HeldConfiguration>({});
  /*
   * Signing in to CopilotKit, which is how a managed deployment gets its key.
   *
   * The key field stays, behind the self-hosted disclosure, because somebody running their own
   * Intelligence has a key this sign-in knows nothing about. David's call: sign in on the main
   * path, paste on the developer one, which is the same shape as the model screen.
   */
  const [projects, setProjects] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [projectName, setProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  /*
   * The address the browser was sent to, kept so the screen can show it.
   *
   * Both plan sign-ins already do this, for the reason written next to them: an open that silently
   * did nothing, or a machine with no registered browser, leaves somebody watching a spinner with
   * no idea where they are meant to go. This one threw the address away, so that case had no way
   * out at all.
   */
  const [signInUrl, setSignInUrl] = useState<string | null>(null);

  async function signInToCopilotKit() {
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
    setFailure(null);
    try {
      // The key never passes through the window until it exists: it is created for the project
      // chosen here and put straight into the field this screen already had.
      setApiKey(await invoke<string>("intelligence_key_for", { project: id }));
      setProjects(null);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setSigningIn(false);
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

  const [step, setStep] = useState<SetupStep>("welcome");
  const [apiUrl, setApiUrl] = useState(MANAGED_INTELLIGENCE_API_URL);
  const [wsUrl, setWsUrl] = useState(MANAGED_INTELLIGENCE_GATEWAY_WS_URL);
  const [steps, setSteps] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [checkingResume, setCheckingResume] = useState(true);
  const savedLaunch = useRef<string | null>(null);
  const [refreshIntelligence, setRefreshIntelligence] = useState(false);
  const [preparation, setPreparation] = useState<{
    key: string;
    status: "preparing" | "complete" | "failed";
  } | null>(null);
  const installationKey = installationKeyFor(root, harness);
  const installationReady =
    preparation?.key === installationKey && preparation.status === "complete";
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
  const displayedFailure = failure ?? recoveryFailure;
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
    savedLaunch.current = null;
    setRefreshIntelligence(false);
    setRefreshOrganization(false);
    setOrganizationAuthorityUrl(null);
    setApiKey("");
    setReuseIntelligence(false);
    setApiUrl(MANAGED_INTELLIGENCE_API_URL);
    setWsUrl(MANAGED_INTELLIGENCE_GATEWAY_WS_URL);
    setAlreadyHeld({});
  }, []);

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
    const windowsReady = invoke<Blocker | null>("windows_blocker")
      .then(async (found) => {
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
    // A supervisor that stopped retrying must stay stopped when it returns to this window.
    const interruptedRun = invoke<Problem | null>("last_failure")
      .then((found) => {
        if (found) setRecoveryFailure(found);
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

  async function install() {
    if (busy || !root.trim()) return;
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
      await invoke("prepare_installation", { root: root.trim(), harness });
      setSteps((current) => settleProgress(current));
      setPreparation({ key: installationKey, status: "complete" });
    } catch (error) {
      const problem = asProblem(error);
      setSteps((current) => settleProgress(current, problem));
      setPreparation({ key: installationKey, status: "failed" });
      setFailure(problem);
    } finally {
      setBusy(false);
    }
  }

  async function start(nextModel = model) {
    if (!installationReady) {
      setStep("install");
      return;
    }
    setBusy(true);
    setFailure(null);
    setSteps([]);
    try {
      await invoke("start_stack", {
        root: root.trim(),
        apiUrl,
        gatewayWsUrl: wsUrl,
        apiKey,
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
      // Refreshing credentials does not turn an existing installation into a first run.
      if (
        savedLaunch.current === installationKey ||
        organizationAuthorityUrl?.trim()
      ) {
        savedLaunch.current = installationKey;
        setStep("connect");
        setRefreshIntelligence(false);
        await invoke("show_openbot");
        return;
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
    } catch (error) {
      recoverFromStart(error);
    } finally {
      setBusy(false);
      invoke<EngineStatus>("detect_engine")
        .then(setEngine)
        .catch(() => undefined);
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

  async function stop() {
    setBusy(true);
    try {
      await invoke("stop_stack", { root });
      setRunning(false);
      setRecoveryFailure(null);
      setStep("connect");
      setRefreshIntelligence(false);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeModelAfterAskFailure() {
    setBusy(true);
    setFailure(null);
    try {
      await invoke("stop_stack", { root });
      setRunning(false);
      setRecoveryFailure(null);
      setStep("model");
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  // Nothing else on this screen can be done until the machine allows it, so nothing else is shown.
  if (blockerFailure) {
    return (
      <main>
        <h1>OpenBot could not check Windows setup</h1>
        <Failure problem={blockerFailure} />
      </main>
    );
  }

  if (blocker) {
    return (
      <main>
        <h1>OpenBot needs one thing first</h1>
        <div className="blocker">
          <h2>{titleFor(blocker)}</h2>
          <p>{instruction}</p>
        </div>
      </main>
    );
  }

  if (resuming || checkingResume) {
    return (
      <main>
        <h1>{resuming ? "Starting OpenBot" : "Opening OpenBot"}</h1>
        <p role="status">
          {resuming
            ? "Opening your saved setup…"
            : "Checking your saved setup…"}
        </p>
        <SetupProgress steps={steps} />
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
        <Welcome onStart={() => setStep("harness")} />
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
          <p className="steps-of">Step 2 of 4</p>
          <h1>
            {installationReady ? "Installation complete" : "Install OpenBot"}
          </h1>
          <p className="lede">
            {installationReady
              ? "OpenBot’s local software is ready. Next, connect your AI and CopilotKit accounts."
              : "Install the software OpenBot needs on this computer. This can take a few minutes. You’ll sign in after installation finishes."}
          </p>
          {!installationReady && engine?.responding && (
            <p className="footnote">
              Using {engine.engine === "docker" ? "Docker" : "Podman"} for local
              services.
            </p>
          )}
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
          <SetupProgress steps={steps} />
          {displayedFailure && <Failure problem={displayedFailure} />}
          {busy && <p role="status">Installing local software…</p>}
          {installationReady && (
            <details>
              <summary>Installation options</summary>
              <button type="button" className="quiet" onClick={install}>
                Repair installation
              </button>
            </details>
          )}
          <div className="row">
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setStep("harness")}
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
                disabled={busy || !root.trim()}
                onClick={install}
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
          suggestion={SUGGESTED_QUESTION}
          onAsk={(question) =>
            invoke<string>("ask_the_bot", { root, question })
          }
          onOpen={() => {
            savedLaunch.current = installationKey;
            invoke("show_openbot").catch((error) => recoverFromStart(error));
          }}
          onBack={changeModelAfterAskFailure}
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
          onChoose={(choice) => {
            recordSetupEvent(modelChoiceEvent(choice));
            setModel(choice);
            if (returningToInstallation) void start(choice);
            else setStep("connect");
          }}
          onBack={() => {
            setSteps([]);
            setStep(returningToInstallation ? "connect" : "install");
          }}
        />
        {displayedFailure && <Failure problem={displayedFailure} />}
      </main>
    );
  }

  if (!running && returningToInstallation && !refreshIntelligence) {
    return (
      <main>
        <h1>OpenBot is stopped</h1>
        <p className="lede">
          Your installation and saved connections are ready to reopen.
        </p>
        <SetupProgress steps={steps} />
        {displayedFailure && <Failure problem={displayedFailure} />}
        <button
          type="button"
          disabled={busy || !installationReady || !modelCanStart()}
          onClick={() => start()}
        >
          {busy ? "Starting…" : "Start OpenBot"}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => setStep("model")}
        >
          Change AI connection
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => setRefreshIntelligence(true)}
        >
          Change CopilotKit connection
        </button>
        {displayedFailure && (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={install}
          >
            Repair installation
          </button>
        )}
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
      </main>
    );
  }

  return (
    <main>
      <div className="sheet connection-sheet">
        {/* A failure outranks `running`. The supervisor gives up on a process and sends the window
          back here, and a heading that still says everything is running while the box underneath
          names the process that stopped is a screen arguing with itself. */}
        {!running && !returningToInstallation && (
          <p className="steps-of">Step 4 of 4</p>
        )}
        <h1>
          {running && !displayedFailure
            ? "OpenBot is running"
            : returningToInstallation
              ? "Refresh your CopilotKit connection"
              : "Connect to CopilotKit"}
        </h1>
        <p className="lede">
          {running && !displayedFailure
            ? "The stack is up. OpenBot is in this window; the menu bar has it too, and stops it."
            : returningToInstallation
              ? "Update this connection to reopen your existing OpenBot."
              : "Local installation is complete. Connect CopilotKit, then start OpenBot."}
        </p>

        {!running && (
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
                <p className="lede">Connected to CopilotKit.</p>
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
                <p className="footnote">Waiting for you to approve it…</p>
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
                {projects.length === 0 && (
                  <>
                    <p className="footnote">
                      That account has no projects yet. Create one below, or
                      sign in with a different account.
                    </p>
                    <button
                      type="button"
                      className="quiet"
                      disabled={signingIn}
                      onClick={signInToCopilotKit}
                    >
                      {signingIn
                        ? "Waiting for your browser…"
                        : "Sign in again"}
                    </button>
                  </>
                )}
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
                These default to CopilotKit's managed service. Change them only
                if you run Intelligence yourself, and paste that server's key
                below.
              </p>
              <div className="field">
                <label htmlFor="key">Project key</label>
                <input
                  id="key"
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
                onClick={() =>
                  invoke("show_openbot").catch((error) =>
                    recoverFromStart(error),
                  )
                }
              >
                Show OpenBot
              </button>
              <button
                type="button"
                className="quiet"
                onClick={stop}
                disabled={busy}
              >
                Stop OpenBot
              </button>
            </>
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
                (apiKey.trim() === "" &&
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

function SetupProgress({ steps }: { steps: Progress[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="steps" aria-label="Setup progress" aria-live="polite">
      {steps.map((step) => (
        <SetupProgressRow key={step.step} step={step} />
      ))}
    </ol>
  );
}

function SetupProgressRow({ step }: { step: Progress }) {
  const [elapsed, setElapsed] = useState(0);
  const running = step.running ?? false;
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  return (
    <li className="step" aria-label={label(step.step)}>
      <span
        className={`mark ${running ? "active" : step.ok ? "good" : "bad"}`}
        aria-hidden="true"
      >
        {running ? <span className="step-spinner" /> : step.ok ? "✓" : "✗"}
      </span>
      <span className="step-label">{label(step.step)}</span>
      <span className="step-status">
        {running ? "In progress" : step.ok ? "Complete" : "Failed"}
        {running && (
          <span className="step-elapsed" aria-hidden="true" aria-live="off">
            {" · "}
            {elapsed < 60
              ? `${elapsed}s`
              : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}{" "}
            elapsed
          </span>
        )}
      </span>
      <span className="detail">
        {step.detail}
        {step.downloadBytes != null &&
          ` ${formatDownloadBytes(step.downloadBytes)} downloaded.`}
      </span>
    </li>
  );
}

function formatDownloadBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log10(bytes) / 3), units.length);
  return `${(bytes / 1000 ** power).toFixed(1)} ${units[power - 1]}`;
}

function titleFor(blocker: Blocker): string {
  switch (blocker) {
    case "wsl-absent":
      return "Windows Subsystem for Linux is not installed";
    case "wsl-one":
      return "Windows Subsystem for Linux is at version 1";
    case "virtual-machine-platform-disabled":
      return "Virtual Machine Platform is switched off";
    case "virtualization-disabled":
      return "Virtualization is off in this machine's firmware";
    case "not-administrator":
      return "This account cannot install Windows components";
  }
}

function label(step: string): string {
  switch (step) {
    case "engine":
    case "install-engine":
      return "Container engine";
    case "create-machine":
      return "Engine machine";
    case "start-machine":
      return "Starting the machine";
    case "health-gate":
      return "Engine answering";
    case "deployment":
      return "Deployment";
    case "env":
      return "Settings";
    case "ports":
      return "Ports";
    case "dependencies":
      return "Dependencies";
    case "images":
      return "Local software";
    case "installation":
      return "Installation";
    case "answering":
      return "Answering";
    case "services":
      return "Containers";
    case "migrate":
      return "Database";
    default:
      return step;
  }
}
