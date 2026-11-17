/**
 * An invitation's link, kept across signing in.
 *
 * Somebody invited by email opens `/invitations/<id>` before they have signed in, or before they
 * have an account at all. Sign-in takes no return address, so the link is remembered in this tab
 * while they sign in and answer onboarding, and home hands them on to it once.
 *
 * Only an invitation's own address is ever kept or followed: anything else is ignored, so this is
 * no way to send a person somewhere of a link's choosing.
 */
const KEY = "openbot.invitation-link";
const INVITATION_LINK = /^\/invitations\/([A-Za-z0-9_-]{1,128})$/;

/** The invitation an address names, when it is an invitation's link. */
export function invitationIn(pathname: string): string | undefined {
  return INVITATION_LINK.exec(pathname)?.[1];
}

/** Remember the invitation a person was on their way to, when the address is one. */
export function rememberInvitationLink(pathname: string): void {
  const invitationId = invitationIn(pathname);
  if (!invitationId) return;
  try {
    sessionStorage.setItem(KEY, invitationId);
  } catch {
    // No storage in this tab: they find the invitation in their account menu.
  }
}

/** The invitation a person was on their way to, once: asking again answers nothing. */
export function takeInvitationLink(): string | undefined {
  try {
    const kept = sessionStorage.getItem(KEY);
    if (kept === null) return undefined;
    sessionStorage.removeItem(KEY);
    return invitationIn(`/invitations/${kept}`);
  } catch {
    return undefined;
  }
}
