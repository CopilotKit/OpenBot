import { setupText } from "./setup-locale";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { leftSaid } from "./journey";
import {
  type Downloads,
  DownloadProgress,
  StatusLine,
  useDownloadWhere,
} from "./SetupProgress";

/**
 * The big downloads that start when the first screen shows, before Install is clicked
 * (`early_downloads.rs`): the engine machine image, Podman and Compose, the deployment and
 * OpenBot's images. One line says where they are, on every setup screen they run behind.
 */
export type EarlyDownloads = {
  state: "idle" | "short" | "downloading" | "done" | "failed" | "nothing";
  /** Downloaded so far, over every download. */
  bytes: number;
  /** Every download together, once each one's size is known. */
  size?: number;
  bytesPerSecond?: number;
  /**
   * When the disk is short: free on this computer's disk, what OpenBot needs free to run (the 40
   * the account step's check asks for too), and what the downloads add on top of it.
   */
  free?: number;
  needed?: number;
  download?: number;
  /** Downloading, and paused until there is enough free space (`wait_for_room`). */
  paused?: boolean;
};

/** Where the early downloads are, as the native side last said. */
export function useEarlyDownloads(): EarlyDownloads | null {
  const [downloads, setDownloads] = useState<EarlyDownloads | null>(null);
  useEffect(() => {
    let active = true;
    const stop = listen<EarlyDownloads>("setup:downloads", (event) => {
      if (active) setDownloads(event.payload);
    });
    // Downloads that started before this screen was drawn.
    invoke<EarlyDownloads>("early_downloads_now")
      .then((now) => {
        if (active) setDownloads((seen) => seen ?? now);
      })
      .catch(() => {});
    return () => {
      active = false;
      stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  return downloads;
}

/**
 * Where the early downloads are once they have looked at the free disk, for Install. Nothing when
 * they can't say: Install is never held back on a question with no answer.
 */
export function earlyDownloadsMeasured(): Promise<EarlyDownloads | null> {
  return invoke<EarlyDownloads | null>("early_downloads_measured").catch(
    () => null,
  );
}

/**
 * A GB as Windows counts it on its drives, and as the account step's check says its "40 GB": 2^30
 * bytes. Windows F showed 15.0 GB free in File Explorer while this line said 16 GB.
 */
const GB = 1024 ** 3;

/** The early downloads as a download the setup rows can show, while they run; null otherwise. */
export function earlyDownload(
  downloads: EarlyDownloads | null,
): Downloads | null {
  // Paused for space: no bar that stopped, and no time left that runs out.
  if (downloads?.state !== "downloading" || downloads.paused) return null;
  return {
    bytes: downloads.bytes,
    size: downloads.size,
    bytesPerSecond: downloads.bytesPerSecond,
  };
}

/** "15 GB", never broken between the figure and its unit: at 1000 px it wrapped "about 2 / GB". */
function gigabytes(bytes: number, round = Math.round): string {
  return `${Math.max(1, round(bytes / GB))}\u00a0GB`;
}

/** The download's own part of what OpenBot needs, said apart, and rounded up so it is enough. */
function downloadSaid(download: number | undefined): string {
  return download
    ? ` plus about ${gigabytes(download, Math.ceil)} for its download`
    : "";
}

/** Said while the downloads are paused for space, here and on Install's own row. */
export const PAUSED_FOR_SPACE =
  "The download is paused until there's enough free space. It carries on by itself.";

/**
 * The line for `downloads`, or null when there is nothing to say. In the words of the background
 * install's row: "Downloading OpenBot. About 3 minutes left.", the time left as that row works it
 * out (`left`, in seconds; null while it is not known, `slow` when it is taking longer than usual).
 * The first screen also says when something will download at Install instead; later screens say only
 * what is still going on, since Install's own rows take over from there. Nobody says when
 * everything is downloaded: Install is the next step either way.
 */
export function earlyDownloadsSaid(
  downloads: EarlyDownloads,
  firstScreen: boolean,
  time: { left: number | null; slow: boolean } | null = null,
): string | null {
  const { state, free, needed, download } = downloads;
  switch (state) {
    case "downloading": {
      if (downloads.paused) return PAUSED_FOR_SPACE;
      if (time?.slow) return `Downloading OpenBot. ${leftSaid(null)}.`;
      return time?.left != null
        ? `Downloading OpenBot. ${leftSaid(time.left)}.`
        : "Downloading OpenBot.";
    }
    case "short":
      return free != null && needed != null
        ? `This computer has ${gigabytes(free)} of free space, and OpenBot needs ${gigabytes(needed)}${downloadSaid(download)}. Free up some space and the download starts by itself.`
        : null;
    case "done":
      return null;
    case "failed":
      return firstScreen
        ? "Some downloads didn’t finish. Install tries them again."
        : null;
    default:
      return null;
  }
}

/**
 * The early downloads' line, with the background row's bar while they download: one bar over every
 * download, that only moves forward. Nothing when there is nothing to say.
 */
export function EarlyDownloadsLine({
  firstScreen = false,
}: {
  /**
   * The Welcome screen, where the downloads start. There the line keeps the height of its tallest
   * state (a line, a bar and the bytes) whatever it says, and when it says nothing: on Windows F
   * the usage-data text under it moved up about 40px when the download finished.
   */
  firstScreen?: boolean;
}) {
  const downloads = useEarlyDownloads();
  const download = earlyDownload(downloads);
  const where = useDownloadWhere(download);
  const said = downloads
    ? earlyDownloadsSaid(downloads, firstScreen, where)
    : null;
  if (!said && !firstScreen) return null;
  return (
    <div
      className={
        firstScreen ? "early-downloads first-screen" : "early-downloads"
      }
    >
      {said && (
        <StatusLine working={download != null}>{setupText(said)}</StatusLine>
      )}
      {said && download && where && (
        <DownloadProgress downloads={download} where={where} />
      )}
    </div>
  );
}
