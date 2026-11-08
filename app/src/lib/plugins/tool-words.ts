import { appToolName } from "@openbot/shared/tool-name";

/**
 * One of an app's tools as a person reads it on the app's page: what it does, in the words Activity
 * and a conversation give the same tool ("Add label to email", not `GMAIL_ADD_LABEL_TO_EMAIL`), and
 * what its description says it does.
 *
 * FOR THE PERSONAL EDITION. Team Admin keeps the stored name, which is what an admin writes a rule
 * against and finds on the tool's own page.
 */
export function toolInWords(
  serverId: string,
  tool: { name: string; description: string },
): { label: string; summary: string | null } {
  return {
    label: appToolName(serverId, tool.name).label,
    summary: toolSummary(tool.description),
  };
}

/**
 * The first sentence of a tool's description, or null when there is none a person can read.
 *
 * A description is written for the model. Its first sentence says what the tool does, and the rest
 * tells the model how to call it, by the ids of its parameters and of other tools (`message_id`,
 * `GMAIL_FETCH_EMAILS`, `listLabels`). The first clause before a semicolon is where the vendor's
 * summary ends and that advice starts, so it ends the sentence too. A sentence that still names an
 * id is not shown at all: a row with the tool's words and no sentence says less, but nothing wrong.
 */
export function toolSummary(description: string): string | null {
  const first = description
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z])|;\s/)[0]
    ?.trim();
  if (!first || NAMES_AN_ID.test(first)) return null;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/**
 * Text that names an id rather than says a thing: code in backticks, words joined by an underscore
 * (`user_id`, `GMAIL_SEND_DRAFT`), or a word that starts lower case and carries a capital
 * (`listLabels`, `historyId`).
 */
const NAMES_AN_ID = /`|\w_\w|\b[a-z]+[A-Z]\w*/;
