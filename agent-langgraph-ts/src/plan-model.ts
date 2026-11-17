/**
 * A plan's model, reached through the engine that holds the plan: a ChatGPT plan through
 * agent-langgraph-agui at its root, a Claude plan through agent-claude-sdk at `/model`.
 *
 * A CLAUDE PLAN, as plan-model.ts reaches it for built-in Bots. The plan token never leaves the
 * Claude engine; the Claude Agent SDK makes every call. Its query is kept between a step's tool call
 * and that call's result, so every call of a run, and the next run on the same thread, goes under
 * one thread id per (Bot, thread) (`claudeThreadId`). A stopped run whose query is answering or
 * waiting on a call cancels it at `/model/cancel`; a run that hands a call to the surface does not,
 * since the query waits for that result.
 *
 * A CHATGPT PLAN, below.
 *
 * A plan token is a bearer for the Codex backend, and the only maintained client for it is
 * LangChain's Python `_ChatOpenAICodex`, which agent-langgraph-agui already runs, token store and
 * refresh included. So this engine runs the graph and every model call goes to that harness, the
 * same way the server's built-in Bots on a ChatGPT plan reach it (`PlanModel` in
 * server/src/agents/plan-model.ts): one AG-UI run per model call, at the harness's root.
 *
 * THE REQUEST, AS plan-model.ts SENDS IT. The conversation without its system turns; the system
 * turns as `context` ("Built-in Bot instructions"), which the harness puts back in front of the
 * thread as system messages; the step's tools as AG-UI client tools, so the harness hands every call
 * back instead of running it; `forwardedProps.openbotModelOnly`, `openbotBotId`, and
 * `openbotModel` when a model was chosen; a fresh thread id per call, since the harness keeps no
 * state between runs; the deployment's token in `x-openbot-agent-token`. On a step with no tools
 * (the last step) no tools go, and `openbotAnswerOnly` says so.
 *
 * THE ANSWER. Only the text and tool-call events are read, as plan-model.ts reads them; a snapshot
 * of the harness's own state is not this run's. A RUN_ERROR ends the call with the harness's words,
 * code and category (`HarnessRunError`), which this engine relays unchanged.
 */
import { createHash, randomUUID } from "node:crypto";
import { HttpAgent } from "@ag-ui/client";
import type {
  Message as AguiMessage,
  BaseEvent,
  RunAgentInput,
  Tool,
} from "@ag-ui/core";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { HarnessRunError } from "./errors.ts";

export type PlanHarnessFields = {
  /** Whose plan: "chatgpt" (the default) or "claude". */
  plan?: "chatgpt" | "claude";
  /** The plan engine's AG-UI run: agent-langgraph-agui's root, agent-claude-sdk's `/model`. */
  url: string;
  /** That engine's `MANAGED_AGENT_TOKEN`. */
  token: string;
  /** The plan model the server chose, or "" for the plan's own default. */
  model?: string;
  effort?: string;
  botId?: string;
  /**
   * The run's thread. On a Claude plan every call goes under one query per (Bot, thread)
   * (`claudeThreadId`); a ChatGPT plan's calls each go under a fresh thread.
   */
  threadId?: string;
  /** The run's stop, which cancels a Claude plan's query. */
  signal?: AbortSignal;
  /** For tests: the fetch the AG-UI client uses. */
  fetch?: typeof fetch;
};

/** One Claude query per Bot and thread, as plan-model.ts names it on the server. */
export function claudeThreadId(botId: string, threadId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([botId, threadId]))
    .digest("hex");
}

export interface PlanHarnessCallOptions extends BaseChatModelCallOptions {
  tools?: Tool[];
}

/** The events a model call is made of; everything else the harness sends is its own state. */
const READ = new Set([
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "RUN_ERROR",
  "RUN_FINISHED",
]);

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/** A user turn's content as plan-model.ts sends it: one string, or parts when it holds an image. */
function userContent(content: unknown): AguiMessage["content"] {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content)
    ? (content as Record<string, unknown>[])
    : [];
  if (parts.every((part) => part?.type === "text"))
    return parts.map((part) => String(part.text ?? "")).join("\n\n");
  return parts.flatMap((part): Record<string, unknown>[] => {
    if (part?.type === "text")
      return [{ type: "text", text: String(part.text ?? "") }];
    const url =
      part?.type === "image_url"
        ? String((part.image_url as { url?: unknown } | undefined)?.url ?? "")
        : "";
    if (!url) return [];
    const data = /^data:([^;]+);base64,(.*)$/s.exec(url);
    return [
      {
        type: "image",
        source: data
          ? { type: "data", value: data[2], mimeType: data[1] }
          : { type: "url", value: url, mimeType: "image/png" },
      },
    ];
  }) as never;
}

/** The conversation and the instructions, split as plan-model.ts splits them. */
export function planRequest(messages: BaseMessage[]): {
  messages: AguiMessage[];
  context: { description: string; value: string }[];
} {
  const conversation: AguiMessage[] = [];
  const context: { description: string; value: string }[] = [];
  for (const [index, message] of messages.entries()) {
    const id = `prompt-${index}`;
    const type = message.getType();
    if (type === "system") {
      context.push({
        description: "Built-in Bot instructions",
        value: text(message.content),
      });
    } else if (type === "human") {
      conversation.push({
        id,
        role: "user",
        content: userContent(message.content),
      } as AguiMessage);
    } else if (type === "ai") {
      const calls =
        (
          message as {
            tool_calls?: { id?: string; name: string; args: unknown }[];
          }
        ).tool_calls ?? [];
      conversation.push({
        id,
        role: "assistant",
        content: text(message.content),
        ...(calls.length
          ? {
              toolCalls: calls.map((call) => ({
                id: call.id ?? randomUUID(),
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args ?? {}),
                },
              })),
            }
          : {}),
      } as AguiMessage);
    } else if (type === "tool") {
      const callId = (message as { tool_call_id?: string }).tool_call_id ?? "";
      conversation.push({
        id: `result-${callId}`,
        role: "tool",
        toolCallId: callId,
        content:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
      } as AguiMessage);
    }
  }
  return { messages: conversation, context };
}

/** LangChain's tool shapes as AG-UI client tools. */
export function aguiTools(tools: BindToolsInput[]): Tool[] {
  return tools.map((tool) => {
    const fn = convertToOpenAITool(tool as never).function;
    return {
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    };
  });
}

export class PlanHarnessChatModel extends BaseChatModel<PlanHarnessCallOptions> {
  readonly fields: PlanHarnessFields;
  /** A call is streaming from the Claude query. */
  private streaming = false;
  /** Calls the Claude query made that wait on their results. */
  private pending = 0;
  /** The Claude query's thread, which every call of the run goes under. */
  private readonly query?: string;

  constructor(fields: PlanHarnessFields) {
    super({});
    this.fields = fields;
    if (fields.plan !== "claude" || fields.threadId === undefined) return;
    const query = claudeThreadId(fields.botId ?? "", fields.threadId);
    this.query = query;
    fields.signal?.addEventListener("abort", () => void this.cancel(query), {
      once: true,
    });
  }

  _llmType(): string {
    // Asked by the base class's constructor too, before `fields` is set.
    return `openbot-${this.fields?.plan ?? "chatgpt"}-plan`;
  }

  /** Stop the Claude query this run is answering on, if it is answering or waiting. */
  private async cancel(threadId: string): Promise<void> {
    if (!this.streaming && this.pending === 0) return;
    try {
      const response = await (this.fields.fetch ?? fetch)(
        `${this.fields.url.replace(/\/+$/, "")}/cancel`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: {
            "content-type": "application/json",
            "x-openbot-agent-token": this.fields.token,
          },
          body: JSON.stringify({ threadId }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      // No request details: the address and token are the deployment's. The Claude engine's own
      // query timeout is the last cleanup.
      console.error("The Claude plan's model query could not be cancelled.");
    }
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<PlanHarnessCallOptions>,
  ) {
    return this.withConfig({
      ...kwargs,
      tools: aguiTools(tools),
    } as Partial<PlanHarnessCallOptions>);
  }

  /** The AG-UI run one model call is. */
  runInput(
    messages: BaseMessage[],
    options: PlanHarnessCallOptions,
  ): RunAgentInput {
    const answerOnly = options.tool_choice === "none";
    const { messages: conversation, context } = planRequest(messages);
    const { model, effort, botId } = this.fields;
    return {
      threadId: this.query ?? `plan-${randomUUID()}`,
      runId: randomUUID(),
      messages: conversation,
      tools: answerOnly ? [] : (options.tools ?? []),
      context,
      state: null,
      forwardedProps: {
        openbotModelOnly: true,
        ...(botId ? { openbotBotId: botId } : {}),
        ...(model
          ? {
              openbotModel: {
                model,
                ...(effort ? { reasoningEffort: effort } : {}),
              },
            }
          : {}),
        ...(answerOnly ? { openbotAnswerOnly: true } : {}),
      },
    } as RunAgentInput;
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const input = this.runInput(messages, options);
    const offered = new Set((input.tools ?? []).map((tool) => tool.name));
    const userFetch = this.fields.fetch ?? fetch;
    const agent = new HttpAgent({
      url: this.fields.url,
      headers: { "x-openbot-agent-token": this.fields.token },
      fetch: (url, init) =>
        userFetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            ...(options.signal ? [options.signal] : []),
          ]),
        }),
    });

    const queue: (BaseEvent | { failed: unknown } | { done: true })[] = [];
    let wake: (() => void) | undefined;
    const push = (item: (typeof queue)[number]) => {
      queue.push(item);
      wake?.();
    };
    const subscription = agent.run(input).subscribe({
      next: (event) => push(event),
      error: (error) => push({ failed: error }),
      complete: () => push({ done: true }),
    });

    const calls = new Map<string, { index: number; ended: boolean }>();
    let finished = false;
    this.streaming = true;
    this.pending = 0;
    try {
      for (;;) {
        if (queue.length === 0)
          await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        const item = queue.shift();
        if (!item) continue;
        if ("failed" in item) throw item.failed;
        if ("done" in item) {
          if (!finished)
            throw new Error(
              "The plan harness disconnected before completing its response.",
            );
          return;
        }
        const event = item as BaseEvent & Record<string, unknown>;
        if (!READ.has(event.type)) continue;
        switch (event.type) {
          case "TEXT_MESSAGE_CONTENT": {
            const delta = String(event.delta ?? "");
            const chunk = new ChatGenerationChunk({
              text: delta,
              message: new AIMessageChunk({ content: delta }),
            });
            yield chunk;
            await runManager?.handleLLMNewToken(delta);
            break;
          }
          case "TOOL_CALL_START": {
            const name = String(event.toolCallName);
            if (!offered.has(name))
              throw new Error(
                `The plan harness attempted an unoffered tool: ${name}`,
              );
            const id = String(event.toolCallId);
            const index = calls.size;
            calls.set(id, { index, ended: false });
            yield new ChatGenerationChunk({
              text: "",
              message: new AIMessageChunk({
                content: "",
                tool_call_chunks: [
                  { id, name, args: "", index, type: "tool_call_chunk" },
                ],
              }),
            });
            break;
          }
          case "TOOL_CALL_ARGS": {
            const call = calls.get(String(event.toolCallId));
            if (!call || call.ended)
              throw new Error("Unexpected plan tool arguments.");
            yield new ChatGenerationChunk({
              text: "",
              message: new AIMessageChunk({
                content: "",
                tool_call_chunks: [
                  {
                    args: String(event.delta ?? ""),
                    index: call.index,
                    type: "tool_call_chunk",
                  },
                ],
              }),
            });
            break;
          }
          case "TOOL_CALL_END": {
            const call = calls.get(String(event.toolCallId));
            if (!call || call.ended)
              throw new Error("Unexpected plan tool completion.");
            call.ended = true;
            break;
          }
          case "RUN_ERROR": {
            const category = (
              event.metadata as { errorCategory?: unknown } | undefined
            )?.errorCategory;
            throw new HarnessRunError(
              String(event.message ?? ""),
              typeof event.code === "string" ? event.code : undefined,
              typeof category === "string" ? category : undefined,
            );
          }
          case "RUN_FINISHED": {
            if ([...calls.values()].some((call) => !call.ended))
              throw new Error("The plan harness ended during a tool call.");
            finished = true;
            this.pending = calls.size;
            break;
          }
        }
      }
    } finally {
      this.streaming = false;
      subscription.unsubscribe();
      if (!finished) agent.abortRun();
    }
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let whole: ChatGenerationChunk | undefined;
    for await (const chunk of this._streamResponseChunks(
      messages,
      options,
      runManager,
    )) {
      whole = whole ? whole.concat(chunk) : chunk;
    }
    const message = whole?.message ?? new AIMessageChunk({ content: "" });
    return { generations: [{ text: whole?.text ?? "", message }] };
  }
}
