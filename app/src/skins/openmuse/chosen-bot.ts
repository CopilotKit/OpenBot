import { useSyncExternalStore } from "react";

/*
 * Which Bot each person put at the centre of the frame. Kept in this browser, and kept per signed-in
 * person: the key carries their user id, so the next person on a shared machine starts from OpenBot's
 * own default Bot rather than the last person's choice. Choosing a Bot changes nothing on the server.
 */
export function chosenBotKey(userId: string): string {
  return `openmuse-bot:${userId}`;
}

const choices = new Map<string, string | null>();
const listeners = new Set<() => void>();

function read(userId: string): string | null {
  if (!choices.has(userId)) {
    let stored: string | null = null;
    // localStorage throws in some privacy modes; the frame then starts from the default Bot.
    try {
      stored = window.localStorage.getItem(chosenBotKey(userId));
    } catch {}
    choices.set(userId, stored);
  }
  return choices.get(userId) ?? null;
}

export function chooseBot(userId: string, agentId: string) {
  if (read(userId) === agentId) return;
  choices.set(userId, agentId);
  // The choice still holds for this visit when the browser refuses to store it.
  try {
    window.localStorage.setItem(chosenBotKey(userId), agentId);
  } catch {}
  for (const listener of listeners) listener();
}

/** Forgets every choice read into memory, as a new page load would. */
export function forgetChosenBots() {
  choices.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The Bot this person chose, or null before they choose one or while nobody is known yet. */
export function useChosenBotId(userId: string | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (userId ? read(userId) : null),
    () => null,
  );
}
