import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { StatusLine } from "./SetupProgress";

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
const MB = 1_000_000;

/** "1.2 of 2.9 GB", or "450 of 937 MB": both in the unit of the whole. */
export function ofSize(bytes: number, size: number): string {
  if (size >= GB)
    return `${(bytes / GB).toFixed(1)} of ${(size / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / MB)} of ${Math.round(size / MB)} MB`;
}

/** "about 3 minutes left", from what is left and the speed it is arriving at. */
export function timeLeft(seconds: number): string {
  if (seconds < 60) return "less than a minute left";
  if (seconds < 90) return "about a minute left";
  return `about ${Math.round(seconds / 60)} minutes left`;
}

function gigabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / GB))} GB`;
}

/**
 * The line for `downloads`, or null when there is nothing to say. The first screen also says when
 * everything is downloaded, or when something will download at Install instead; later screens say
 * only what is still going on, since Install's own rows take over from there.
 */
export function earlyDownloadsSaid(
  downloads: EarlyDownloads,
  firstScreen: boolean,
): string | null {
  const { state, bytes, size, bytesPerSecond, free, needed } = downloads;
  switch (state) {
    case "downloading": {
      if (size == null || size <= 0) {
        return bytes > 0
          ? `Downloading OpenBot (${(bytes / GB).toFixed(1)} GB so far).`
          : "Downloading OpenBot.";
      }
      const parts = [ofSize(Math.min(bytes, size), size)];
      if (bytesPerSecond != null && bytesPerSecond > 0 && bytes < size) {
        parts.push(timeLeft((size - bytes) / bytesPerSecond));
      }
      return `Downloading OpenBot (${parts.join(", ")}).`;
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
  const downloading = downloads.state === "downloading";
  const known = downloading && downloads.size != null && downloads.size > 0;
  return (
    <div className="early-downloads">
      <StatusLine working={downloading}>{said}</StatusLine>
      {downloading && (
        <div className="downloads">
          {known ? (
            <progress
              aria-label="Download progress"
              value={Math.min(downloads.bytes, downloads.size ?? 0)}
              max={downloads.size}
            />
          ) : (
            <progress aria-label="Download progress" />
          )}
        </div>
      )}
    </div>
  );
}
