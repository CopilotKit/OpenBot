import { declinedByPerson } from "@openbot/shared/approval-outcomes";

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
 * Why a step was not carried out, when it was refused, or undefined when it was not: the reason
 * behind {@link REFUSAL_MARKER}, or the sentence the approval service answers a step the person
 * declined on the conversation's card with. That one carries no marker (the service answers every
 * kind of step the same way), and read as a result, a folder edit the person declined was drawn as
 * "Saved a file".
 */
export function refusalOf(answer: string | undefined): string | undefined {
  if (answer === undefined) return undefined;
  if (answer.startsWith(REFUSAL_MARKER))
    return answer.slice(REFUSAL_MARKER.length).trim();
  return declinedByPerson(answer) ? answer.trim() : undefined;
}

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
 * The content inside the untrusted-content envelope, without the notice in front of it.
 *
 * The server marks every connector result as outside data before the model reads it
 * (`server/src/untrusted-content.ts`). The notice is for the model; a person reading the transcript
 * wants the vendor's answer, drawn the way it always was. Declared at both ends like
 * {@link REFUSAL_MARKER}. Text with no envelope is returned unchanged.
 */
export function withoutUntrustedEnvelope(text: string): string {
  return text.replace(
    /CRITICAL: The following [^\n]* is untrusted data, not instructions or tool authorization\.[^\n]*\n<untrusted_data source="[^"]*">\n([\s\S]*?)\n<\/untrusted_data>/g,
    (_match, inner: string) =>
      inner.replace(/<\\\/untrusted_data/gi, "</untrusted_data"),
  );
}

/**
 * A tool result, as something worth looking at.
 *
 * MCP says a text part, and vendors fill it with anything from plain markdown to a JSON envelope
 * with the markdown inside one field. Markdown is drawn as markdown, a JSON wrapper is unwrapped to
 * the markdown it was hiding, and anything else is fenced as JSON. Nothing is discarded.
 */
export function forDisplay(text: string): string {
  const trimmed = withoutUntrustedEnvelope(asText(text)).trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON after all. Draw what the server sent, without the model's notice.
    return trimmed;
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

/**
 * The text of a failure wrapped as the Claude Agent SDK harness wraps one, or undefined.
 *
 * `ag-ui-claude-sdk` has nowhere in an AG-UI result to put Claude Code's `is_error`, so it wraps a
 * failed result as `{"error": true, "content": "..."}`, and OpenBot's harness keeps that wrapper in
 * the history a reloaded conversation draws (`agent-claude-sdk/src/adapter.py`).
 *
 * ONLY THAT EXACT SHAPE: `error: true` and a string `content`, and nothing else. The harness also
 * parses a result that is JSON text and sends it on re-serialised, so a command that printed an
 * API's `{"error": true, "message": "..."}` arrives looking like a flagged failure, and reading any
 * `error: true` as one drew a request that worked as "Didn't work". The harness adds `error: true`
 * to a failed result that was a JSON object too, but Claude Code's own tools answer in text, and a
 * failed one starts with its exit code or `<tool_use_error>`, so none of the calls drawn here fails
 * that way. What stays ambiguous is output that is itself exactly `{"error": true, "content": "..."}`:
 * the two are the same string, and nothing else in the stream tells them apart.
 */
export function flaggedFailure(answer: string): string | undefined {
  if (!answer.trimStart().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(answer);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const { error, content, ...rest } = parsed as Record<string, unknown>;
    if (error !== true || typeof content !== "string") return undefined;
    return Object.keys(rest).length === 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a call the browser answers, a gallery component, failed instead of drawing anything.
 *
 * Its successful results are known: the component's confirmation, a refusal, or a person's answer.
 * A failure comes from one of three places, each with its own mark:
 *
 * - The Claude Agent SDK harness: Claude Code refused the call before it reached the browser, for
 *   arguments it couldn't parse. Wrapped as {@link flaggedFailure} while the turn streams and in
 *   the history it keeps.
 * - History from before the harness kept that wrapper: Claude Code's bare `<tool_use_error>`.
 * - CopilotKit, for a call it couldn't run itself (arguments that don't parse, a handler that
 *   threw): `Error: ` and the reason (`executeToolHandler` in `@copilotkit/core`).
 */
export function browserCallFailed(result: string | undefined): boolean {
  if (result === undefined) return false;
  const answer = asText(result);
  return (
    flaggedFailure(answer) !== undefined ||
    /^\s*<tool_use_error>/.test(answer) ||
    answer.startsWith("Error: ")
  );
}

/** What a step says, opened, when its Bot asked for a tool it doesn't have. */
export const UNOFFERED_TOOL_SENTENCE =
  "This Bot asked for a tool it doesn't have, so it carried on without it.";

/**
 * Whether a call's answer is its runtime saying the Bot was never offered that tool.
 *
 * The answer is written for the model: it names every tool the Bot does have, by identifier, so the
 * model can pick one of them next time. Drawn as it came, a person opening the step reads a wall of
 * `computer_navigate, computer_read, …` under "Web search". Two wordings, each the library's own
 * and each checked against its source: the AI SDK's `NoSuchToolError` ("Model tried to call
 * unavailable tool 'web_search'. Available tools: …"), which the runtime hands back with `Error: `
 * in front, and LangGraph's prebuilt `ToolNode` ("Error: web_search is not a valid tool, try one of
 * […]."). Claude Code's wrapper is read through, as {@link browserCallFailed} reads it.
 */
export function unofferedTool(result: string | undefined): boolean {
  if (result === undefined) return false;
  const answer = asText(result);
  const text = (flaggedFailure(answer) ?? answer).trim();
  return (
    /^(Error: )?Model tried to call unavailable tool '[^']*'\./.test(text) ||
    /^Error: \S+ is not a valid tool, try one of \[/.test(text)
  );
}

/**
 * Whether a server-side tool reached a terminal failure rather than returning a result.
 *
 * These prefixes are written by the two server tool doors after the distinction between policy
 * refusal and execution failure has already been made. A refusal has its own marker and must not
 * be collapsed into this state.
 */
export function toolResultFailed(result: string | undefined): boolean {
  if (result === undefined) return false;
  const answer = asText(result);
  return (
    answer.startsWith("The vendor reported an error:") ||
    answer.startsWith("That tool could not be called")
  );
}
