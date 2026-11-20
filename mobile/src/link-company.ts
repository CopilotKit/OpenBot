/**
 * Linking the person's company account from the phone. The system browser holds no OpenBot session, so the app asks
 * OpenBot for a ticket (`createCompanySignInTicket`): a single-use address, good for two minutes, that signs in through
 * the provider as this person. It is asked for on the tap, opened at once in the system browser (never a web view), and
 * never kept or sent again: a ticket opens once, and asking again with the same Idempotency-Key is refused, so a retry is
 * a new request with a new key, which the API client gives every write.
 *
 * Imports nothing that needs a phone: the two platform steps are given to it, so it can be tested.
 */

/**
 * Where OpenBot's "linked" page sends the browser once the company account is linked: the system browser's session
 * ends there and the app is back in front. Exactly this, with nothing appended. A sign-in that failed or was refused
 * ends on OpenBot's own page instead, and the person closes it: either way the app reads the company sign-in again.
 */
export const RETURN_ADDRESS = "openbotmobile://company-sign-in/linked";

/*
 * The same address can open the app outside the browser's session too (the linked page's Open OpenBot button, after
 * the session ended): its screen says so here, and Home reads the company sign-in again and leaves the held state.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

/** The browser came back from linking the company account. */
export function reportCompanyLinked(): void {
  for (const listener of [...listeners]) listener();
}

/** Hear each time it happens. Returns how to stop hearing. */
export function onCompanyLinked(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type LinkSteps = {
  /** Ask OpenBot for a ticket for this provider; resolves to the address to open. */
  ticket: (providerId: string) => Promise<{ url: string }>;
  /** Open an address in the system browser's sign-in session; resolves when it closes or comes back. */
  open: (url: string, returnTo: string) => Promise<unknown>;
};

/**
 * The outcome: `opened` once the browser has come back (the caller reads the company sign-in again, and `met` says
 * whether it took), or `stale` when the provider is no longer one that counts here (the caller reads the list again).
 * Any other refusal is thrown, in the server's sentence.
 */
export async function linkCompanyAccount(
  providerId: string,
  steps: LinkSteps,
): Promise<"opened" | "stale"> {
  let url: string;
  try {
    ({ url } = await steps.ticket(providerId));
  } catch (error) {
    if (
      (error as { code?: unknown } | null)?.code ===
      "IDENTITY_PROVIDER_NOT_FOUND"
    )
      return "stale";
    throw error;
  }
  await steps.open(url, RETURN_ADDRESS);
  return "opened";
}
