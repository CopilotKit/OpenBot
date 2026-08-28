/**
 * What the server puts in front of a refused call's reason.
 *
 * Written out here rather than imported, because this crosses a network: the server's copy travels
 * in a tool result and this one reads it, the same way a status code is declared at both ends. It
 * must match `REFUSAL_MARKER` in `server/src/plugins/tools.ts`.
 *
 * The alternative is guessing a refusal from its wording, which breaks the first time an
 * administrator rephrases a policy message, and fails silently by drawing a refusal as a result.
 */
export const REFUSAL_MARKER = "Refused.";

/**
 * The tool's own answer, out of whatever the transcript is carrying it in.
 *
 * A tool returns a string and the runtime puts it in a message as JSON, so what arrives here is that
 * string encoded: quotes around the whole thing, and every quote inside it escaped. Drawn as-is, a
 * refusal reads `"This deployment's policy does not allow that: ... the rule \"mcp.server ...`, with
 * the escapes on screen.
 *
 * It also breaks more than the look. `REFUSAL_MARKER` is matched against the start of this text, and
 * an encoded string starts with a quote, so a refusal is drawn as an ordinary result: the one thing
 * the marker exists to prevent.
 *
 * Only a JSON string is unwrapped. An object or an array is a vendor's envelope, which is
 * {@link forDisplay}'s job, and anything that is not JSON at all is already what it says.
 */
export function asText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('"')) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

/**
 * A tool result, as something worth looking at.
 *
 * MCP says a text part, and vendors fill it with anything from plain markdown to a JSON envelope
 * with the markdown inside one field. Markdown is drawn as markdown, a JSON wrapper is unwrapped to
 * the markdown it was hiding, and anything else is fenced as JSON. Nothing is discarded.
 */
export function forDisplay(text: string): string {
  const trimmed = asText(text).trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON after all. Draw what the server sent.
    return text;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    // The field carrying the answer, told apart from the ones carrying bookkeeping: Slack sends
    // `{ results, pagination_info }`. The rest is kept below rather than dropped.
    const markdown = entries
      .filter(
        ([, value]) =>
          typeof value === "string" &&
          (value.includes("\n#") || value.startsWith("#")),
      )
      .sort((a, b) => String(b[1]).length - String(a[1]).length)[0];

    if (markdown) {
      const rest = entries.filter(([key]) => key !== markdown[0]);
      const body = String(markdown[1]);
      if (rest.length === 0) return body;
      return `${body}\n\n\`\`\`json\n${JSON.stringify(
        Object.fromEntries(rest),
        null,
        2,
      )}\n\`\`\``;
    }
  }

  return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
}

/**
 * Whether a server-side tool's result begins with the phrase that means it went ahead.
 *
 * TWO CALLERS AND ONE RULE, because they had two. A tool that runs on the server reaches the
 * transcript as text meant for a model, so the only thing the renderer can read an outcome out of is
 * the wording — and the wording arrives JSON-encoded, which is why this decodes before it matches.
 *
 * The awkward case is a result that is neither a string nor absent. `message_bot` treated that as
 * success and `ask_person` treated it as a refusal, for the same situation, and the handoff's own
 * comments say which way round is worse: a boundary that held drawn as a Bot getting on with it.
 * So anything unrecognisable is not success. Absent is left alone, because a call still running has
 * no result yet and the caller decides that from its status.
 */
export function saidItWentAhead(result: unknown, marker: string): boolean {
  if (result === undefined) return true;
  if (typeof result !== "string") return false;
  return asText(result).startsWith(marker);
}
