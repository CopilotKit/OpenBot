/** A hosted OpenBot's sign-in: with the person's account with OpenBot by CopilotKit. */

/** Where a hosted OpenBot's sign-in starts: the server sends the browser on to that sign-in and back. */
export const HOSTED_SIGN_IN_PATH = "/api/auth/hosted/sign-in";

/**
 * Where a hosted OpenBot's sign-out ends: the server signs this browser out of OpenBot by CopilotKit too, then
 * sends it back. Without it, the next person to choose "Continue with OpenBot by CopilotKit" in this browser is
 * signed straight back in as the person who just signed out.
 */
export const HOSTED_SIGN_OUT_PATH = "/api/auth/hosted/sign-out";

/**
 * The address that signs somebody in through the hosted sign-in and brings them back to `returnTo`,
 * an address on this OpenBot. Opened as a page, not fetched: the browser leaves for the hosted
 * sign-in. The server sends a person back only to its own origin, whatever this says.
 */
export function hostedSignInAddress(
  returnTo: string,
  invitation?: HostedInvitation,
): string {
  const query = [`returnTo=${encodeURIComponent(returnTo)}`];
  if (invitation) {
    if (invitation.ticket)
      query.push(`invitationTicket=${encodeURIComponent(invitation.ticket)}`);
    if (invitation.organizationId)
      query.push(
        `organizationId=${encodeURIComponent(invitation.organizationId)}`,
      );
  }
  return `${HOSTED_SIGN_IN_PATH}?${query.join("&")}`;
}

/**
 * An invitation to an organization on a hosted OpenBot, as its email's button carries it: the
 * one-time ticket from the hosted sign-in, and the OpenBot organization it invites to. The hosted
 * sign-in takes the ticket instead of asking the person to sign up again, and the server lands them
 * working in that organization. An invitation the hosted sign-in has already accepted has no ticket
 * left to carry, only the organization to land in.
 */
export type HostedInvitation =
  | { ticket: string; organizationId?: string }
  | { ticket?: undefined; organizationId: string };

/**
 * The address that signs this browser out of OpenBot by CopilotKit and brings it back to `returnTo`, an address
 * on this OpenBot. Opened as a page, like the sign-in. The server sends the browser back only to its own origin.
 */
export function hostedSignOutAddress(returnTo: string): string {
  return `${HOSTED_SIGN_OUT_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}
