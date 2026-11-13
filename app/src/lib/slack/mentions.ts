import { asText, withoutUntrustedEnvelope } from "@/lib/plugins/tool-result";

/**
 * Slack's mention markup, shown the way Slack shows it: as names.
 *
 * Slack stores a mention as an id in angle brackets (`<@U0123ABC>`, `<#C0123ABC|general>`, `<!here>`)
 * and its own apps swap in the name when they draw a message. A Bot that reads or posts a Slack
 * message gets the stored form, and quotes it: "I posted `Test message for <@U0E2EALEX0>.`". A
 * person reading that sees an id where Slack would have shown "@Alex Clarke".
 *
 * So a Bot's text shows every mention as a name. The name comes from the mention itself when it
 * carries one (`<#C0123|general>`), else from what this conversation's Slack steps returned (a user
 * lookup names each id), and when neither knows, from a word: "@someone", "a Slack channel". Never
 * the id.
 *
 * Only prose and inline code change. A code block keeps its text exactly, as a code block should.
 */

/** Every id this conversation's Slack steps named, to what Slack would show for it. */
export type SlackNames = ReadonlyMap<string, string>;

export const NO_SLACK_NAMES: SlackNames = new Map();

/** Who an unnamed person is. */
const SOMEONE = "@someone";
/** Where an unnamed channel is. */
const A_CHANNEL = "a Slack channel";
/** An unnamed user group. */
const A_GROUP = "@a group";

/**
 * Slack's ids: a letter for the kind, then capitals and digits. Users are U or W (Enterprise Grid),
 * channels C, private channels G, user groups S.
 */
const USER_ID = /^[UW][A-Z0-9]{2,}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;
const GROUP_ID = /^S[A-Z0-9]{2,}$/;

/**
 * One mention: `<@U…>`, `<@U…|label>`, `<#C…>`, `<#C…|label>`, `<!here>`, `<!channel>`,
 * `<!everyone>`, `<!subteam^S…>` and `<!subteam^S…|@label>`. Global, so callers reset `lastIndex`
 * by using `replace`.
 */
const MENTION =
  /<(@[UW][A-Z0-9]{2,}|#[CG][A-Z0-9]{2,}|!(?:here|channel|everyone)|!subteam\^S[A-Z0-9]{2,})(?:\|([^>\n]*))?>/g;

function asLabel(prefix: string, name: string): string {
  const bare = name.trim().replace(/^[@#]/, "");
  return bare ? `${prefix}${bare}` : "";
}

/** The text with every Slack mention in it shown as a name. */
export function slackMentionsAsNames(text: string, names: SlackNames): string {
  if (!text.includes("<")) return text;
  return text.replace(MENTION, (_whole, target: string, label?: string) => {
    const kind = target[0];
    const rest = target.slice(1);
    if (kind === "@") {
      return (
        asLabel("@", names.get(rest) ?? "") ||
        asLabel("@", label ?? "") ||
        SOMEONE
      );
    }
    if (kind === "#") {
      return (
        asLabel("#", label ?? "") ||
        asLabel("#", names.get(rest) ?? "") ||
        A_CHANNEL
      );
    }
    // `!`: a broadcast, or a user group.
    if (rest.startsWith("subteam^")) {
      const id = rest.slice("subteam^".length);
      return (
        asLabel("@", label ?? "") ||
        asLabel("@", names.get(id) ?? "") ||
        A_GROUP
      );
    }
    return `@${rest}`;
  });
}

/** The JSON a Slack step answered with, out of the envelope the transcript carries it in. */
function answerOf(result: string | undefined): unknown {
  if (!result) return undefined;
  const text = withoutUntrustedEnvelope(asText(result));
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** What Slack would show for a person: their full name, else their display name, else their handle. */
function personName(person: Record<string, unknown>): string | undefined {
  const profile =
    person.profile && typeof person.profile === "object"
      ? (person.profile as Record<string, unknown>)
      : {};
  return (
    text(person.real_name) ??
    text(profile.real_name) ??
    text(profile.display_name) ??
    text(person.display_name) ??
    text(person.name)
  );
}

/** Every id-to-name pair anywhere in a Slack answer: people, channels, user groups. */
function collect(value: unknown, names: Map<string, string>, depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, names, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  if (id && USER_ID.test(id)) {
    const name = personName(record);
    if (name) names.set(id, name);
  } else if (id && CHANNEL_ID.test(id)) {
    const name = text(record.name);
    if (name) names.set(id, name);
  } else if (id && GROUP_ID.test(id)) {
    const name = text(record.handle) ?? text(record.name);
    if (name) names.set(id, name);
  }
  // A message names its author beside the id: `{ user: "U…", user_profile: { real_name } }`.
  if (
    typeof record.user === "string" &&
    USER_ID.test(record.user) &&
    record.user_profile &&
    typeof record.user_profile === "object"
  ) {
    const name = personName(record.user_profile as Record<string, unknown>);
    if (name && !names.has(record.user)) names.set(record.user, name);
  }
  for (const child of Object.values(record)) collect(child, names, depth + 1);
}

/** Every id this conversation's Slack steps named. Steps of any other app are not read. */
export function slackNamesIn(
  steps: readonly {
    toolCall: { function: { name: string } };
    result?: string;
  }[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const step of steps) {
    if (!/slack/i.test(step.toolCall.function.name)) continue;
    collect(answerOf(step.result), names);
  }
  return names;
}

/** The part of a markdown tree this reads. */
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/**
 * `<!here>` looks like raw HTML to markdown (a declaration): inside a sentence it arrives as an
 * inline `html` node, and at the start of a line it opens an HTML block that runs to the end of it.
 */
const BROADCAST_FIRST =
  /^<!(?:here|channel|everyone|subteam\^S[A-Z0-9]{2,})(?:\|[^>\n]*)?>/;

/** Containers whose children are blocks, where an HTML block stands in for a paragraph. */
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem"]);

/**
 * A remark plugin that shows Slack mentions as names in text and inline code. Code blocks are left
 * exactly as written.
 *
 * THE NAMES ARE ITS OPTIONS, NOT SOMETHING IT CLOSES OVER. Streamdown keeps one processor per set of
 * plugins and keys it by each plugin's function name and the JSON of its options. A plugin that held
 * the names in a closure has the same key for every conversation, so the first processor built, often
 * one with no names at all, was reused and every mention became "@someone". As an option, the names
 * are part of the key.
 */
export function remarkSlackMentions(options?: {
  names?: readonly (readonly [string, string])[];
}) {
  const names: SlackNames = new Map(options?.names ?? []);
  const walk = (node: MarkdownNode, parent?: MarkdownNode) => {
    if (
      (node.type === "text" || node.type === "inlineCode") &&
      node.value !== undefined
    ) {
      node.value = slackMentionsAsNames(node.value, names);
      return;
    }
    if (
      node.type === "html" &&
      node.value !== undefined &&
      BROADCAST_FIRST.test(node.value.trim())
    ) {
      const shown = slackMentionsAsNames(node.value.trim(), names);
      if (parent && BLOCK_PARENTS.has(parent.type)) {
        node.type = "paragraph";
        node.children = [{ type: "text", value: shown }];
        delete node.value;
      } else {
        node.type = "text";
        node.value = shown;
      }
      return;
    }
    if (node.type === "code") return;
    for (const child of node.children ?? []) walk(child, node);
  };
  return (tree: MarkdownNode) => walk(tree);
}
