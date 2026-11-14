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
 *
 * Read from both sides. The browser draws a Bot's text with these; the server uses the same names
 * when a task's result is posted in the conversation that asked for it, whose own steps looked
 * nobody up (`labelSlackMentions`).
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

/** What sits inside the notice the server puts around an app's answer, or the text itself. */
const ENVELOPE =
  /<untrusted_data source="[^"]*">\n([\s\S]*?)\n<\/untrusted_data>/;

/** The JSON a Slack step answered with, with or without the server's notice around it. */
function answerOf(result: string | undefined): unknown {
  if (!result) return undefined;
  const text = ENVELOPE.exec(result)?.[1] ?? result;
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

/** Every id these steps' Slack answers named. Steps of any other app are not read. */
export function slackNamesFrom(
  steps: readonly { name: string; answer?: string }[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const step of steps) {
    if (!/slack/i.test(step.name)) continue;
    collect(answerOf(step.answer), names);
  }
  return names;
}

/** A fenced code block, which keeps its text exactly. */
const FENCE = /(^|\n)(```|~~~)[\s\S]*?(?:\n\2[^\n]*|$)/g;

/**
 * The text with each Slack mention carrying its name, the way Slack itself writes one it has a
 * label for: `<@U0E2EALEX0>` becomes `<@U0E2EALEX0|Alex Clarke>`. For text that leaves the
 * conversation whose steps named the id, so whoever draws it later still shows the name, through
 * the same {@link slackMentionsAsNames}. A mention that already has a label, an id nothing named,
 * a broadcast and anything in a fenced code block are left exactly as written.
 */
export function labelSlackMentions(text: string, names: SlackNames): string {
  if (names.size === 0 || !text.includes("<")) return text;
  const label = (prose: string) =>
    prose.replace(MENTION, (whole, target: string, existing?: string) => {
      if (existing?.trim()) return whole;
      const kind = target[0];
      const id = target.startsWith("!subteam^")
        ? target.slice("!subteam^".length)
        : target.slice(1);
      if (kind === "!" && !target.startsWith("!subteam^")) return whole;
      const name = names
        .get(id)
        ?.trim()
        .replace(/[|>\n]/g, " ");
      if (!name) return whole;
      return `<${target}|${kind === "!" ? `@${name.replace(/^@/, "")}` : name}>`;
    });
  let out = "";
  let at = 0;
  for (const fence of text.matchAll(FENCE)) {
    out += label(text.slice(at, fence.index)) + fence[0];
    at = fence.index + fence[0].length;
  }
  return out + label(text.slice(at));
}
