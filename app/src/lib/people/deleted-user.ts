/**
 * A person who deleted their account, wherever something of theirs outlives them.
 *
 * What they said in conversations others are in, and what they did in an organization, stays: it
 * is the organization's. It no longer names them, as GitHub's ghost does. The server takes their
 * name off in one of two ways, and both read "Deleted user" here:
 *
 * - a message of theirs has no sender any more (its person is null);
 * - a record that said who did something says a pseudonym instead, `deleted-user:` and a hash that
 *   is the same for all of one person's rows (the audit trail, who asked, who granted).
 *
 * The one place the app names a deleted person. Imports nothing, so any screen or rule can use it.
 */

/** How a deleted person is named wherever something of theirs is shown. */
export const DELETED_USER = "Deleted user";

/** What every deleted person's pseudonym starts with, as the server writes it. */
const PSEUDONYM_PREFIX = "deleted-user:";

/** Whether an id is a deleted person's pseudonym. */
export function isDeletedUser(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(PSEUDONYM_PREFIX);
}

/**
 * The words a person is shown by where something they did or said is shown: their name, their
 * address when they have no name, and "Deleted user" when there is neither any more.
 */
export function personLabel(
  person: { name?: string | null; email?: string | null } | null | undefined,
): string {
  return person?.name?.trim() || person?.email?.trim() || DELETED_USER;
}
