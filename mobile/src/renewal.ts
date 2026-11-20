/**
 * A hosted OpenBot's sign-in that the phone couldn't renew by itself: the request function says so here
 * (src/api/request.ts), with where sign-in renews it, and Home offers "Sign in again". It imports nothing, so it can be
 * tested without a phone.
 */

type Listener = (signIn: string) => void;
const listeners = new Set<Listener>();

/** Renewing needs the person: `signIn` is the path that renews it. */
export function reportRenewalNeedsClick(signIn: string): void {
  for (const listener of [...listeners]) listener(signIn);
}

/** Hear each time it happens. Returns how to stop hearing. */
export function onRenewalNeedsClick(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
