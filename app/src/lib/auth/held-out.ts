/** The server's code for a member an organization holds out until they sign in through their company. */
export const SSO_REQUIRED = "SSO_REQUIRED";

/** The close code the server ends the app's sockets with when an organization begins to hold the person out. */
export const SSO_REQUIRED_CLOSE = 4403;

/**
 * What the held page says when the hold was found out from a socket closing, which carries no sentence of its own.
 * A request refused for it carries the server's, and that is said instead.
 */
export const HELD_OUT_NOW =
  "This organization now requires signing in through your company. Link your company account to continue.";

/**
 * Whether a failure is the organization holding the person out until they sign in through their company's identity
 * provider (Require SSO). An answer, not a fault: every request in the organization says the same until they link
 * their company account, so it is never retried (query-client.ts) and never shown as an error.
 *
 * Read by the refusal's code alone, with nothing imported, so the query client can ask it.
 */
export function heldOutBySso(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SSO_REQUIRED
  );
}

/*
 * A hold that begins while the app is open. On a load the gate finds it out and the router shows the held page; once
 * the app is showing, the first refusal for it (a request answered SSO_REQUIRED, or the server closing the app's
 * sockets with SSO_REQUIRED_CLOSE) is kept here, and the signed-in app gives way to the held page at once
 * (`HeldOutGate`), instead of staying on a page whose every request fails until the next load.
 *
 * Kept for the organization it was found in: working in another (query-client.ts) lets it go.
 */
let held: string | undefined;
const listeners = new Set<() => void>();

/** The sentence the held page says, from the refusal that found the hold out; undefined while nothing holds. */
export function heldOutRefusal(): string | undefined {
  return held;
}

/** The organization holds the person out from now: the first refusal's sentence is kept. */
export function holdOut(refusal: string): void {
  if (held !== undefined) return;
  held = refusal;
  for (const listener of [...listeners]) listener();
}

/** Nothing holds the person out any more: they work in another organization now. */
export function releaseHold(): void {
  if (held === undefined) return;
  held = undefined;
  for (const listener of [...listeners]) listener();
}

/** Hear the hold begin or end. Returns how to stop hearing. */
export function onHoldChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
