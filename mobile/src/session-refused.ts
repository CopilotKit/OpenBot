/**
 * OpenBot refused a signed-in request as signed out (401): the session the app holds was revoked or ran out while the
 * app was open. The request function says so here (src/api/request.ts), and the root layout reads the session again,
 * so a session that is gone takes the person back to the signed-out screen with its sign-in buttons, with no restart.
 * It imports nothing, so it can be tested without a phone.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

/** A request sent with the session's cookie was answered 401. */
export function reportSessionRefused(): void {
  for (const listener of [...listeners]) listener();
}

/** Hear each such refusal. Returns how to stop hearing. */
export function onSessionRefused(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
