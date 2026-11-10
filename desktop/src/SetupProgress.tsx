import { type ReactNode, useEffect, useState } from "react";

/** What the Install step says while it downloads OpenBot's software. */
export const INSTALL_BLURB =
  "This installs OpenBot on this computer: the app, its database, your Bots, and the computers they work on. The first install takes about 10 minutes, so you might want to grab a coffee or tea.";

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
  /**
   * The step waits for the person's go-ahead in this window before it raises the system's password
   * prompt (`install::GoAhead`). See `goAheadNow`.
   */
  asks?: boolean;
  /**
   * Where this step is among the parts of what it belongs to, said while it runs: "Step 2 of 4".
   * A row list shows the parts done and the one running; this says how many are left.
   */
  position?: { at: number; of: number };
  /** The step waits on the person, not on work: no spinner, and its status says so. */
  waiting?: boolean;
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

/**
 * What the engine is doing while the back end waits on it: the hand-off to another app's window
 * when there is one, else the step that is preparing this computer, as setup says it ("Starting
 * the engine machine.").
 *
 * A relaunch with OpenBot's Podman machine stopped spent ten seconds starting it under "Waiting
 * for the back end", and nothing on the screen said so.
 */
export function engineNow(steps: Progress[]): string | null {
  const handedOff = handOffNow(steps);
  if (handedOff) return handedOff;
  const preparing = [...steps]
    .reverse()
    .find((step) => step.running && PREPARING.has(step.step) && step.detail);
  // Waiting for the person is not work going on: `goAheadNow` says it, with its own button.
  if (preparing?.asks) return null;
  return preparing?.detail ?? null;
}

/**
 * The line of a step that waits for the person's go-ahead before macOS asks for their password
 * ("Podman is downloaded and ready to install."), or null. The screens explain what comes next
 * and offer Continue (`PodmanGoAhead`).
 */
export function goAheadNow(steps: Progress[]): string | null {
  const asking = [...steps]
    .reverse()
    .find((step) => step.running && step.asks && step.detail);
  return asking?.detail ?? null;
}

/** Where OpenBot's own icon is, as this computer names it: macOS has a menu bar, Windows a tray. */
export function trayPlace(userAgent = navigator.userAgent): string {
  return /Macintosh|Mac OS X/.test(userAgent)
    ? "the menu bar"
    : "the system tray";
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
      position: { at: 1, of: INSTALL_PARTS },
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
      detail: pulling
        ? (timeLeft(restNow?.downloads) ?? "")
        : (restNow?.detail ?? ""),
      downloadBytes: pulling ? undefined : restNow?.downloadBytes,
      downloads: restNow?.downloads,
      position: { at: 2, of: INSTALL_PARTS },
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
  const waiting = step.waiting ?? false;
  const running = !waiting && (step.running ?? false);
  const elapsed = useElapsed(running && showElapsed, step.startedAt);
  const downloads = running ? step.downloads : undefined;
  const at =
    step.position && (running || waiting)
      ? `Step ${step.position.at} of ${step.position.of}`
      : null;
  const status = waiting
    ? at
      ? `${at} · Waiting for you`
      : "Waiting for you"
    : running
      ? (at ?? "In progress")
      : step.ok
        ? "Complete"
        : "Failed";
  return (
    <li className="step" aria-label={label(step.step)}>
      <span
        className={`mark ${waiting ? "waiting" : running ? "active" : step.ok ? "good" : "bad"}`}
        aria-hidden="true"
      >
        {waiting ? (
          <span className="step-waiting" />
        ) : running ? (
          <span className="step-spinner" />
        ) : step.ok ? (
          "✓"
        ) : (
          "✗"
        )}
      </span>
      <span className="step-label">{label(step.step)}</span>
      <span
        className={`step-status${running || waiting ? "" : step.ok ? " good" : " bad"}`}
      >
        {status}
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
 *
 * Once every byte is in and items are still being unpacked, the bar is indeterminate again. A full
 * bar beside "1 of 5 parts left" read as nothing left to do while the last image was still
 * being unpacked and tagged.
 */
function DownloadProgress({ downloads }: { downloads: Downloads }) {
  const summary = downloadSummary(downloads);
  const known =
    downloads.size != null && downloads.size > 0 && !unpacking(downloads);
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

/**
 * Every byte is in, and some items are still being unpacked, imported or tagged. That brings no
 * more bytes, so the bytes alone would say the step is done.
 */
function unpacking({ bytes, size, done, total }: Downloads): boolean {
  return (
    size != null &&
    size > 0 &&
    bytes >= size &&
    total != null &&
    (done ?? 0) < total
  );
}

/**
 * "1.2 GB of 3.4 GB · 1 of 5 parts left", or what is known of it. Once every byte is in:
 * "3.4 GB downloaded · Finishing the last part".
 */
export function downloadSummary(downloads: Downloads): string {
  const { bytes, size, done, total } = downloads;
  if (unpacking(downloads)) {
    const remaining = (total ?? 0) - (done ?? 0);
    return `${formatDownloadBytes(bytes)} downloaded · Finishing ${
      remaining === 1 ? "the last part" : `the last ${remaining} parts`
    }`;
  }
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
      `${remaining} of ${total} ${total === 1 ? "part" : "parts"} left`,
    );
  }
  return parts.join(" · ");
}

/**
 * "About 4 minutes left", from the bytes still to come at the speed so far. Null until both the
 * size and the speed are known, and once every byte is in: no estimate it can't stand behind.
 */
export function timeLeft(
  downloads: Downloads | null | undefined,
): string | null {
  if (!downloads) return null;
  const { bytes, size, bytesPerSecond } = downloads;
  if (!size || !bytesPerSecond || bytesPerSecond <= 0 || bytes >= size)
    return null;
  const seconds = (size - bytes) / bytesPerSecond;
  if (seconds < 60) return "Less than a minute left.";
  const minutes = Math.round(seconds / 60);
  return minutes <= 1
    ? "About a minute left."
    : `About ${minutes} minutes left.`;
}

/**
 * The parts of a first install, counted the same on every screen that shows them: preparing this
 * computer, downloading OpenBot, setting it up, and getting it ready to start.
 */
export const INSTALL_PARTS = 4;

/** The background install's row, on the screens that ask the person for something meanwhile. */
export const INSTALLING_BEHIND = "Installing OpenBot in the background";

/** The back end's sequence, as far as the background install's row needs it (`LocalSequence`). */
export type BackEndNow = {
  at: string | null;
  running: boolean;
  stopped: boolean;
  ready: boolean;
  detail: string | null;
  download: Downloads | null;
  since: number | null;
};

/**
 * The one row that says what is installing while the person does something else: signs in, reads
 * the agreement, chooses an AI. In plain words, with how far along it is ("Step 2 of 4"), the time
 * so far, and the time left when a download says how long. Null when nothing is installing and
 * nothing is left to say.
 *
 * A tester sat on the account step while OpenBot installed behind it for minutes, with nothing on
 * the screen about it, and could not tell whether setup was stuck.
 *
 * `installing` and `installed` are OpenBot's own install (`prepare_installation`), whose rows are
 * `steps`; the back end's setup follows it (`backEnd`). `waitingFor` is what the rest waits on when
 * it waits on the person; `done` is what the row says once everything is installed.
 */
export function installingBehind({
  steps,
  installing,
  installed,
  since,
  backEnd,
  waitingFor,
  done,
}: {
  steps: Progress[];
  installing: boolean;
  installed: boolean;
  since?: number | null;
  backEnd: BackEndNow;
  waitingFor?: string;
  done?: string;
}): Progress | null {
  const row = (
    at: number,
    detail: string,
    more: Partial<Progress> = {},
  ): Progress => ({
    step: INSTALLING_BEHIND,
    ok: true,
    running: true,
    detail,
    position: { at, of: INSTALL_PARTS },
    ...more,
  });
  if (installing) {
    const now = [...steps].reverse().find((step) => step.running);
    const preparing = now
      ? PREPARING.has(now.step)
      : !steps.some((step) => !PREPARING.has(step.step));
    if (preparing) {
      return row(1, now?.detail || "Preparing this computer to run OpenBot.", {
        waiting: now?.asks === true,
        startedAt: since ?? undefined,
      });
    }
    const downloads =
      now?.downloads && showsDownload(now.downloads) ? now.downloads : null;
    return row(
      2,
      downloads
        ? withTimeLeft("Downloading OpenBot.", downloads)
        : now?.detail || "Downloading OpenBot.",
      { downloads: downloads ?? undefined, startedAt: since ?? undefined },
    );
  }
  if (backEnd.stopped) return null;
  if (backEnd.running && (backEnd.at === "setup" || backEnd.at === "connect"))
    return row(
      3,
      backEnd.download
        ? withTimeLeft("Downloading the rest of OpenBot.", backEnd.download)
        : backEnd.detail ||
            "Setting up OpenBot on this computer. This takes a few minutes the first time.",
      {
        downloads: backEnd.download ?? undefined,
        startedAt: backEnd.since ?? undefined,
      },
    );
  if (backEnd.running && backEnd.at === "wait")
    return row(
      4,
      backEnd.download
        ? withTimeLeft("Downloading an update.", backEnd.download)
        : backEnd.detail ||
            "Getting OpenBot ready to start. This can take a few minutes.",
      {
        downloads: backEnd.download ?? undefined,
        startedAt: backEnd.since ?? undefined,
      },
    );
  if (!installed) return null;
  if (backEnd.ready && done)
    return { step: "OpenBot is installed", ok: true, detail: done };
  if (backEnd.at === null && !backEnd.running && waitingFor)
    return row(3, waitingFor, { running: false, waiting: true });
  return null;
}

/**
 * Where the background install's row goes: last in the step, under everything the person uses, with
 * its height held whether the row is there or not, and whatever it says.
 *
 * Seen on Windows on the AI step: the back end's download card appeared above the endpoint form
 * while the person typed in it, and went when the download ended. The fields jumped about 100px
 * each time, a click landed on the row below the one aimed at, and the window grew and moved to
 * fit. Last in the step, nothing above it moves; held at its height, the window has nothing to
 * grow for.
 */
export function BehindSlot({ children }: { children?: ReactNode }) {
  return <div className="behind-slot">{children}</div>;
}

function withTimeLeft(said: string, downloads: Downloads): string {
  const left = timeLeft(downloads);
  return left ? `${said} ${left}` : said;
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
      return "Software OpenBot runs on";
    case "create-machine":
      return "Preparing this computer";
    case "start-machine":
      return "Starting the software OpenBot runs on";
    case "health-gate":
      return "Checking the software OpenBot runs on";
    case "deployment":
      return "Downloading OpenBot";
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
      return "OpenBot's services";
    case "migrate":
      return "Database";
    case "finish-update":
      return "Finishing the OpenBot update";
    case "stop-openbot":
      return "Stopping OpenBot";
    case "stop-intelligence":
      return "Stopping OpenBot's services";
    default:
      return step;
  }
}
