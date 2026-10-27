import { useSyncExternalStore } from "react";

/*
 * Which Bot the person put at the centre of OpenMuse. A per-browser preference, like the skin itself:
 * it lives in localStorage and nowhere else, so choosing a Bot here changes nothing on the server.
 */
export const CHOSEN_BOT_KEY = "openmuse-bot";

function read(): string | null {
  try {
    return window.localStorage.getItem(CHOSEN_BOT_KEY);
  } catch {
    return null;
  }
}

let current: string | null = typeof window === "undefined" ? null : read();
const listeners = new Set<() => void>();

export function chooseBot(id: string) {
  if (current === id) return;
  current = id;
  // localStorage throws in some privacy modes; the choice still holds for this visit.
  try {
    window.localStorage.setItem(CHOSEN_BOT_KEY, id);
  } catch {}
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChosenBotId(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
