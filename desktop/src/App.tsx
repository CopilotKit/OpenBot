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
  const [apiUrl, setApiUrl] = useState("https://api.intelligence.copilotkit.ai");
  const [wsUrl, setWsUrl] = useState("wss://realtime.intelligence.copilotkit.ai");
  const [steps, setSteps] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    invoke<EngineStatus>("detect_engine").then(setEngine).catch(() => undefined);
    invoke<string>("default_root").then(setRoot).catch(() => undefined);
    invoke<Blocker | null>("windows_blocker")
      .then(async (found) => {
        setBlocker(found);
        if (found) {
          setInstruction(await invoke<string>("windows_blocker_instruction", { blocker: found }));
        }
      })
      .catch(() => undefined);
    const stop = listen<Progress>("setup:progress", (event) => {
      setSteps((current) => [...current, event.payload]);
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
      });
      setRunning(true);
    } catch (error) {
      setFailure(String(error));
    } finally {
      setBusy(false);
      invoke<EngineStatus>("detect_engine").then(setEngine).catch(() => undefined);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await invoke("stop_stack");
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
      <h1>{running ? "OpenBot is running" : "Set up OpenBot"}</h1>
      <p className="lede">
        {running
          ? "The stack is up. Open the app, or stop it from here or the menu bar."
          : engine?.responding
            ? `Using ${engine.engine === "docker" ? "Docker" : "Podman"}. It is answering, so nothing needs installing.`
            : "No container engine is answering yet. OpenBot will install Podman and create its machine."}
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
            <label htmlFor="root">Where OpenBot lives</label>
            <input id="root" value={root} onChange={(event) => setRoot(event.target.value)} spellCheck={false} />
          </div>
          <details>
            <summary>Self-hosted Intelligence</summary>
            <div className="field" style={{ marginTop: "0.75rem" }}>
              <label htmlFor="api">API URL</label>
              <input id="api" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="ws">Gateway WebSocket URL</label>
              <input id="ws" value={wsUrl} onChange={(event) => setWsUrl(event.target.value)} spellCheck={false} />
            </div>
          </details>
        </>
      )}

      {steps.length > 0 && (
        <div className="steps">
          {steps.map((step, index) => (
            <div className="step" key={`${step.step}-${index}`}>
              <span className={`mark ${step.ok ? "good" : "bad"}`}>{step.ok ? "✓" : "✗"}</span>
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
          <button className="secondary" onClick={stop} disabled={busy}>
            Stop OpenBot
          </button>
        ) : (
          <button onClick={start} disabled={busy || apiKey.trim() === "" || root.trim() === ""}>
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
    case "services":
      return "Containers";
    case "migrate":
      return "Database";
    default:
      return step;
  }
}
