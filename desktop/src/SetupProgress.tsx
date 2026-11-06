import { type ReactNode, useEffect, useState } from "react";

/** What the Install step says while it downloads OpenBot's software. */
export const INSTALL_BLURB =
  "This installs the full OpenBot platform on this computer: the server, your Bots and the computers they work on, and Intelligence. It's a large download the first time, so it can take a while.";

/** One image downloading now. `size` is there once the image has said how big it is. */
export type ImagePull = { name: string; bytes: number; size?: number };

/** Install's image downloads, as the native side reports them: see `pull_metrics::Downloads`. */
export type Downloads = {
  /** Images finished, of `total`. */
  done: number;
  total: number;
  /** Downloaded so far, over every image. */
  bytes: number;
  bytesPerSecond?: number;
  pulling: ImagePull[];
};

/** One setup step, as the native side reports it or the window runs it. */
export type Progress = {
  step: string;
  ok: boolean;
  detail: string;
  running?: boolean;
  downloadBytes?: number;
  downloads?: Downloads;
  /** When a running row began, if earlier than the row appeared on this screen. */
  startedAt?: number;
};

export function SetupProgress({
  steps,
  label = "Setup progress",
  showElapsed = true,
}: {
  steps: Progress[];
  label?: string;
  showElapsed?: boolean;
}) {
  if (steps.length === 0) return null;
  return (
    <ol className="steps" aria-label={label} aria-live="polite">
      {steps.map((step) => (
        <SetupProgressRow
          key={step.step}
          step={step}
          showElapsed={showElapsed}
        />
      ))}
    </ol>
  );
}

/**
 * One sentence about something that is happening now, with the rows' spinner while `working`.
 *
 * For any action that takes longer than a moment: said on the click, before the call it waits for
 * has answered, so pressing a button never looks like nothing happened.
 */
export function StatusLine({
  working = true,
  children,
}: {
  working?: boolean;
  children: ReactNode;
}) {
  return (
    <p className="status-line" role="status">
      {working && <span className="step-spinner" aria-hidden="true" />}
      <span>{children}</span>
    </p>
  );
}

/** Whole seconds since `since`, or since `running` turned on, while it is on. */
export function useElapsed(running: boolean, since?: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const started = since ?? Date.now();
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, since]);
  return elapsed;
}

export function formatElapsed(elapsed: number): string {
  return elapsed < 60
    ? `${elapsed}s`
    : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

// The native steps that make this computer ready to run anything, before OpenBot's own software.
const PREPARING = new Set([
  "engine",
  "install-engine",
  "create-machine",
  "start-machine",
  "health-gate",
]);

/**
 * An installation's native rows as two plain ones, for local mode: "Preparing this computer" and
 * "Installing OpenBot". A failure is shown in full under the rows.
 *
 * Keep actionable directions for the current step. Image pulls only need an item count.
 * "Preparing this computer" says, for instance, "Starting Docker Desktop.
 * Accept anything it asks in its own window." Docker is named on purpose. Its agreement and
 * helper prompt appear in windows of their own, and a row that only said "Preparing" sat for
 * minutes while one of them waited, unseen, behind this one.
 */
export function plainInstallSteps(
  steps: Progress[],
  installing: boolean,
): Progress[] {
  const preparing = steps.filter((step) => PREPARING.has(step.step));
  const rest = steps.filter((step) => !PREPARING.has(step.step));
  const preparingFailed = preparing.some((step) => !step.ok);
  const stillPreparing =
    installing && preparing.some((step) => step.running) && !preparingFailed;
  const preparingNow = stillPreparing
    ? [...preparing].reverse().find((step) => step.running)
    : undefined;
  const installingFailed = rest.some((step) => !step.ok);
  const rows: Progress[] = [];
  if (preparing.length > 0) {
    rows.push({
      step: "Preparing this computer",
      ok: !preparingFailed,
      running: stillPreparing,
      detail: preparingNow?.detail ?? "",
      downloadBytes: preparingNow?.downloadBytes,
      downloads: preparingNow?.downloads,
    });
  }
  if (rest.length > 0 || (installing && !stillPreparing && !preparingFailed)) {
    const installingNow = installing && !stillPreparing && !installingFailed;
    const restNow = installingNow
      ? [...rest].reverse().find((step) => step.running)
      : undefined;
    rows.push({
      step: "Installing OpenBot",
      ok: !installingFailed,
      running: installingNow,
      detail: restNow?.step === "images" ? "" : (restNow?.detail ?? ""),
      downloadBytes:
        restNow?.step === "images" ? undefined : restNow?.downloadBytes,
      downloads: restNow?.downloads,
    });
  }
  return rows;
}

function SetupProgressRow({
  step,
  showElapsed,
}: {
  step: Progress;
  showElapsed: boolean;
}) {
  const running = step.running ?? false;
  const elapsed = useElapsed(running && showElapsed, step.startedAt);
  const downloads = running ? step.downloads : undefined;
  return (
    <li className="step" aria-label={label(step.step)}>
      <span
        className={`mark ${running ? "active" : step.ok ? "good" : "bad"}`}
        aria-hidden="true"
      >
        {running ? <span className="step-spinner" /> : step.ok ? "✓" : "✗"}
      </span>
      <span className="step-label">{label(step.step)}</span>
      <span
        className={`step-status${running ? "" : step.ok ? " good" : " bad"}`}
      >
        {running ? "In progress" : step.ok ? "Complete" : "Failed"}
        {running && showElapsed && (
          <span className="step-elapsed" aria-hidden="true" aria-live="off">
            {" · "}
            {formatElapsed(elapsed)} elapsed
          </span>
        )}
      </span>
      <span className="detail">
        {step.detail}
        {step.downloadBytes != null &&
          downloads == null &&
          ` ${formatDownloadBytes(step.downloadBytes)} downloaded.`}
      </span>
      {downloads && downloads.total > 0 && (
        <ItemProgress downloads={downloads} />
      )}
    </li>
  );
}

function ItemProgress({
  downloads: { done, total },
}: {
  downloads: Downloads;
}) {
  const remaining = total - done;
  const summary = `${remaining} of ${total} ${total === 1 ? "item" : "items"} remaining`;
  return (
    <div className="downloads">
      <progress
        aria-label="Item download progress"
        aria-valuetext={summary}
        value={done}
        max={total}
      />
      <span>{summary}</span>
    </div>
  );
}

export function formatDownloadBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log10(bytes) / 3), units.length);
  return `${(bytes / 1000 ** power).toFixed(1)} ${units[power - 1]}`;
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
    case "release":
      return "OpenBot update";
    case "update-images":
      return "Update software";
    case "env":
      return "Settings";
    case "ports":
      return "Ports";
    case "dependencies":
      return "Dependencies";
    case "recorder":
      return "Recorder";
    case "browser":
      return "Your browser";
    case "images":
      return "Local software";
    case "installation":
      return "Installation";
    case "answering":
      return "Starting OpenBot";
    case "services":
      return "Containers";
    case "migrate":
      return "Database";
    case "stop-openbot":
      return "Stopping OpenBot";
    case "stop-intelligence":
      return "Stopping Intelligence";
    default:
      return step;
  }
}
