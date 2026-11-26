/**
 * The thread the server sent, as the model is shown it.
 *
 * Each run answers from the whole thread the server sends and from nothing this process remembers
 * (agent-langgraph-agui's `whole_thread.py`): there is no checkpoint across runs, so a restart, a
 * second replica or a grant changed under the same message id all read the same.
 *
 * Two things happen here, in order:
 *  1. `sanitizeHistory` drops what a provider would refuse for ever: a tool call with no answer, an
 *     answer with no call, an empty assistant husk. A port of the server's own
 *     `sanitizeSeededHistory` (toolkit/src/history-sanitize.ts), rule for rule. A call OpenBot
 *     answered after a hand-back is answered by the `tool` message the next run carries, so it stays.
 *  2. The Bot's instructions are the thread's system messages, as for any AG-UI agent: every
 *     `system` (and `developer`) message, in the order the thread holds them, then the AG-UI context,
 *     as ONE system message at the top. One, because Anthropic takes one system prompt and refuses a
 *     system turn after a conversation turn; at the top, so the prompt is a stable cache prefix.
 *     Nothing private says what the instructions are: OpenBot sends the built-in Bot's whole prompt
 *     as system messages, exactly as it sends a connected Bot its standing role.
 */
import type { Context, Message } from "@ag-ui/core";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

/**
 * The id OpenBot gives a Bot's standing role (`standing-role:<bot id>`, `standingRoleMessage` in the
 * server). Read only for the Bot's id, which names a Claude plan's query (`claudeThreadId`): never
 * to decide what is an instruction.
 */
export const STANDING_ROLE_PREFIX = "standing-role:";

type ToolCallShape = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
  /**
   * The provider's opaque artefact for this call, as AG-UI carries it (`ToolCall.encryptedValue`,
   * sent as REASONING_ENCRYPTED_VALUE): Gemini's thought signature, which Gemini 3 refuses a call
   * sent back without.
   */
  encryptedValue?: string;
};
type AnyMessage = Message & {
  content?: unknown;
  toolCalls?: ToolCallShape[];
  toolCallId?: string;
};

function isSilent(message: AnyMessage): boolean {
  const content = message.content;
  if (content === undefined || content === null) return true;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

/**
 * Refuse to re-present a conversation the model API will reject. See the module comment, and the
 * server's `sanitizeSeededHistory`, which this follows rule for rule:
 *  1. A call is answered by the first later result carrying its id before the next user message.
 *  2. An assistant message keeps only its answered calls; with none left and nothing said, it goes.
 *  3. A result survives only as THE answer to a surviving call.
 * Order is kept, ids are never changed, and an untouched message is the same object.
 */
export function sanitizeHistory(
  history: readonly Message[],
  answeredElsewhere: ReadonlySet<string> = new Set(),
): Message[] {
  const messages = history as readonly AnyMessage[];
  const boundaryAfter: number[] = new Array(messages.length).fill(
    messages.length,
  );
  for (
    let index = messages.length - 1, next = messages.length;
    index >= 0;
    index -= 1
  ) {
    boundaryAfter[index] = next;
    if (messages[index]?.role === "user") next = index;
  }

  const callAt = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    for (const call of message.toolCalls ?? []) {
      if (!callAt.has(call.id)) callAt.set(call.id, index);
    }
  }
  const answerAt = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    const id = message.toolCallId;
    if (id === undefined || answerAt.has(id)) continue;
    const called = callAt.get(id);
    if (called === undefined || index <= called) continue;
    if (index >= (boundaryAfter[called] ?? messages.length)) continue;
    answerAt.set(id, index);
  }

  const surviving = new Set<string>();
  const kept = messages.map((message): AnyMessage | undefined => {
    const calls = message.toolCalls;
    if (calls === undefined) return message;
    const answered = calls.filter(
      (call) => answeredElsewhere.has(call.id) || answerAt.has(call.id),
    );
    for (const call of answered) surviving.add(call.id);
    if (answered.length === 0 && isSilent(message)) return undefined;
    if (answered.length === calls.length) return message;
    if (answered.length > 0)
      return { ...message, toolCalls: answered } as AnyMessage;
    const { toolCalls: _dropped, ...rest } = message;
    return rest as AnyMessage;
  });

  return kept.filter((message, index): message is AnyMessage => {
    if (message === undefined) return false;
    const id = message.toolCallId;
    if (id === undefined) return true;
    return surviving.has(id) && answerAt.get(id) === index;
  }) as Message[];
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  return "";
}

type ImageSource = { type?: string; value?: string; mimeType?: string };

/** A user message's parts as LangChain content: text, and images as data or URLs. */
function userContent(content: unknown): string | Record<string, unknown>[] {
  if (typeof content === "string" || !Array.isArray(content))
    return contentText(content);
  const parts: Record<string, unknown>[] = [];
  for (const part of content as Record<string, unknown>[]) {
    if (part?.type === "text") {
      parts.push({ type: "text", text: String(part.text ?? "") });
      continue;
    }
    // AG-UI 1.x: `{ type: "image", source: { type: "data" | "url", value, mimeType } }`.
    if (
      part?.type === "image" &&
      part.source &&
      typeof part.source === "object"
    ) {
      const source = part.source as ImageSource;
      const url =
        source.type === "url"
          ? source.value
          : `data:${source.mimeType ?? "image/png"};base64,${source.value ?? ""}`;
      if (url) parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    // AG-UI 0.x: `{ type: "binary", mimeType, data | url }`.
    if (
      part?.type === "binary" &&
      typeof part.mimeType === "string" &&
      part.mimeType.startsWith("image/")
    ) {
      const url =
        typeof part.url === "string"
          ? part.url
          : `data:${part.mimeType};base64,${String(part.data ?? "")}`;
      parts.push({ type: "image_url", image_url: { url } });
    }
  }
  return parts;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

/**
 * The model's messages for this run: one system message, then the sanitised thread.
 *
 * The system message is every system message in the thread, in order, then each AG-UI context entry.
 * A context entry that only repeats a system message is not said twice: OpenBot sends a Bot's
 * quoted personal memory both ways, so that an agent reading only one of them still sees it.
 */
export function modelMessages(
  thread: readonly Message[],
  context: readonly Context[] = [],
): BaseMessage[] {
  const messages = sanitizeHistory(thread) as AnyMessage[];
  const system: string[] = [];
  const conversation: BaseMessage[] = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      system.push(contentText(message.content));
      continue;
    }
    if (message.role === "user") {
      conversation.push(
        new HumanMessage({
          id: message.id,
          content: userContent(message.content) as never,
        }),
      );
      continue;
    }
    if (message.role === "assistant") {
      const said = contentText(message.content);
      const calls = (message.toolCalls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        args: parseArgs(call.function.arguments),
        type: "tool_call" as const,
        // @langchain/google sends it back on the call's part; every other provider ignores it.
        ...(typeof call.encryptedValue === "string" && call.encryptedValue
          ? { thoughtSignature: call.encryptedValue }
          : {}),
      }));
      // An assistant turn that said nothing and called nothing is refused by some providers.
      if (!said && calls.length === 0) continue;
      conversation.push(
        new AIMessage({ id: message.id, content: said, tool_calls: calls }),
      );
      continue;
    }
    if (message.role === "tool" && message.toolCallId) {
      conversation.push(
        new ToolMessage({
          id: message.id,
          content: contentText(message.content),
          tool_call_id: message.toolCallId,
        }),
      );
    }
    // Reasoning and activity rows are the surface's, not the model's.
  }

  const said = new Set(system.map((part) => part.trim()));
  for (const entry of context) {
    if (said.has(String(entry.value ?? "").trim())) continue;
    system.push(`${entry.description}\n${entry.value}`);
  }

  const prompt = system
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  return prompt
    ? [new SystemMessage({ content: prompt }), ...conversation]
    : conversation;
}

/**
 * The thread as Gemini (@langchain/google) is sent it: an earlier call kept as a call.
 *
 * FOUND IN @langchain/google's converter: an assistant message read from the thread (its words as a
 * string, its calls in `tool_calls`) goes through the converter's older path, which sends only the
 * words. Its calls were left out, so Gemini was sent each result with no call before it, which it
 * refuses. A step used to stay inside one run, where the message is Gemini's own parts; now every
 * call is answered in the next run, from the thread. Marked as standard content, the converter
 * sends each call as a `functionCall` part with its thought signature. With no words it has no
 * content at all, since Gemini refuses an empty text part.
 */
export function forGemini(messages: readonly BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (message.getType() !== "ai") return message;
    const ai = message as AIMessage;
    if (!ai.tool_calls?.length || typeof ai.content !== "string") return ai;
    return new AIMessage({
      id: ai.id,
      content: ai.content ? ai.content : [],
      tool_calls: ai.tool_calls,
      additional_kwargs: ai.additional_kwargs,
      response_metadata: { ...ai.response_metadata, output_version: "v1" },
    });
  });
}
