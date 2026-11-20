/** A hosted OpenBot's sign-in: with the person's account with OpenBot by CopilotKit. */

/** Where a hosted OpenBot's sign-in starts: the server sends the browser on to that sign-in and back. */
export const HOSTED_SIGN_IN_PATH = "/api/auth/hosted/sign-in";

/**
 * The address that signs somebody in through the hosted sign-in and brings them back to `returnTo`,
 * an address on this OpenBot. Opened as a page, not fetched: the browser leaves for the hosted
 * sign-in. The server sends a person back only to its own origin, whatever this says.
 */
export function hostedSignInAddress(returnTo: string): string {
  return `${HOSTED_SIGN_IN_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}
