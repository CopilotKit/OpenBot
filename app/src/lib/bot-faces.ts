import { useSyncExternalStore } from "react";

/**
 * How much the Bots' faces move: always, only while a Bot is busy, or never. Kept in this browser
 * like Appearance, and read by every orb on the page without a provider, so a face drawn anywhere,
 * a dialog or a test included, follows the person's choice. Reduced motion stills every face
 * whatever is chosen here.
 */

/** Where the person's choice is kept: "animated", "working" or "still". */
export const BOT_FACES_STORAGE_KEY = "openbot-bot-faces";

export type BotFaces = "animated" | "working" | "still";

export const BOT_FACES: readonly BotFaces[] = ["animated", "working", "still"];

/** The person's choice from what is stored. Anything not a choice, nothing included, is "animated". */
export function parseBotFaces(stored: string | null): BotFaces {
  return stored === "working" || stored === "still" ? stored : "animated";
}

const listeners = new Set<() => void>();

/** Storage throws in some privacy modes; a face is not worth taking the app down for. */
function read(): BotFaces {
  try {
    return parseBotFaces(window.localStorage.getItem(BOT_FACES_STORAGE_KEY));
  } catch {
    return "animated";
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab of this browser chose: follow it here too.
  const fromElsewhere = (event: StorageEvent) => {
    if (event.key === null || event.key === BOT_FACES_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", fromElsewhere);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", fromElsewhere);
  };
}

/** Chooses how faces move, for every orb on the page now and in this browser from now on. */
export function setBotFaces(next: BotFaces) {
  try {
    window.localStorage.setItem(BOT_FACES_STORAGE_KEY, next);
  } catch {
    // The choice holds for this visit; it just isn't remembered.
    memory = next;
  }
  for (const listener of listeners) listener();
}

/** What was chosen when storage would not keep it. */
let memory: BotFaces | null = null;

/** How much the person wants the faces to move, kept current. */
export function useBotFaces(): BotFaces {
  return useSyncExternalStore(
    subscribe,
    () => memory ?? read(),
    () => "animated",
  );
}

const REDUCE_MOTION = "(prefers-reduced-motion: reduce)";

/**
 * Whether the person asks for less motion, kept current: turning it on while the app is open stills
 * every orb already on screen, not only the ones drawn afterwards.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const query = window.matchMedia(REDUCE_MOTION);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(REDUCE_MOTION).matches,
    () => false,
  );
}
