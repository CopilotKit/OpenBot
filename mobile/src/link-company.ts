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

/**
 * How the system browser is opened for it, on Android. expo-web-browser 55 can't close a Custom Tab there
 * (`dismissBrowser` is iOS only, and `coolDownAsync` only lets go of a warmed-up browser), and by default it opens the
 * tab in a task of its own through a proxy activity, so the tab outlived the return: Back from Home went to the
 * company's sign-in form. Opened in the app's own task (`createTask: false`), the tab sits above the app, and the deep
 * link back, which brings the app's activity to the front, takes it away.
 *
 * What that gives up: the proxy kept the tab alive when the app was opened from its icon mid-sign-in. Here, the person
 * comes back to Home, the session ends as dismissed, the company sign-in is read again, and Link opens a new ticket.
 */
export const BROWSER_OPTIONS = { createTask: false } as const;

/**
 * The `open` step, given expo-web-browser's `openAuthSessionAsync` (../auth.ts): the address, the deep link the session
 * ends at, and BROWSER_OPTIONS. Resolves when it comes back or is closed.
 */
export function openWith(
  openAuthSession: (
    url: string,
    returnTo: string,
    options: typeof BROWSER_OPTIONS,
  ) => Promise<unknown>,
): LinkSteps["open"] {
  return async (url, returnTo) => {
    await openAuthSession(url, returnTo, BROWSER_OPTIONS);
  };
}

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

/**
 * Leave the linked screen for Home without a second Home: back down to the Home already open beneath it, or, when the
 * link started the app, Home in its place. A redirect replaced the linked screen with a new Home above the first, which
 * showed a back arrow to the same screen. Expo Router's `dismissTo` does both: it dismisses to the href when the stack
 * holds it, and replaces the current screen with it when it doesn't.
 */
export function backToHome(router: { dismissTo: (href: "/") => void }): void {
  router.dismissTo("/");
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
