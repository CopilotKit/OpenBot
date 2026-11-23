import {
  isKnownRole,
  isOrganizationAdmin,
  type KnownRole,
  knownRole,
} from "@/lib/auth/roles";
import { relativeTime } from "@/lib/relative-time";
import type {
  OrganizationMemberSummary,
  ReceivedInvitation,
  SentInvitation,
} from "./queries";

/**
 * The words the organization screens say, and which control a row offers. Pure, so each is pinned
 * by a fast test. The server decides what is allowed and refuses the rest in its own sentence; these
 * only keep a screen from offering what the person's role is known to be refused.
 */

const ROLE_NAMES = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/**
 * A role as a label: Owner, Admin or Member. One a newer server sends that the app doesn't know is
 * read as the least it could be, and named Member.
 */
export function roleName(role: string): string {
  return ROLE_NAMES[knownRole(role)];
}

/** A role inside a sentence: "an admin", "a member". */
export function roleInSentence(role: string): string {
  const name = roleName(role).toLowerCase();
  return `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
}

/** What a row calls somebody OpenBot knows neither a name nor an address for. */
export const UNNAMED_PERSON = "Unnamed member";

/** What a member's row says of somebody who is a member and hasn't opened OpenBot yet. */
export const NOT_OPENED_YET = "Hasn't opened OpenBot yet";

/**
 * What somebody is called: their name, or their address until they choose one. Somebody who hasn't
 * opened OpenBot yet may have neither (`notOpenedYet`), and is then a neutral label.
 */
export function personName(person: {
  name: string | null;
  email: string;
}): string {
  return person.name?.trim() || person.email.trim() || UNNAMED_PERSON;
}

/**
 * The second line of a member's row: their address when their name is the first line, their role,
 * and, for somebody who hasn't opened OpenBot yet, that they haven't.
 */
export function memberLine(
  member: Pick<
    OrganizationMemberSummary,
    "name" | "email" | "role" | "notOpenedYet"
  >,
): string {
  const parts: string[] = [];
  const email = member.email.trim();
  if (member.name?.trim() && email) parts.push(email);
  parts.push(roleName(member.role));
  if (member.notOpenedYet) parts.push(NOT_OPENED_YET);
  return parts.join(" · ");
}

/** Up to two letters for a person with no picture, as the account row draws them. */
export function initialsOf(person: {
  name: string | null;
  email: string;
}): string {
  const name = person.name?.trim();
  // Neither a name nor an address: none, and the row draws a person's mark instead.
  if (!name) return person.email.trim().slice(0, 2).toUpperCase();
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

/**
 * What a member's row offers the person looking at it: to leave on their own row, to remove on
 * anybody else's when they are the owner or an admin, and nothing where the membership cannot end.
 * Whether it can is the server's verdict (`removable`): the owner stays, so nobody is offered to
 * leave their own organization, and so does somebody OpenBot's settings keep as an admin.
 * That holds for somebody who hasn't opened OpenBot yet too: they are offered for removal when the
 * server says they can be removed, and not otherwise.
 * `removable` says whether the membership can end at all, not who may end it. Only an owner removes
 * another owner, as the server holds, so an admin is offered no Remove on an owner's row.
 */
export function memberControl(
  member: Pick<OrganizationMemberSummary, "id" | "role" | "removable">,
  viewer: { id: string | undefined; role: string },
): "leave" | "remove" | null {
  if (!member.removable) return null;
  if (member.id === viewer.id) return "leave";
  if (member.role === "owner" && viewer.role !== "owner") return null;
  return isOrganizationAdmin(viewer.role) ? "remove" : null;
}

/**
 * What the Remove dialog tells the admin removing somebody. Somebody who hasn't opened OpenBot yet made nothing here, so
 * it says only what removing them does.
 */
export function removeMemberWords(
  member: Pick<OrganizationMemberSummary, "notOpenedYet">,
  organizationName: string,
): string {
  return member.notOpenedYet
    ? `This takes them out of ${organizationName}. They haven't opened OpenBot yet.`
    : "They keep their account and their other organizations. What they made here stays here.";
}

/**
 * The roles a member's Role menu offers: the server's verdict (`assignableRoles`), less any role a
 * newer server lists that this app doesn't know. The app can't name one it doesn't know, and never
 * sends one back. None for somebody who hasn't opened OpenBot yet: their role is shown, not changed.
 */
export function givableRoles(
  member: Pick<OrganizationMemberSummary, "assignableRoles" | "notOpenedYet">,
): KnownRole[] {
  if (member.notOpenedYet) return [];
  return (member.assignableRoles as readonly string[]).filter(isKnownRole);
}

/**
 * Whether giving a member a role is asked about first, and as what: making somebody an owner, or
 * the person stepping down from owner themselves. Any other change applies at once. This picks the
 * question only; which roles are offered at all is the server's verdict (`assignableRoles`).
 */
export function roleChangeQuestion(
  member: Pick<OrganizationMemberSummary, "id" | "role">,
  role: string,
  viewerId: string | undefined,
): "make-owner" | "step-down" | null {
  if (role === "owner") return "make-owner";
  if (member.role === "owner" && member.id === viewerId) return "step-down";
  return null;
}

const SENT_STATUS: Record<string, string> = {
  pending: "Pending",
  expired: "Expired",
  declined: "Declined",
};

/**
 * The second line of an invitation an organization sent: its role, its status, and when it expires.
 * A status a newer server sends that the app doesn't know leaves the role alone.
 */
export function sentInvitationLine(invitation: SentInvitation): string {
  const parts = [roleName(invitation.role)];
  const status = SENT_STATUS[invitation.status];
  if (status) parts.push(status);
  if (invitation.status === "pending")
    parts.push(`Expires ${relativeTime(invitation.expiresAt)}`);
  return parts.join(" · ");
}

/** What an invitation says to the person it was sent to, in whatever state it is in. */
export function receivedInvitationLine(invitation: ReceivedInvitation): string {
  const inviter = personName(invitation.invitedBy);
  switch (invitation.status) {
    case "pending":
      return `${inviter} invited you to join as ${roleInSentence(invitation.role)}. Expires ${relativeTime(invitation.expiresAt)}.`;
    case "expired":
      return `This invitation has expired. Ask ${inviter} to send a new one.`;
    case "accepted":
      return `You're a member of ${invitation.organization.name}.`;
    case "declined":
      return "You declined this invitation.";
    case "canceled":
      return `This invitation was canceled. Ask ${inviter} to send a new one.`;
    default:
      // A status a newer server sends that the app doesn't know: only who it is from.
      return `Invited by ${inviter}.`;
  }
}

/** The link that opens an invitation, for the inviter to pass on. */
export function invitationLink(
  invitationId: string,
  origin: string = window.location.origin,
): string {
  return `${origin}/invitations/${encodeURIComponent(invitationId)}`;
}
