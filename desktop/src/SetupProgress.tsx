import { type ReactNode, useEffect, useState } from "react";

/** What the Install step says while it downloads OpenBot's software. */
export const INSTALL_BLURB =
  "This installs OpenBot on this computer: the front end, the back end, the database, your Bots, and the computers they work on. It's a large download the first time, so you might want to grab a coffee or tea.";

/**
 * A download while it runs: Install's images (`pull_metrics::Downloads`), or the back end's update
 * (`intelligence_download::Transferred`), which has no item count.
 */
export type Downloads = {
  /** Downloaded so far. */
  bytes: number;
  /** The whole download, once it is known. Absent until then, and never guessed. */
  size?: number;
  bytesPerSecond?: number;
  /** Items finished, of `total`. */
  done?: number;
  total?: number;
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
  /**
   * The detail sends the person to another app's window: Docker Desktop starting, or the system's
   * password prompt. That window is in front of this one. See `handOffNow`.
   */
  elsewhere?: boolean;
};

/**
 * What another app's window wants from the person right now, if anything: the detail of a running
 * step that sent them there.
 *
 * Opening Docker Desktop, or Podman's installer asking for a password, puts that app's window in
 * front of OpenBot's. Its row alone is not enough: the person waits on whichever screen they are
 * on, often the account step, and a row they cannot see says nothing. So the setup screens say
 * this line until the step ends, and OpenBot comes back to the front.
 */
export function handOffNow(steps: Progress[]): string | null {
  const handedOff = [...steps]
    .reverse()
    .find((step) => step.running && step.elsewhere && step.detail);
  return handedOff?.detail ?? null;
}

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
 * Keep actionable directions for the current step. Image pulls show their download instead.
 * "Preparing this computer" says, for instance, "Docker Desktop is starting in its own window."
 * Docker is named on purpose. Its agreement and helper prompt appear in windows of their own, and
 * a row that only said "Preparing" sat for minutes while one of them waited, unseen, behind this
 * one.
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
    // The initial check has a useful status sentence. Once transfers report their download
    // (or only bytes), the install row no longer needs their technical detail.
    const pulling =
      restNow?.downloads != null ||
      (restNow?.step === "images" && restNow.downloadBytes != null);
    rows.push({
      step: "Installing OpenBot",
      ok: !installingFailed,
      running: installingNow,
      detail: pulling ? "" : (restNow?.detail ?? ""),
      downloadBytes: pulling ? undefined : restNow?.downloadBytes,
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
      {downloads && showsDownload(downloads) && (
        <DownloadProgress downloads={downloads} />
      )}
    </li>
  );
}

/**
 * Install shows its download from the start, items and all. The back end's update shows one only
 * once it has something to say: an update with nothing to download is not a download.
 */
function showsDownload({ bytes, size, total }: Downloads): boolean {
  return (total ?? 0) > 0 || bytes > 0 || (size ?? 0) > 0;
}

/**
 * The bytes downloaded out of the whole download, with a bar driven by the bytes. Until the size
 * is known the line says so and the bar is indeterminate: it claims no fraction it cannot know.
 */
function DownloadProgress({ downloads }: { downloads: Downloads }) {
  const summary = downloadSummary(downloads);
  const known = downloads.size != null && downloads.size > 0;
  return (
    <div className="downloads">
      {known ? (
        <progress
          aria-label="Download progress"
          aria-valuetext={summary}
          value={Math.min(downloads.bytes, downloads.size ?? 0)}
          max={downloads.size}
        />
      ) : (
        <progress aria-label="Download progress" aria-valuetext={summary} />
      )}
      <span aria-hidden="true">{summary}</span>
    </div>
  );
}

/** "1.2 GB of 3.4 GB · 1 of 5 items remaining", or what is known of it. */
export function downloadSummary({
  bytes,
  size,
  done,
  total,
}: Downloads): string {
  const parts: string[] = [];
  if (size != null) {
    if (size > 0)
      parts.push(
        `${formatDownloadBytes(bytes)} of ${formatDownloadBytes(size)}`,
      );
  } else if (bytes > 0) {
    parts.push(
      `${formatDownloadBytes(bytes)} downloaded, total size not known yet`,
    );
  } else {
    parts.push("Total size not known yet");
  }
  if (total != null && total > 0) {
    const remaining = total - (done ?? 0);
    parts.push(
      `${remaining} of ${total} ${total === 1 ? "item" : "items"} remaining`,
    );
  }
  return parts.join(" · ");
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
      return "Stopping the back end";
    default:
      return step;
  }
}
