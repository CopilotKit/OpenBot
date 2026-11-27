/**
 * Room in the conversation: what keeps a long run inside the model's window.
 *
 * A Bot on a long task piles up tool results. Its instructions and tools stay at about ten thousand
 * tokens; nearly everything else a late step sends is old tool output, and nothing trimmed it, so a
 * run of a few hundred steps grew past the model's window and the provider refused it. The rule here
 * is the one Claude itself uses (Anthropic's context editing, `clear_tool_uses_20250919`):
 *
 *  1. On Claude, Anthropic clears old tool results on its side. Every request carries the edit and
 *     its beta, and the whole history. A proxy in front of Claude that refuses the field is
 *     remembered for the life of the process and gets rule 2 instead.
 *  2. On every other provider the same rule runs here, before each model call: past 100,000 input
 *     tokens, every tool result but the last 10 becomes a short note naming its call, if that frees
 *     at least 20,000 tokens. `search_tools` results are never cleared, because they say which tools
 *     the Bot may call. Each call keeps a result, so no provider sees an orphan.
 *  3. If the provider still refuses as too long, the same call is retried, cleared harder, up to
 *     three times, and the stage that worked is where the rest of the run starts. A run is one step
 *     and its recalls, since every other call ends it for the caller to answer, so the stage is
 *     kept by thread (`startingStage` in run.ts) and the run that carries the turn on starts there.
 *     The person's next message starts the thread at stage 0 again.
 *
 * Only what is SENT is cut. The thread the run holds, and hands back, stays whole, and
 * `recall_earlier_results` reads a cleared result back from it.
 *
 * Summarising old turns on the provider's side (Anthropic's `compact_20260112`, OpenAI's compaction
 * item) is left out on purpose: its block would have to be carried in the stored thread, which does
 * not keep it, so every step would summarise again.
 */
import type { Tool } from "@ag-ui/core";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ContextOverflowError } from "@langchain/core/errors";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { RECALL_EARLIER_RESULTS } from "../../shared/recall-earlier-results.ts";
import { SEARCH_TOOLS } from "../../shared/tool-search.ts";
import { links, providerWords, statusOf } from "./errors.ts";

/** Past this many input tokens, old tool results are cleared. */
export const CLEAR_TRIGGER_TOKENS = 100_000;
/**
 * The tool results that stay whole. Ten rather than Anthropic's default of three: a Bot is told to
 * batch about five reads at once, and a step must see the whole of its latest batch.
 */
export const KEEP_RESULTS = 10;
/** Clearing breaks the provider's prompt cache, so it is done only when it frees this much. */
export const CLEAR_AT_LEAST_TOKENS = 20_000;
/** Results never cleared: what `search_tools` found is the list of tools the Bot may call. */
export const NEVER_CLEARED = [SEARCH_TOOLS];

/**
 * Characters per token for the estimate. Measured on a real request a provider refused as too long:
 * tool output is dense with JSON, ids and numbers, which tokenise far tighter than prose.
 */
export const CHARS_PER_TOKEN = 2.3;
/** An image, counted as about what a provider charges for a screenshot. */
export const IMAGE_TOKENS = 1_600;

export const CONTEXT_EDITING_BETA = "context-management-2025-06-27";
/** Anthropic's context editing, with the same numbers as the local rule. */
export const CONTEXT_EDITING = {
  edits: [
    {
      type: "clear_tool_uses_20250919" as const,
      trigger: { type: "input_tokens" as const, value: CLEAR_TRIGGER_TOKENS },
      keep: { type: "tool_uses" as const, value: KEEP_RESULTS },
      clear_at_least: {
        type: "input_tokens" as const,
        value: CLEAR_AT_LEAST_TOKENS,
      },
      exclude_tools: NEVER_CLEARED,
    },
  ],
};

export const RECALL = RECALL_EARLIER_RESULTS;

/** What a cleared result says in its place. */
export function clearedNote(callId: string): string {
  return `[This result was cleared to make room in the conversation. Call ${RECALL} with call_id "${callId}" to read it again.]`;
}

export const CUT_NOTE =
  "[The rest of this message was cut to make room in the conversation.]";
/** How much of an earlier message a hard retry keeps. */
export const CUT_AT = 2_000;

type Stage = {
  keep: number;
  trigger: number;
  atLeast: number;
  /** Cut earlier messages, old reasoning and long earlier call arguments too. */
  cut: boolean;
};

/**
 * Stage 0 is every call's rule. Stages 1 to 3 are the retries after a provider still refused the
 * request as too long, each harder than the last, as Claude Code retries.
 */
export const STAGES: readonly Stage[] = [
  {
    keep: KEEP_RESULTS,
    trigger: CLEAR_TRIGGER_TOKENS,
    atLeast: CLEAR_AT_LEAST_TOKENS,
    cut: false,
  },
  { keep: 3, trigger: 0, atLeast: 0, cut: false },
  { keep: 1, trigger: 0, atLeast: 0, cut: true },
  { keep: 0, trigger: 0, atLeast: 0, cut: true },
];
export const LAST_STAGE = STAGES.length - 1;

type Part = Record<string, unknown>;

function isImage(part: Part): boolean {
  return (
    part.type === "image_url" ||
    part.type === "image" ||
    part.type === "input_image"
  );
}

function hasToolUse(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((part) => (part as Part)?.type === "tool_use")
  );
}

/** A message's size, as characters plus images. */
function sizeOf(message: BaseMessage): { chars: number; images: number } {
  let chars = 0;
  let images = 0;
  const content = message.content as unknown;
  if (typeof content === "string") chars += content.length;
  else if (Array.isArray(content)) {
    for (const part of content as Part[]) {
      if (!part || typeof part !== "object") continue;
      if (isImage(part)) images += 1;
      else if (typeof part.text === "string") chars += part.text.length;
      else chars += JSON.stringify(part).length;
    }
  }
  const calls = (message as AIMessage).tool_calls;
  // A call carried in the content as a tool_use block is counted there already.
  if (calls?.length && !hasToolUse(content))
    chars += JSON.stringify(calls).length;
  return { chars, images };
}

function tokensOf(chars: number, images = 0): number {
  return chars / CHARS_PER_TOKEN + images * IMAGE_TOKENS;
}

/** About how many input tokens these messages, plus `extraChars` of tools, come to. */
export function estimateTokens(
  messages: readonly BaseMessage[],
  extraChars = 0,
): number {
  let chars = extraChars;
  let images = 0;
  for (const message of messages) {
    const size = sizeOf(message);
    chars += size.chars;
    images += size.images;
  }
  return tokensOf(chars, images);
}

/** Every call's tool name and arguments, by call id. */
function callsById(
  messages: readonly BaseMessage[],
): Map<string, { name: string; args: unknown }> {
  const calls = new Map<string, { name: string; args: unknown }>();
  for (const message of messages) {
    if (message.getType() !== "ai") continue;
    for (const call of (message as AIMessage).tool_calls ?? []) {
      if (call.id) calls.set(call.id, { name: call.name, args: call.args });
    }
  }
  return calls;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof (part as Part)?.text === "string"
          ? String((part as Part).text)
          : JSON.stringify(part),
      )
      .join("\n");
  return JSON.stringify(content ?? "");
}

/**
 * The messages with every tool result but the last `keep` replaced by its note, once they pass
 * `trigger` tokens and only if that frees `atLeast`. The same array when nothing is cleared.
 */
export function clearOldResults(
  messages: readonly BaseMessage[],
  stage: Pick<Stage, "keep" | "trigger" | "atLeast">,
  extraChars = 0,
): readonly BaseMessage[] {
  if (stage.trigger > 0 && estimateTokens(messages, extraChars) < stage.trigger)
    return messages;
  const names = callsById(messages);
  const results: number[] = [];
  for (const [index, message] of messages.entries())
    if (message.getType() === "tool") results.push(index);
  const kept = new Set(stage.keep > 0 ? results.slice(-stage.keep) : []);
  const replaced = new Map<number, ToolMessage>();
  let freed = 0;
  for (const index of results) {
    if (kept.has(index)) continue;
    const result = messages[index] as ToolMessage;
    const name = result.name ?? names.get(result.tool_call_id)?.name ?? "";
    if (NEVER_CLEARED.includes(name)) continue;
    const note = clearedNote(result.tool_call_id);
    const size = sizeOf(result);
    const saved = tokensOf(size.chars, size.images) - tokensOf(note.length);
    // A result already as short as its note (or already cleared) gains nothing.
    if (saved <= 0) continue;
    freed += saved;
    replaced.set(
      index,
      new ToolMessage({
        ...(result.id ? { id: result.id } : {}),
        content: note,
        tool_call_id: result.tool_call_id,
        ...(result.name ? { name: result.name } : {}),
        ...(result.status ? { status: result.status } : {}),
      }),
    );
  }
  if (replaced.size === 0 || freed < stage.atLeast) return messages;
  return messages.map((message, index) => replaced.get(index) ?? message);
}

function cutText(text: string): string {
  return text.length > CUT_AT
    ? `${text.slice(0, CUT_AT)}\n\n${CUT_NOTE}`
    : text;
}

const REASONING = new Set(["thinking", "redacted_thinking", "reasoning"]);

function cutContent(content: unknown, dropReasoning: boolean): unknown {
  if (typeof content === "string") return cutText(content);
  if (!Array.isArray(content)) return content;
  return (content as Part[])
    .filter((part) => !(dropReasoning && REASONING.has(String(part?.type))))
    .map((part) =>
      part?.type === "text" && typeof part.text === "string"
        ? { ...part, text: cutText(part.text) }
        : part?.type === "tool_use" &&
            JSON.stringify(part.input ?? {}).length > CUT_AT
          ? { ...part, input: {} }
          : part,
    );
}

/**
 * The hard retry's cuts, to everything before the person's latest message: each message's text to
 * its first 2,000 characters, old reasoning dropped, and call arguments over 2,000 characters
 * emptied. The system prompt, the latest message and everything after it are kept as they are.
 */
export function cutEarlier(
  messages: readonly BaseMessage[],
): readonly BaseMessage[] {
  let latest = -1;
  for (const [index, message] of messages.entries())
    if (message.getType() === "human") latest = index;
  return messages.map((message, index) => {
    if (index >= latest) return message;
    const type = message.getType();
    if (type === "human")
      return new HumanMessage({
        ...(message.id ? { id: message.id } : {}),
        content: cutContent(message.content, false) as never,
      });
    if (type !== "ai") return message;
    const ai = message as AIMessage;
    return new AIMessage({
      ...(ai.id ? { id: ai.id } : {}),
      content: cutContent(ai.content, true) as never,
      tool_calls: (ai.tool_calls ?? []).map((call) =>
        JSON.stringify(call.args ?? {}).length > CUT_AT
          ? { ...call, args: {} }
          : call,
      ),
      additional_kwargs: ai.additional_kwargs,
      response_metadata: ai.response_metadata,
    });
  });
}

/**
 * What one model call is sent at this stage. With Anthropic clearing on its side, the first try is
 * the whole thread; every retry is cleared here as well.
 */
export function roomFor(
  messages: readonly BaseMessage[],
  options: { stage: number; clearsOnServer: boolean; extraChars?: number },
): BaseMessage[] {
  if (options.stage === 0 && options.clearsOnServer) return [...messages];
  const stage: Stage = STAGES[Math.min(options.stage, LAST_STAGE)];
  const cleared = clearOldResults(messages, stage, options.extraChars ?? 0);
  return [...(stage.cut ? cutEarlier(cleared) : cleared)];
}

// ---- Anthropic's context editing ----

/** The addresses that refused context editing, kept for the life of the process. */
const editingRefused = new Set<string>();

function addressOf(model: ChatAnthropic): string {
  return model.apiUrl?.trim() || "https://api.anthropic.com";
}

/** A Claude model with Anthropic's context editing on, unless its address has refused it. */
export function withContextEditing(model: ChatAnthropic): ChatAnthropic {
  if (editingRefused.has(addressOf(model))) return model;
  model.contextManagement = CONTEXT_EDITING;
  model.betas = [...(model.betas ?? []), CONTEXT_EDITING_BETA];
  return model;
}

/** Whether this model's provider clears old tool results itself. */
export function clearsOnServer(model: BaseChatModel): boolean {
  return model instanceof ChatAnthropic && !!model.contextManagement;
}

/** Turn context editing off for this model, and for every later one at its address. */
export function stopContextEditing(model: BaseChatModel): void {
  if (!(model instanceof ChatAnthropic)) return;
  editingRefused.add(addressOf(model));
  model.contextManagement = undefined;
  model.betas = (model.betas ?? []).filter(
    (beta) => beta !== CONTEXT_EDITING_BETA,
  );
}

function wordsOf(link: Record<string, unknown>): string {
  return `${providerWords(link)} ${String(link.message ?? "")}`;
}

/** A proxy in front of Claude that does not take context editing: a 4xx naming it. */
export function refusesContextEditing(error: unknown): boolean {
  return links(error).some((link) => {
    const status = statusOf(link);
    return (
      status !== undefined &&
      status < 500 &&
      /context[_-]management/i.test(wordsOf(link))
    );
  });
}

/**
 * Every provider's way of saying the request is longer than the model takes: Anthropic's "prompt
 * is too long", OpenAI's `context_length_exceeded` and "maximum context length", Gemini's "input
 * token count ... exceeds", and a 413 or "request too large" from any provider or proxy.
 */
const TOO_LONG =
  /prompt is too long|context_length_exceeded|maximum context length|context window|input token count.*exceeds|exceeds the maximum number of tokens|too many (?:input )?tokens|request[_ ]too[_ ]large|request entity too large|input is too long/i;

/** The provider's words when it refused the request as too long, or undefined. */
export function tooLong(error: unknown): string | undefined {
  const chain = links(error);
  const matched = chain.some(
    (link) =>
      ContextOverflowError.isInstance(link) ||
      statusOf(link) === 413 ||
      TOO_LONG.test(wordsOf(link)) ||
      TOO_LONG.test(JSON.stringify(link.error ?? "")),
  );
  if (!matched) return undefined;
  // The words of the provider's own answer, which LangChain keeps as the cause of its wrapper.
  const answered = chain.find((link) => statusOf(link) !== undefined);
  return providerWords(answered ?? chain[0] ?? {});
}

// ---- recall_earlier_results ----

/** The most a recall returns, so reading a result back cannot fill the window again. */
export const RECALL_LIMIT = 20_000;
const RECALL_MATCHES = 3;

export const RECALL_TOOL: Tool = {
  name: RECALL,
  description:
    "Read again a tool result that was cleared from this conversation to make room. Give the call_id a cleared result names to get that result whole, or a few words to find the most recent earlier results whose call or answer contains them all.",
  parameters: {
    type: "object",
    properties: {
      call_id: {
        type: "string",
        description: "The call_id a cleared result names.",
      },
      words: {
        type: "string",
        description:
          "A few words the earlier call or its result contains, to find it by.",
      },
    },
  },
};

/**
 * The run's tools, with recall added for a Bot that has any. A caller that offers its own recall
 * keeps it, and answers it (`answersRecall` in run.ts).
 */
export function withRecall(tools: readonly Tool[]): Tool[] {
  if (tools.length === 0 || tools.some((tool) => tool.name === RECALL))
    return [...tools];
  return [...tools, RECALL_TOOL];
}

/**
 * A recall, answered from the whole thread the run holds: one result by its call id, or the three
 * most recent whose tool name, arguments or output hold every word.
 */
export function recall(
  messages: readonly BaseMessage[],
  args: Record<string, unknown>,
): string {
  const calls = callsById(messages);
  const results = messages
    .filter((message) => message.getType() === "tool")
    .map((message) => {
      const result = message as ToolMessage;
      const call = calls.get(result.tool_call_id);
      return {
        id: result.tool_call_id,
        name: call?.name ?? result.name ?? "a tool",
        args: call?.args,
        text: resultText(result.content),
      };
    })
    // A recall's own answer is a copy, not an earlier result.
    .filter((result) => result.name !== RECALL);
  const heading = (result: (typeof results)[number]) =>
    `Result of ${result.name} (call_id "${result.id}"):\n${result.text}`;

  const callId = typeof args.call_id === "string" ? args.call_id.trim() : "";
  const words =
    typeof args.words === "string"
      ? args.words.toLowerCase().split(/\s+/).filter(Boolean)
      : [];
  let found: typeof results;
  if (callId) {
    found = results.filter((result) => result.id === callId);
    if (found.length === 0)
      return `No earlier result in this conversation has call_id "${callId}".`;
  } else if (words.length) {
    found = results
      .filter((result) => {
        const haystack =
          `${result.name}\n${JSON.stringify(result.args ?? {})}\n${result.text}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .reverse()
      .slice(0, RECALL_MATCHES);
    if (found.length === 0)
      return `No earlier result in this conversation contains all of: ${words.join(" ")}.`;
  } else {
    return "Give the call_id a cleared result names, or a few words to look for.";
  }
  const text = found.map(heading).join("\n\n");
  return text.length > RECALL_LIMIT
    ? `${text.slice(0, RECALL_LIMIT)}\n\n[Cut here: what was recalled ran past ${RECALL_LIMIT.toLocaleString("en-US")} characters.]`
    : text;
}
