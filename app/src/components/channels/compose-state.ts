/**
 * The rules a compose screen follows before there is a channel to hold them.
 *
 * Pure helpers so recipient-cap and sendability behavior stay testable without rendering.
 */

export type Recipient = {
  id: string;
  name: string;
};

/**
 * How many Bots one new conversation may hold: the server's limit for a group. One Bot is an
 * ordinary conversation; two or more are a group, answering in the order they were picked.
 */
export const MAX_RECIPIENTS = 20;

/** Add a Bot after the others, dropping the earliest once the cap is reached. */
export function addRecipient(
  current: readonly Recipient[],
  next: Recipient,
): Recipient[] {
  if (current.some((recipient) => recipient.id === next.id)) {
    return [...current];
  }
  return [...current, next].slice(-MAX_RECIPIENTS);
}

export function removeRecipient(
  current: readonly Recipient[],
  id: string,
): Recipient[] {
  return current.filter((recipient) => recipient.id !== id);
}

/** Whether this draft can start a conversation. */
export function canSend(
  recipients: readonly Recipient[],
  text: string,
): boolean {
  return (
    recipients.length >= 1 &&
    recipients.length <= MAX_RECIPIENTS &&
    text.trim().length > 0
  );
}

/** Whether these recipients make a group rather than a conversation with one Bot. */
export function startsGroup(recipients: readonly Recipient[]): boolean {
  return recipients.length > 1;
}

/**
 * What the To: field holds after the picker reports a change.
 *
 * The picker clears every selection on Escape once its list is closed, which would throw away a
 * group someone spent a while choosing in the moment they meant to dismiss a list. That one kind of
 * change is ignored; picks and removals are kept, at most `MAX_RECIPIENTS` of them.
 */
export function toFieldChange<T>(
  current: readonly T[],
  next: readonly T[],
  reason: string,
): T[] {
  if (reason === "escape-key") return [...current];
  return next.slice(-MAX_RECIPIENTS);
}
