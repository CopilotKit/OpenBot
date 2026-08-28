/**
 * The prose in a streamed chunk, whichever API produced it.
 *
 * Its own module for the reason `history.ts` is: `index.ts` calls `serve()` at module scope, so
 * importing it to reach one pure function binds a port.
 *
 * Chat completions streams `content` as a string. The Responses API does not: `@langchain/openai`
 * turns every `response.output_text.delta` into a content block — `[{ type: "text", text, index }]` —
 * and a reasoning model puts its summary in that same array under a different type. Reading the
 * string shape alone is why a 5.6-tier Bot returned RUN_STARTED and RUN_FINISHED with nothing
 * between them.
 */

/** A content block as the integrations produce them. Only the two fields that decide text matter. */
interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * Text the person should see, and nothing else.
 *
 * Selected by block type rather than by "has a text field": reasoning summaries are the Bot's
 * private working, and a surface printing them would be showing the person something never meant
 * for them.
 */
export function textOfChunk(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const block = part as ContentBlock;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}
