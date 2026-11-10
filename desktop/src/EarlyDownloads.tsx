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
  /** Free on this computer's disk, and what setup needs, when the disk is short. */
  free?: number;
  needed?: number;
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

const GB = 1_000_000_000;

/** The early downloads as a download the setup rows can show, while they run; null otherwise. */
export function earlyDownload(
  downloads: EarlyDownloads | null,
): Downloads | null {
  if (downloads?.state !== "downloading") return null;
  return {
    bytes: downloads.bytes,
    size: downloads.size,
    bytesPerSecond: downloads.bytesPerSecond,
  };
}

function gigabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / GB))} GB`;
}

/**
 * The line for `downloads`, or null when there is nothing to say. In the words of the background
 * install's row: "Downloading OpenBot. About 3 minutes left.", the time left as that row works it
 * out (`left`, in seconds; null while it is not known, `slow` when it is taking longer than usual).
 * The first screen also says when everything is downloaded, or when something will download at
 * Install instead; later screens say only what is still going on, since Install's own rows take
 * over from there.
 */
export function earlyDownloadsSaid(
  downloads: EarlyDownloads,
  firstScreen: boolean,
  time: { left: number | null; slow: boolean } | null = null,
): string | null {
  const { state, free, needed } = downloads;
  switch (state) {
    case "downloading": {
      if (time?.slow) return `Downloading OpenBot. ${leftSaid(null)}.`;
      return time?.left != null
        ? `Downloading OpenBot. ${leftSaid(time.left)}.`
        : "Downloading OpenBot.";
    }
    case "short":
      return free != null && needed != null
        ? `This computer has ${gigabytes(free)} of free space, and OpenBot needs about ${gigabytes(needed)}. Free up some space and the download starts by itself.`
        : null;
    case "done":
      return firstScreen ? "OpenBot is downloaded and ready to install." : null;
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
      {said && <StatusLine working={download != null}>{said}</StatusLine>}
      {said && download && where && (
        <DownloadProgress downloads={download} where={where} />
      )}
    </div>
  );
}
