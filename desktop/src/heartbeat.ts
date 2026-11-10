import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The setup page's heartbeat, read by the native side (`desktop_stall`, `stall::UiWatch`).
 *
 * On Windows a setup window froze for minutes: the native side kept working and sending its
 * progress, and the page took none of it until a click or Alt+Tab. While the setup, start or update
 * screens show, the page says every few seconds, and as soon as a row's progress reaches it, the
 * highest progress number it has taken (`setup:progress` carries one). Progress the page leaves
 * untaken for over 30 seconds while the window is on screen is a stall, said once in the usage data
 * and the Desktop log.
 *
 * Cheap and never in the way: one small invoke, never awaited, at most once a second for progress.
 */

/** How often the page says it is here when nothing else makes it. */
export const HEARTBEAT_MS = 5_000;

/** The least time between two heartbeats sent because progress arrived. */
export const SOONEST_MS = 1_000;

type Numbered = { seq?: unknown };

/**
 * Start the heartbeat; the function returned stops it. It listens first, so the first heartbeat
 * (`fresh`) can count whatever was sent before as taken. A page that cannot listen sends none.
 */
export function startHeartbeat({
  every = HEARTBEAT_MS,
  now = Date.now,
}: {
  every?: number;
  now?: () => number;
} = {}): () => void {
  let seen = 0;
  let fresh = true;
  let last = Number.NEGATIVE_INFINITY;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const beat = () => {
    if (stopped) return;
    last = now();
    const args = { seen, fresh };
    fresh = false;
    invoke("setup_heartbeat", args).catch(() => {});
  };
  const listening = listen<Numbered>("setup:progress", (event) => {
    const seq = event.payload?.seq;
    if (typeof seq !== "number" || seq <= seen) return;
    seen = seq;
    if (now() - last >= SOONEST_MS) beat();
  });
  listening.then(
    () => {
      if (stopped) return;
      beat();
      timer = setInterval(beat, every);
    },
    () => {},
  );
  return () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    listening.then(
      (unlisten) => unlisten(),
      () => {},
    );
  };
}
