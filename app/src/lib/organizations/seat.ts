import type { AssignableRole } from "@/lib/api/generated/model";
import { ClientError } from "@/lib/client";

/**
 * Inviting somebody into an organization that pays for each member, with every seat it paid for
 * taken.
 *
 * The server refuses the invitation with SEAT_REQUIRED (402), in a sentence that says what a member
 * costs, and gives an owner or an admin `addSeatUrl`: where they add one more seat in the browser.
 * The Invite dialog says the sentence and offers that one way on, never "try again".
 *
 * Adding the seat leaves OpenBot in this tab, so the invitation being written is kept in the tab
 * first: back on the organization's settings, the Invite dialog opens again with the address and
 * the role as they were, ready to send. It is read once, and only for the organization it was
 * written in. Storage refused (a private window, a policy) means nothing is kept, and the person
 * types the address again.
 */

export const SEAT_REQUIRED = "SEAT_REQUIRED";

/** An invitation written and not yet sent, kept while its organization adds a seat. */
export type InviteDraft = {
  organizationId: string;
  email: string;
  role: AssignableRole;
};

const KEY = "openbot.invite-after-seat";
/** Where the person comes back to: the organization's settings, where the Invite dialog is. */
const BACK = "/settings/organization";

/**
 * When `error` is the server refusing an invitation for want of a seat: where to add one, or null
 * for somebody who can't (`addSeatUrl`, the server's verdict). Otherwise undefined.
 */
export function seatRequired(
  error: unknown,
): { addSeatUrl: string | null } | undefined {
  if (!(error instanceof ClientError) || error.code !== SEAT_REQUIRED)
    return undefined;
  const url = error.body?.addSeatUrl;
  return { addSeatUrl: typeof url === "string" && url ? url : null };
}

/**
 * The address the Add a seat button opens. Where it is OpenBot's own (a path), it is told to come
 * back to the organization's settings, as the add-a-card address is; an address elsewhere is
 * followed as the server gave it.
 */
export function addSeatAddress(addSeatUrl: string): string {
  if (!addSeatUrl.startsWith("/") || addSeatUrl.startsWith("//"))
    return addSeatUrl;
  const url = new URL(addSeatUrl, window.location.origin);
  if (!url.searchParams.has("returnTo"))
    url.searchParams.set("returnTo", `${window.location.origin}${BACK}`);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Keep the invitation being written, before the person leaves to add a seat. */
export function keepInviteForSeat(draft: InviteDraft): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // No storage in this tab: back from adding the seat, the address is typed again.
  }
}

/** The invitation kept for this organization, once: asking again answers nothing. */
export function takeInviteAfterSeat(
  organizationId: string,
): InviteDraft | undefined {
  try {
    const text = sessionStorage.getItem(KEY);
    if (text === null) return undefined;
    const draft = JSON.parse(text) as Partial<InviteDraft>;
    if (draft.organizationId !== organizationId) return undefined;
    sessionStorage.removeItem(KEY);
    return typeof draft.email === "string" &&
      (draft.role === "member" || draft.role === "admin")
      ? { organizationId, email: draft.email, role: draft.role }
      : undefined;
  } catch {
    return undefined;
  }
}
