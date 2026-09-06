import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  const [modelKey, setModelKey] = useState("");
  const [apiUrl, setApiUrl] = useState(
    "https://api.intelligence.copilotkit.ai",
  );
  const [wsUrl, setWsUrl] = useState(
    "wss://realtime.intelligence.copilotkit.ai",
  );
  const [steps, setSteps] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    invoke<EngineStatus>("detect_engine")
      .then(setEngine)
      .catch(() => undefined);
    invoke<string>("default_root")
      .then(async (found) => {
        setRoot(found);
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
    invoke<string | null>("last_failure")
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
  }, []);

  async function start() {
    setBusy(true);
    setFailure("");
    setSteps([]);
    try {
      await invoke("prepare_engine");
      await invoke("start_stack", {
        root,
        apiUrl,
        gatewayWsUrl: wsUrl,
        apiKey,
        openaiApiKey: modelKey,
      });
      setRunning(true);
      // The window becomes OpenBot. Nobody double-clicked this to look at a status screen.
      //
      // Said out loud when it does not happen. Swallowed, the window sits on the setup screen
      // looking like the start failed, while every step on it is ticked.
      await invoke("show_openbot").catch((error) => setFailure(String(error)));
    } catch (error) {
      setFailure(String(error));
    } finally {
      setBusy(false);
      invoke<EngineStatus>("detect_engine")
        .then(setEngine)
        .catch(() => undefined);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await invoke("stop_stack", { root });
      setRunning(false);
    } catch (error) {
      setFailure(String(error));
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
            : /* The backend already worked out which of these it is, and says so: "podman is
                 installed but not answering" when the binary is there, "no container engine
                 found" when it is not. Repeating a fixed sentence here threw that away and told
                 somebody with Podman 6.1.1 on their PATH to go and install Podman, which is the
                 one thing they had already done. Its sentence, not ours.

                 Not "OpenBot will install Podman" either: nothing here installs an engine. The
                 step exists in the enum and no function fills it. It creates the machine, which
                 is the part that is built. */
              (engine?.detail ??
              "No container engine is answering yet. Install Podman Desktop or Docker Desktop, then start OpenBot again.")}
      </p>

      {!running && (
        <>
          <div className="field">
            <label htmlFor="key">Intelligence project key</label>
            <input
              id="key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="the key from your Intelligence project"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label htmlFor="model">Model key</label>
            <input
              id="model"
              type="password"
              value={modelKey}
              onChange={(event) => setModelKey(event.target.value)}
              placeholder="an OpenAI key, so the Bots can answer"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label htmlFor="root">Where OpenBot lives</label>
            <input
              id="root"
              value={root}
              onChange={(event) => setRoot(event.target.value)}
              spellCheck={false}
            />
          </div>
          <details>
            <summary>Self-hosted Intelligence</summary>
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

      {failure && (
        <div className="blocker" role="alert">
          <h2>That did not finish</h2>
          <p>{failure}</p>
        </div>
      )}

      <div className="row">
        {running ? (
          <>
            <button
              type="button"
              onClick={() => invoke("show_openbot").catch(() => undefined)}
            >
              Show OpenBot
            </button>
            <button
              type="button"
              className="secondary"
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
            disabled={
              busy ||
              apiKey.trim() === "" ||
              modelKey.trim() === "" ||
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
