/**
 * What a person said, in the shape a chat model reads. Read by both Bots.
 *
 * A message is a string until somebody attaches a file. Then the composer sends a list of parts —
 * what the person typed, then the file — and `copilot.ts` resolves each file before the run leaves
 * the server: a text file becomes a text part carrying its contents, an image an `image` part
 * carrying its bytes. Both Bots read `content` with `String()`, which for that list is
 * `[object Object],[object Object]`, so that is what the model was sent in place of the question and
 * the file both.
 *
 * ONE DECLARATION FOR BOTH BOTS, for the reason `bot-prompt.ts` gives for `NO_ANSWER_CAME`. The two
 * shapes returned are the ones OpenAI's chat completions take, and LangChain's OpenAI, Anthropic and
 * Google converters read the same two blocks, so one answer serves every Bot alike and they cannot
 * drift.
 *
 * A part neither shape can carry is NAMED, not dropped, which is the rule `resultText` in
 * `server/src/plugins/mcp.ts` follows for a tool result: a model told "[audio]" can say something was
 * attached that it cannot hear, and a model handed nothing answers as though nothing was attached.
 */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export function userContent(content: unknown): string | UserContentPart[] {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part): UserContentPart => {
    const item = (part ?? {}) as {
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; value?: unknown; mimeType?: unknown } | null;
    };
    if (item.type === "text" && typeof item.text === "string") {
      return { type: "text", text: item.text };
    }
    const source = item.source;
    // The mime type reaches a `data:` URL sent to model providers. Allowlisted to images, and the
    // bytes are shape-checked after whitespace is removed, so `text/html`, quotes, an empty value,
    // and padding with no data (`=` or `==`) degrade to a named part instead of a provider payload.
    // The URL is built from that stripped value, so a wrapped line cannot ride into what the model
    // reads.
    const base64 =
      typeof source?.value === "string" ? source.value.replace(/\s/g, "") : "";
    if (
      item.type === "image" &&
      source?.type === "data" &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(base64) &&
      typeof source.mimeType === "string" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        source.mimeType.trim().toLowerCase(),
      )
    ) {
      return {
        type: "image_url",
        image_url: {
          url: `data:${source.mimeType.trim().toLowerCase()};base64,${base64}`,
        },
      };
    }
    const name =
      typeof item.type === "string" && item.type ? item.type : "unknown";
    return { type: "text", text: `[${name}]` };
  });
}
