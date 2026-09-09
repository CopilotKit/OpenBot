import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { Ask } from "./Ask";
import {
  DEFAULT_HARNESS,
  type HarnessChoice,
  HarnessPicker,
} from "./HarnessPicker";
import { asProblem, Failure, type Problem } from "./Problem";
import {
  type HeldConfiguration,
  type ModelChoice,
  ProviderPicker,
} from "./ProviderPicker";
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
  | "virtualization-disabled"
  | "not-administrator";

type Progress = { step: string; ok: boolean; detail: string };

type AlreadyConfigured = {
  values: Record<string, string>;
  saved: NonNullable<HeldConfiguration["saved"]>;
};

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

/**
 * One screen, four states: something is in the way, nothing is set up yet, it is working, it is
 * running. A wizard with more screens than states is a wizard that asks twice.
 */
export function App() {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const [instruction, setInstruction] = useState("");
  const [root, setRoot] = useState("");
  const [apiKey, setApiKey] = useState("");
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
  const [step, setStep] = useState<
    "welcome" | "harness" | "model" | "install" | "ask"
  >("welcome");
  const [apiUrl, setApiUrl] = useState(MANAGED_INTELLIGENCE_API_URL);
  const [wsUrl, setWsUrl] = useState(MANAGED_INTELLIGENCE_GATEWAY_WS_URL);
  const [steps, setSteps] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
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

  const clearRootScopedSavedState = useCallback(() => {
    setApiKey("");
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
        const { values, saved } = await invoke<AlreadyConfigured>(
          "already_configured",
          { root: trimmedRoot },
        );
        if (configuredRunRef.current !== run) return;
        if (values.INTELLIGENCE_API_KEY) setApiKey(values.INTELLIGENCE_API_KEY);
        if (values.INTELLIGENCE_API_URL) setApiUrl(values.INTELLIGENCE_API_URL);
        if (values.INTELLIGENCE_GATEWAY_WS_URL)
          setWsUrl(values.INTELLIGENCE_GATEWAY_WS_URL);
        setAlreadyHeld({ ...values, saved });
      } catch {
        if (configuredRunRef.current === run) {
          setAlreadyHeld({});
        }
      }
    },
    [clearRootScopedSavedState],
  );

  useEffect(() => {
    invoke<EngineStatus>("detect_engine")
      .then(setEngine)
      .catch(() => undefined);
    invoke<string>("default_root")
      .then(async (found) => {
        setRoot(found);
        /*
         * Arrive filled in when a previous run already wrote these.
         *
         * The alternative is asking somebody to find a key again, and "find it again" means opening
         * a dotfile in a text editor — the exact thing this product exists not to require. Their own
         * file, read back to them on their own machine.
         */
        loadConfiguredRoot(found);
        // A stack this app started may still be up from a previous window. Ask, rather than
        // offering to set up something that is already running.
        if (
          await invoke<boolean>("already_running", { root: found }).catch(
            () => false,
          )
        ) {
          setRunning(true);
          // Already up from a previous window: show it, rather than a screen about it.
          await invoke("show_openbot").catch(() => undefined);
        }
      })
      .catch(() => undefined);
    invoke<Blocker | null>("windows_blocker")
      .then(async (found) => {
        setBlocker(found);
        if (found) {
          setInstruction(
            await invoke<string>("windows_blocker_instruction", {
              blocker: found,
            }),
          );
        }
      })
      .catch(() => undefined);
    // Why the stack stopped, if it did while this screen was not loaded. The supervisor gives up
    // and sends the window back here, and without this the person arrives at a setup screen with
    // no indication that anything happened.
    invoke<Problem | null>("last_failure")
      .then((found) => {
        if (found) setFailure(found);
      })
      .catch(() => undefined);
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
      stop.then((unlisten) => unlisten());
    };
  }, [loadConfiguredRoot]);

  async function start() {
    setBusy(true);
    setFailure(null);
    setSteps([]);
    try {
      await invoke("prepare_engine");
      await invoke("start_stack", {
        root,
        apiUrl,
        gatewayWsUrl: wsUrl,
        apiKey,
        // The whole answer from the model screen, so the Rust side decides which keys that
        // implies. Sending a bare key here is what made `ANTHROPIC_API_KEY` and a plan token
        // expressible at the same time.
        model,
        // By id only. The image, the port and how it is dialled are facts about the harness, and
        // the window carrying them would be a second list to keep in step with the catalogue.
        harness,
      });
      setRunning(true);
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
      setFailure(asProblem(error));
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
    if (model.provider !== "openai" && model.provider !== "anthropic") {
      return false;
    }
    if (model.login === "plan") {
      return alreadyHeld.saved?.modelSessions?.[model.provider] === true;
    }
    if (model.login === "api-key") {
      return alreadyHeld.saved?.modelApiKeys?.[model.provider] === true;
    }
    return false;
  }

  async function stop() {
    setBusy(true);
    try {
      await invoke("stop_stack", { root });
      setRunning(false);
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
      setStep("model");
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  // Nothing else on this screen can be done until the machine allows it, so nothing else is shown.
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

  /*
   * Which Bot, then which model, then install. Before this the screen asked for an OpenAI key in a
   * password field, which is the developer-shaped main path the audience rule exists to prevent.
   *
   * Skipped entirely when a stack is already up: somebody returning to a running OpenBot is not
   * setting one up, and asking them to pick a Bot again would be the wizard asking twice.
   */
  if (!running && step === "welcome") {
    return (
      <main>
        <Welcome onStart={() => setStep("harness")} />
      </main>
    );
  }

  if (!running && step === "harness") {
    return (
      <main>
        <HarnessPicker
          chosen={harness}
          onChoose={setHarness}
          onContinue={() => {
            setHarness((choice) =>
              choice?.id === "byo-url"
                ? { ...choice, agentUrl: choice.agentUrl?.trim() }
                : choice,
            );
            setStep("model");
          }}
          onBack={() => setStep("welcome")}
        />
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
            invoke("show_openbot").catch((error) =>
              setFailure(asProblem(error)),
            );
          }}
          onBack={changeModelAfterAskFailure}
        />
        {failure && <Failure problem={failure} />}
      </main>
    );
  }

  if (!running && step === "model") {
    return (
      <main>
        <ProviderPicker
          held={alreadyHeld}
          chosen={model}
          onChoose={(choice) => {
            setModel(choice);
            setStep("install");
          }}
          onBack={() => setStep("harness")}
        />
      </main>
    );
  }

  return (
    <main>
      {/* A failure outranks `running`. The supervisor gives up on a process and sends the window
          back here, and a heading that still says everything is running while the box underneath
          names the process that stopped is a screen arguing with itself. */}
      <h1>{running && !failure ? "OpenBot is running" : "Set up OpenBot"}</h1>
      <p className="lede">
        {running && !failure
          ? "The stack is up. OpenBot is in this window; the menu bar has it too, and stops it."
          : engine?.responding
            ? `Using ${engine.engine === "docker" ? "Docker" : "Podman"}. It is answering, so nothing needs installing.`
            : /* Two states, and only one of them is somebody's to act on.

                 An engine that is there but not running is theirs: the backend says "podman is
                 installed but not answering", and that is the sentence to show. Repeating a fixed
                 one here threw that away and told somebody with Podman 6.1.1 on their PATH to go
                 and install Podman, which was the one thing they had already done.

                 No engine at all is ours. Start installs one, so this says so rather than sending
                 somebody to a download page they were never going to read. */
              engine?.engine
              ? engine.detail
              : "OpenBot needs one more piece of software to run, and installs it for you. Press Start."}
      </p>

      {!running && (
        <>
          {/*
            Sign in on the main path; paste behind the disclosure.

            This screen used to ask for a key whose only source was two terminal commands, which is
            the one thing the audience rule forbids. Somebody on managed CopilotKit now signs in and
            OpenBot creates the key for the project they pick. Somebody running their own
            Intelligence has a key this sign-in knows nothing about, so the field moves down there
            with the addresses it belongs with.
          */}
          {apiKey ? (
            <p className="lede">Connected to CopilotKit.</p>
          ) : alreadyHeld.saved?.intelligenceApiKey ? (
            <p className="lede">Connected to CopilotKit.</p>
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
                    className="tile"
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
                    That account has no projects yet. Make one at copilotkit.ai,
                    then sign in again.
                  </p>
                  <button
                    type="button"
                    className="quiet"
                    disabled={signingIn}
                    onClick={signInToCopilotKit}
                  >
                    {signingIn ? "Waiting for your browser…" : "Sign in again"}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <p className="lede">
                OpenBot keeps your conversations in CopilotKit. Sign in and it
                sets the rest up for you.
              </p>
              <button
                type="button"
                disabled={signingIn}
                onClick={signInToCopilotKit}
              >
                {signingIn
                  ? "Waiting for your browser…"
                  : "Sign in to CopilotKit"}
              </button>
            </>
          )}
          <div className="field">
            <label htmlFor="root">Where OpenBot lives</label>
            <input
              id="root"
              value={root}
              onChange={(event) => {
                // Invalidate pending loads before blur starts one for this edit.
                configuredRunRef.current += 1;
                setRoot(event.target.value);
                clearRootScopedSavedState();
              }}
              onBlur={(event) => loadConfiguredRoot(event.target.value)}
              spellCheck={false}
            />
          </div>
          {/*
            This used to be headed "Self-hosted Intelligence" over two fields pre-filled with the
            MANAGED service's addresses, which says the opposite of what it does: somebody opening
            it to check where their data goes read "self-hosted" and saw CopilotKit's own hosts.
            The heading now describes the action, and the note says what the defaults are.
          */}
          <details>
            <summary>Point at your own Intelligence server</summary>
            <p className="footnote" style={{ margin: "0.6rem 0 0.75rem" }}>
              These default to CopilotKit's managed service. Change them only if
              you run Intelligence yourself, and paste that server's key below.
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
        </>
      )}

      {steps.length > 0 && (
        <div className="steps">
          {steps.map((step) => (
            <div className="step" key={step.step}>
              <span className={`mark ${step.ok ? "good" : "bad"}`}>
                {step.ok ? "✓" : "✗"}
              </span>
              <span>{label(step.step)}</span>
              <span className="detail">{step.detail}</span>
            </div>
          ))}
        </div>
      )}

      {failure && <Failure problem={failure} />}

      <div className="row">
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
                  setFailure(asProblem(error)),
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
            onClick={start}
            // The model is answered by its own screen now, so what is checked here is that it was
            // answered at all, not that some field on this screen is non-empty.
            disabled={
              busy ||
              (apiKey.trim() === "" &&
                !alreadyHeld.saved?.intelligenceApiKey) ||
              !modelCanStart() ||
              root.trim() === ""
            }
          >
            {busy ? "Working…" : "Start OpenBot"}
          </button>
        )}
      </div>
    </main>
  );
}

function titleFor(blocker: Blocker): string {
  switch (blocker) {
    case "wsl-absent":
      return "Windows Subsystem for Linux is not installed";
    case "wsl-one":
      return "Windows Subsystem for Linux is at version 1";
    case "virtualization-disabled":
      return "Virtualization is off in this machine's firmware";
    case "not-administrator":
      return "This account cannot install Windows components";
  }
}

function label(step: string): string {
  switch (step) {
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
