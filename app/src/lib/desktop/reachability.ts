/**
 * Whether the OpenBot this page is shown from answered its last request.
 *
 * Inside OpenBot Desktop connected to an OpenBot that runs somewhere else, every request goes to the
 * desktop app's relay on this computer, which carries it to that OpenBot. When that OpenBot does not
 * answer (its address is down, a port forward stopped, the network went), the relay answers the page
 * itself with a 502 and the one sentence below (desktop/src-tauri/src/connected/relay.rs, `unreachable`).
 * That answer is what this reads. Any other answer, a refusal or a 502 from beyond the relay included,
 * means the OpenBot's address answered.
 *
 * `lib/client.ts` reports every answer here, so the line clears on the next request that gets one.
 * Only connected mode acts on it (`connection-lost.ts`): the line shows, and the screens wait for
 * OpenBot. In a browser and in a local Desktop nothing does.
 *
 * No imports, so the transport can report to it without a cycle.
 */

/** The relay's own body when the OpenBot it carries requests to could not be reached. */
export const RELAY_UNREACHABLE = "OpenBot could not be reached.";

let unreachable = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (next === unreachable) return;
  unreachable = next;
  for (const listener of listeners) listener();
}

/**
 * A request was answered. A 502 is read to tell the relay's own answer from one passed on; the
 * promise settles once it has been, so the caller can let its request fail knowing which it was.
 */
export function noteAnswer(response: Response): Promise<void> {
  if (response.status !== 502) {
    set(false);
    return Promise.resolve();
  }
  return response
    .clone()
    .text()
    .then(
      (body) => set(body.trim() === RELAY_UNREACHABLE),
      () => undefined,
    );
}

/**
 * A request got no answer at all: `fetch` rejected. A request the page gave up on is not that; only
 * the network failing is (`fetch` rejects those with a TypeError).
 */
export function noteNoAnswer(error: unknown): void {
  if (error instanceof TypeError) set(true);
}

/** For `useSyncExternalStore`. */
export function subscribeReachability(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True from an unanswered request until the next answered one. */
export function openbotUnreachable(): boolean {
  return unreachable;
}
