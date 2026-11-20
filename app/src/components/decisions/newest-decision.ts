import { useEffect, useSyncExternalStore } from "react";

/**
 * Which decision card answers the keyboard.
 *
 * A conversation can hold more than one card waiting on an answer: an approval behind a question,
 * or two Bots in a group asking at once. Pressing 1 must pick in exactly one of them, and the one a
 * person is looking at is the newest, at the bottom of the transcript. So every waiting card says it
 * is waiting, in the order it mounted, and only the last one takes the keys.
 */

let waiting: readonly string[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const newest = () => waiting.at(-1);

/** Whether this card, while `active`, is the newest card waiting on an answer. */
export function useNewestDecision(id: string, active: boolean): boolean {
  useEffect(() => {
    if (!active) return;
    waiting = [...waiting.filter((each) => each !== id), id];
    emit();
    return () => {
      waiting = waiting.filter((each) => each !== id);
      emit();
    };
  }, [id, active]);
  return useSyncExternalStore(subscribe, newest, newest) === id && active;
}
