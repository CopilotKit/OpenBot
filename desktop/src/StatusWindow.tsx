import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type LocalReadiness, runLocalEval } from "./localEvalCli";
import { type PartGroup, partLabel } from "./partNames";
import { TroubleshootingLogs } from "./Problem";
import { StatusLine } from "./SetupProgress";

/** The Status window is the setup page at this hash, in a window of its own. */
export const STATUS_HASH = "#status";

export function isStatusPage(hash: string): boolean {
  return hash === STATUS_HASH;
}

type Part = { name: string; memoryBytes: number | null };

/** `DesktopStatus` from the native side. */
export type DesktopStatus = {
  openbotRunning: boolean;
  openbotHeld: boolean;
  processes: Part[];
  containers: Part[];
  intelligenceStack: string | null;
  intelligenceContainers: Part[];
  engine: "docker" | "podman" | null;
  root: string;
  appPort: number | null;
  version: string;
  build: string;
  /** Where this app writes its log file. */
  logFolder?: string | null;
};

/** "1.2 GB", "340 MB": decimal, as macOS reports memory and disk. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** What a list of parts uses together, or null when none of them could be measured. */
export function totalMemory(parts: Part[]): number | null {
  const measured = parts.filter((part) => part.memoryBytes !== null);
  if (measured.length === 0) return null;
  return measured.reduce((sum, part) => sum + (part.memoryBytes ?? 0), 0);
}

const READINESS_SAID: Record<LocalReadiness, string> = {
  ready: "Ready",
  starting: "Starting",
  stopped: "Stopped",
  degraded: "Not fully working",
  unknown: "Running",
};

/**
 * Everything a support person needs, and nothing secret: no keys, tokens or addresses with them.
 *
 * This is where the technical names live: the engine, the back end's stack id, the build and
 * Docker's own container names. The window itself says each in plain words.
 */
export function diagnostics(
  status: DesktopStatus,
  readiness: LocalReadiness | null,
): string {
  const parts = (list: Part[]) =>
    list.length === 0
      ? "none"
      : list
          .map(
            (part) =>
              `${part.name} ${part.memoryBytes === null ? "?" : formatBytes(part.memoryBytes)}`,
          )
          .join(", ");
  return [
    `OpenBot Desktop ${status.version} (${status.build})`,
    `Installed in ${status.root}${status.appPort ? `, app on port ${status.appPort}` : ""}`,
    `Container engine: ${status.engine ?? "not answering"}`,
    `OpenBot: ${status.openbotRunning ? "running" : "stopped"}`,
    `  processes: ${parts(status.processes)}`,
    `  containers: ${parts(status.containers)}`,
    status.intelligenceStack
      ? `Backend: ${status.intelligenceStack}, ${readiness ?? "not checked"}`
      : "Backend: not on this computer",
    ...(status.intelligenceStack
      ? [`  containers: ${parts(status.intelligenceContainers)}`]
      : []),
  ].join("\n");
}

/** What OpenBot runs on, Docker or Podman, in the words setup uses for it. */
const ENGINE = "Software OpenBot runs on";

type Busy =
  | "openbot-restart"
  | "openbot-stop"
  | "intelligence-restart"
  | "intelligence-stop"
  | "intelligence-start";

/**
 * The local Intelligence is "OpenBot's services" on this window, as on the Shutting down screen
 * ("Stopping OpenBot's services"). Its parts say what they do (`partNames.ts`).
 */
const SERVICES = "OpenBot's services";

const BUSY_SAID: Record<Busy, string> = {
  "openbot-restart": "Restarting OpenBot…",
  "openbot-stop": "Stopping OpenBot…",
  "intelligence-restart": `Restarting ${SERVICES}…`,
  "intelligence-stop": `Stopping ${SERVICES}…`,
  "intelligence-start": `Starting ${SERVICES}…`,
};

/**
 * What OpenBot is running, what each part costs, and Restart and Stop for each.
 *
 * Memory is read every few seconds while the window shows; it is Docker's figure per container,
 * OpenBot's own server and worker among them. Intelligence's readiness is the CLI's, asked only on
 * opening, on Refresh and after an action here: the main window's own Intelligence calls take the
 * same lock, and a status window polling it would make them fail as busy.
 */
export function StatusWindow({ readEveryMs = 5000 }: { readEveryMs?: number }) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [readiness, setReadiness] = useState<LocalReadiness | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stack = useRef<string | null>(null);

  const read = useCallback(async () => {
    try {
      const found = await invoke<DesktopStatus>("desktop_status");
      stack.current = found.intelligenceStack;
      setStatus(found);
      return found;
    } catch {
      setSaid("OpenBot could not read its status. Try Refresh.");
      return null;
    }
  }, []);

  const checkIntelligence = useCallback(async () => {
    const id = stack.current;
    if (!id) {
      setReadiness(null);
      return;
    }
    try {
      setReadiness((await runLocalEval("status", id).report).readiness);
    } catch {
      setReadiness(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    setSaid(null);
    await read();
    await checkIntelligence();
  }, [read, checkIntelligence]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, readEveryMs);
    // Closing the window hides it; showing it again reads everything afresh.
    const shown = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [read, refresh, readEveryMs]);

  async function act(what: Busy, run: () => Promise<unknown>) {
    setBusy(what);
    setSaid(null);
    try {
      await run();
    } catch {
      setSaid(`${BUSY_SAID[what].replace("…", "")} did not finish. Try again.`);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  const intelligence = async (action: "start" | "stop") => {
    const id = stack.current;
    if (!id) return;
    const report = await runLocalEval(action, id).report;
    if (report.outcome !== "completed") throw new Error(report.outcome);
  };

  const openbotMemory = status
    ? totalMemory([...status.processes, ...status.containers])
    : null;
  const intelligenceMemory = status
    ? totalMemory(status.intelligenceContainers)
    : null;
  const intelligenceRunning =
    (status?.intelligenceContainers.length ?? 0) > 0 && readiness !== "stopped";

  return (
    <main>
      <div className="sheet status-sheet">
        <h1>Status</h1>
        <p className="lede">
          See what OpenBot is running on this computer and how much memory it
          uses.
        </p>

        {!status ? (
          <StatusLine>Reading OpenBot's status…</StatusLine>
        ) : (
          <>
            <section className="status-part" aria-label="App">
              <div className="status-head">
                <h2>App</h2>
                <span className="status-state">
                  {status.openbotRunning ? "Running" : "Stopped"}
                  {openbotMemory !== null &&
                    status.openbotRunning &&
                    ` · ${formatBytes(openbotMemory)}`}
                </span>
              </div>
              <PartList
                group="bots"
                parts={[...status.processes, ...status.containers]}
              />
              {status.openbotRunning && (
                <div className="row">
                  {/* Restart is Compose restarting the server and worker containers this session started. */}
                  {status.openbotHeld && (
                    <button
                      type="button"
                      className="quiet"
                      disabled={busy !== null}
                      onClick={() =>
                        act("openbot-restart", async () => {
                          await invoke("restart_openbot");
                          // The supervisor brings each process back after a short backoff.
                          await new Promise((resolve) =>
                            setTimeout(resolve, 3000),
                          );
                        })
                      }
                    >
                      Restart
                    </button>
                  )}
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy !== null}
                    onClick={() =>
                      act("openbot-stop", () =>
                        invoke("stop_openbot_from_status"),
                      )
                    }
                  >
                    Stop
                  </button>
                </div>
              )}
            </section>

            {status.intelligenceStack && (
              <section className="status-part" aria-label={SERVICES}>
                <div className="status-head">
                  <h2>{SERVICES}</h2>
                  <span className="status-state">
                    {intelligenceRunning
                      ? READINESS_SAID[readiness ?? "unknown"]
                      : "Stopped"}
                    {intelligenceRunning &&
                      intelligenceMemory !== null &&
                      ` · ${formatBytes(intelligenceMemory)}`}
                  </span>
                </div>
                <PartList
                  group="back-end"
                  parts={status.intelligenceContainers}
                />
                <div className="row">
                  {intelligenceRunning ? (
                    <>
                      <button
                        type="button"
                        className="quiet"
                        disabled={busy !== null}
                        onClick={() =>
                          act("intelligence-restart", async () => {
                            await intelligence("stop");
                            await intelligence("start");
                          })
                        }
                      >
                        Restart
                      </button>
                      <button
                        type="button"
                        className="quiet"
                        disabled={busy !== null}
                        onClick={() =>
                          act("intelligence-stop", () => intelligence("stop"))
                        }
                      >
                        Stop
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="quiet"
                      disabled={busy !== null}
                      onClick={() =>
                        act("intelligence-start", () => intelligence("start"))
                      }
                    >
                      Start
                    </button>
                  )}
                </div>
                {status.openbotRunning && (
                  <p className="footnote">
                    OpenBot needs these services while it runs. Stopping them
                    frees memory until you start them again here.
                  </p>
                )}
              </section>
            )}

            {/* Docker or Podman, said as setup says it. Which one is in Copy diagnostics. */}
            <section className="status-part" aria-label={ENGINE}>
              <div className="status-head">
                <h2>{ENGINE}</h2>
                <span className="status-state">
                  {status.engine ? "Running" : "Not running"}
                </span>
              </div>
              {!status.engine && (
                <p className="footnote">
                  OpenBot needs this to run. If you use Docker Desktop, open it
                  and wait for it to start.
                </p>
              )}
            </section>

            {busy && <StatusLine>{BUSY_SAID[busy]}</StatusLine>}
            {said && <p className="footnote">{said}</p>}

            <dl className="status-details">
              <dt>Installed in</dt>
              <dd>{status.root}</dd>
              {/* The build it was made from is for support, in Copy diagnostics. */}
              <dt>Version</dt>
              <dd>{status.version}</dd>
              {status.logFolder && (
                <>
                  <dt>Logs</dt>
                  <dd>{status.logFolder}</dd>
                </>
              )}
            </dl>

            <div className="row">
              <button
                type="button"
                className="quiet"
                disabled={busy !== null}
                onClick={() => void refresh()}
              >
                Refresh
              </button>
              <button
                type="button"
                className="quiet"
                onClick={async () => {
                  await navigator.clipboard.writeText(
                    diagnostics(status, readiness),
                  );
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? "Copied" : "Copy diagnostics"}
              </button>
              {/* The log stays on this computer; this is how a person finds it to share it. */}
              {status.logFolder && (
                <button
                  type="button"
                  className="quiet"
                  onClick={async () => {
                    setSaid(null);
                    try {
                      await invoke("open_log_folder");
                    } catch {
                      setSaid(
                        "Couldn't open the log folder. Find it under Logs below.",
                      );
                    }
                  }}
                >
                  Open log folder
                </button>
              )}
            </div>
            <TroubleshootingLogs />
          </>
        )}
      </div>
    </main>
  );
}

/** Each container or process and its memory, small, under its part's heading, by what it is for. */
function PartList({ parts, group }: { parts: Part[]; group: PartGroup }) {
  if (parts.length === 0) return null;
  return (
    <ul className="status-list">
      {parts.map((part) => (
        <li key={part.name}>
          <span>{partLabel(part.name, group)}</span>
          <span>
            {part.memoryBytes === null
              ? "Not measured"
              : formatBytes(part.memoryBytes)}
          </span>
        </li>
      ))}
    </ul>
  );
}
