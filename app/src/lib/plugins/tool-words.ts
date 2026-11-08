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
  const plain = inPlainWords(first);
  if (!plain) return null;
  return /[.!?]$/.test(plain) ? plain : `${plain}.`;
}

/**
 * Text that names an id rather than says a thing: code in backticks, words joined by an underscore
 * (`user_id`, `GMAIL_SEND_DRAFT`), a word that starts lower case and carries a capital
 * (`listLabels`, `historyId`), or one of three or more capitalised parts (`CalendarListGet`), which
 * is longer than a brand name runs (GitHub, HubSpot).
 */
const NAMES_AN_ID =
  /`|\w_\w|\b[a-z]+[A-Z]\w*|\b[A-Z][a-z]+(?:[A-Z][a-z]+){2,}\b/;

/**
 * The vendor's sentence with three habits of text written for a model taken out, and nothing else
 * changed: the "Tool to" it opens with ("Tool to create a filter" reads "Create a filter"), how it
 * finds a thing ("by its ID", which a person has no ID to give), and words in capitals ("Permanently
 * DELETES").
 */
function inPlainWords(sentence: string): string {
  const plain = sentence
    .replace(/^(?:use this tool to|tool (?:to|that))\s+/i, "")
    .replace(BY_ITS_ID, withoutFindingById)
    .replace(/\b[A-Z]{2,}\b(:?)/g, (word: string, label: string) => {
      const bare = word.slice(0, word.length - label.length);
      if (!shouted(bare)) return word;
      // A label keeps its capital: "CRITICAL: content" reads "Critical: content".
      return label
        ? `${bare.charAt(0)}${bare.slice(1).toLowerCase()}${label}`
        : bare.toLowerCase();
    })
    .trim();
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

/**
 * How a tool finds a thing by its ID: "by ID", "by its ID", "by thread ID", "using its ID", "by
 * message and attachment IDs", and "identified by its ID" or "specified by its ID", with the commas
 * around it. Never where it orders or filters rather than finds ("sorted by ID").
 */
const BY_ITS_ID =
  /(,?\s+(?:identified|specified))?\s+(?<!\b(?:sorted|ordered|filterable|filtered|filtering)\s+)(?:by|using)\s+(?:its\s+|their\s+|the\s+)?(?:[a-z]+\s+(?:and\s+[a-z]+\s+)?)?IDs?\b(,)?/g;

/**
 * One {@link BY_ITS_ID} taken out, or left where the ID is one of the things a tool finds by, which a
 * person can give the others of: "by its ID or name", "by its channel ID and timestamp", "by their IDs
 * (or a specified unique property)", "by ID, email, name, or other text". An "and" that goes on to
 * what the tool does is not one of them: "by ID and removes it from messages".
 */
function withoutFindingById(
  found: string,
  named: string | undefined,
  comma: string | undefined,
  at: number,
  sentence: string,
): string {
  const rest = sentence.slice(at + found.length);
  const oneOfSeveral = comma
    ? /^\s+(?!\w+ing\b)[^,.]+,/.test(rest)
    : /^\s*\(?or\b|^\s+and\s+(?!\w+(?:s|ing)\b)/.test(rest);
  if (oneOfSeveral) return found;
  // "policy, identified by its ID, from" reads "policy from".
  return named?.startsWith(",") ? "" : (comma ?? "");
}

/**
 * Whether a word in capitals is a word said loudly ("DELETES", "PENDING") or a name written that way
 * (ID, CRM, HTML, IMAP). Five letters or more is a word, but for the few longer names vendors use;
 * four or fewer is a name, but for the few short words they capitalise. Both lists are what Composio's
 * Gmail, GitHub, HubSpot, Slack, Google Calendar, Google Drive and Notion descriptions use.
 */
function shouted(word: string): boolean {
  return word.length >= 5 ? !LONG_NAMES.has(word) : SHORT_WORDS.has(word);
}
const LONG_NAMES = new Set([
  "ASCII",
  "CNAME",
  "GRAPHQL",
  "HTTPS",
  "LICENSE",
  "OAUTH",
  "README",
  "SARIF",
]);
const SHORT_WORDS = new Set([
  "ALL",
  "ANY",
  "CALL",
  "MUST",
  "NEW",
  "NOT",
  "NOTE",
  "ONLY",
  "TASK",
]);
