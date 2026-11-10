import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import {
  type Downloads,
  DownloadProgress,
  StatusLine,
  timeLeft,
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
 * The line for `downloads`, or null when there is nothing to say. In the words the background
 * install's row uses ("Downloading OpenBot. About 3 minutes left."), with the bytes under the bar.
 * The first screen also says when everything is downloaded, or when something will download at
 * Install instead; later screens say only what is still going on, since Install's own rows take
 * over from there.
 */
export function earlyDownloadsSaid(
  downloads: EarlyDownloads,
  firstScreen: boolean,
): string | null {
  const { state, free, needed } = downloads;
  switch (state) {
    case "downloading": {
      const left = timeLeft(earlyDownload(downloads));
      return left ? `Downloading OpenBot. ${left}` : "Downloading OpenBot.";
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

/** The early downloads' line, with a bar while they download. Nothing when there is nothing to say. */
export function EarlyDownloadsLine({
  firstScreen = false,
}: {
  /** The Welcome screen, where the downloads start. */
  firstScreen?: boolean;
}) {
  const downloads = useEarlyDownloads();
  if (!downloads) return null;
  const said = earlyDownloadsSaid(downloads, firstScreen);
  if (!said) return null;
  const download = earlyDownload(downloads);
  return (
    <div className="early-downloads">
      <StatusLine working={download != null}>{said}</StatusLine>
      {download && <DownloadProgress downloads={download} />}
    </div>
  );
}
