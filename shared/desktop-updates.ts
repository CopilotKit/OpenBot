/**
 * What OpenBot Desktop says on a build that never updates itself (an internal or candidate build,
 * or one without the updater). The setup window's Updates section and Settings › This computer both
 * say it up front, with nothing to check, and from these words alone, so the two can't drift.
 */
export const DOESNT_UPDATE_ITSELF =
  "This version of OpenBot doesn't update itself. Install a released version of OpenBot to get updates.";

/**
 * How ready a newer OpenBot Desktop is to install, as the desktop app says
 * (desktop/src-tauri/src/app_update.rs, `Readiness`): its downloads arriving in the background
 * while this version keeps running, or all of them here.
 */
export type UpdateReadiness =
  | { state: "preparing"; done: number; total: number }
  | { state: "ready" };

/**
 * What OpenBot Desktop says of a newer version, with how ready it is. The banner in OpenBot's page,
 * Settings › This computer and the setup window all say it in these words. While it downloads the
 * share shown stops at 99%, so 100% is only ever said as "ready to install".
 *
 * Short enough for the banner's one line beside Update and restart at the default window width,
 * for a release's version, so the page under the banner never moves as the state changes
 * (app/tests/update-banner-layout.test.tsx).
 */
export function updateOffered(
  version: string,
  ready?: UpdateReadiness | null,
): string {
  if (ready?.state === "ready") {
    return `OpenBot ${version} is ready to install. It takes a few minutes.`;
  }
  if (ready?.state === "preparing") {
    const share =
      ready.total > 0
        ? Math.min(99, Math.floor((ready.done / ready.total) * 100))
        : 0;
    return `OpenBot ${version} is downloading in the background (${share}%).`;
  }
  return `OpenBot ${version} is available.`;
}

/**
 * How the last update went, as OpenBot Desktop records it
 * (desktop/src-tauri/src/update_outcome.rs): the version it moved to, and for the release and the
 * backend whether each finished, failed or had nothing to do. `failedStep` names the step that
 * stopped, when it is known.
 */
export type UpdateOutcome = {
  version: string;
  release: "ok" | "failed" | "notDue";
  backEnd: "ok" | "failed" | "notDue";
  failedStep: string | null;
};

/** The states of the update panel in OpenBot's page. */
export type PanelState =
  | "available"
  | "downloading"
  | "ready"
  | "restarting"
  | "updated"
  | "failed";

/** The title of each panel state. A finished or failed update has none: its outcome names it. */
export const PANEL_TITLES: Record<PanelState, string> = {
  available: "Update available",
  downloading: "Downloading update",
  ready: "Update ready",
  restarting: "Restarting",
  updated: "",
  failed: "",
};

/** Under the panel's line when an update is available: what the update leaves alone. */
export const UPDATE_KEEPS_DATA = "Your Bots and data stay as they are.";

/** Under the panel's line while an update downloads: this version keeps running. */
export const UPDATE_KEEP_WORKING = "You can keep working.";

/** Under the panel's line when an update is ready: what the install does. It says no duration. */
export const UPDATE_RESTARTS = "OpenBot restarts to finish the update.";

/**
 * Which state the update panel is in, or null when it has nothing to say. An install in progress
 * comes first, then the last update's outcome, then a newer version (offered or minimized) by how
 * ready it is.
 */
export function panelState(update: {
  version: string | null;
  minimized?: string | null;
  installing: {
    downloaded: number;
    total: number | null;
    restarting: boolean;
  } | null;
  ready?: UpdateReadiness | null;
  outcome?: UpdateOutcome | null;
}): PanelState | null {
  if (update.installing) return "restarting";
  if (update.outcome) {
    return update.outcome.release === "failed" ||
      update.outcome.backEnd === "failed"
      ? "failed"
      : "updated";
  }
  if (update.version ?? update.minimized) {
    if (update.ready?.state === "ready") return "ready";
    if (update.ready?.state === "preparing") return "downloading";
    return "available";
  }
  return null;
}

/** "Downloading… 25%", then "Restarting…" once it is installed. */
export function installProgressSaid(
  progress: {
    downloaded: number;
    total: number | null;
    restarting: boolean;
  } | null,
): string {
  if (progress?.restarting) return "Restarting…";
  if (!progress?.total) return "Downloading…";
  return `Downloading… ${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%`;
}

/**
 * The title and the line under it for the last update's outcome. A finished update has a title
 * only. A failed one names the version it could not finish and says the data is kept.
 */
export function outcomeSaid(outcome: UpdateOutcome): {
  title: string;
  body: string;
} {
  if (outcome.release === "failed" || outcome.backEnd === "failed") {
    return {
      title: "Couldn't finish updating",
      body: `OpenBot couldn't finish updating to ${outcome.version}. Your data is kept. OpenBot tries again the next time it starts.`,
    };
  }
  return { title: `Updated to OpenBot ${outcome.version}`, body: "" };
}

/** The heading of the setup window's update screen, with the version when it is known. */
export function updatingTitle(to: string | null): string {
  return to ? `Updating OpenBot to ${to}` : "Updating OpenBot";
}

/** The line under the update screen's heading. */
export const UPDATING_LEDE =
  "OpenBot opens by itself when it's done. Your Bots, sign-ins and data stay as they are.";
