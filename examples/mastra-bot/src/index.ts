import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { serve } from "bun";

/**
 * A Bot written in Mastra.
 *
 * This and the LangGraph example share no OpenBot-specific code beyond the AG-UI protocol. Tools
 * arrive in `input.tools` from the surface, so both drive a governed browser they have no direct
 * access to.
 *
 * `@ag-ui/mastra` exists and is the client side, it lets a CopilotKit runtime call a Mastra agent. A
 * Bot here has to be the server, so this emits AG-UI directly with `@ag-ui/encoder`, the same shape
 * as `agent-bot` and the LangGraph example.
 */

const PORT = Number.parseInt(process.env.PORT ?? "4400", 10);
const MODEL = process.env.BOT_MODEL ?? "gpt-5.6-terra";
/**
 * `gpt-5.6-*` rejects function tools on `/v1/chat/completions` and needs the Responses API, which
 * this provider exposes as `openai.responses`. Inferred from the model so setting `BOT_MODEL` alone
 * cannot produce a Bot that starts, looks healthy, and fails on its first tool call.
 */
const NEEDS_RESPONSES_API =
  process.env.BOT_RESPONSES_API === "true" ||
  /^gpt-5\.[6-9]|^gpt-[6-9]/.test(MODEL);

const bot = new Agent({
  name: "OpenBot Mastra coworker",
  instructions:
    "You are a Bot running on Mastra inside OpenBot. You have a real web browser available through " +
    "the tools you are given.\n\n" +
    // Same guard as the LangGraph example: page contents require a fresh tool result.
    "NEVER state what a page contains unless you have just read it with a tool in this conversation. " +
    "You cannot know a page's contents from memory. If you have not read it, call the tool first, " +
    "and report exactly what the tool returned.",
  model: NEEDS_RESPONSES_API ? openai.responses(MODEL) : openai(MODEL),
});

/**
 * The conversation, in the shape Mastra takes.
 *
 * The whole history, including tool results. A tool call and its result must come back as a matched
 * pair in the AI-SDK shapes Mastra passes through, or the model has no evidence its own action worked.
 */
function toMastraMessages(input: RunAgentInput) {
  const messages: Array<Record<string, unknown>> = [];

  for (const message of input.messages ?? []) {
    const content = typeof message.content === "string" ? message.content : "";

    if (message.role === "user" && content) {
      messages.push({ role: "user", content });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = (
        message as {
          toolCalls?: {
            id: string;
            function: { name: string; arguments: string };
          }[];
        }
      ).toolCalls;
      if (toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: toolCalls.map((call) => ({
            type: "tool-call",
            toolCallId: call.id,
            toolName: call.function.name,
            args: safeArgs(call.function.arguments),
          })),
        });
      } else if (content) {
        messages.push({ role: "assistant", content });
      }
      continue;
    }

    if (message.role === "tool") {
      const toolCallId = (message as { toolCallId?: string }).toolCallId;
      if (toolCallId) {
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: (message as { toolName?: string }).toolName ?? "tool",
              result: content,
            },
          ],
        });
      }
    }
  }

  return messages;
}

/** Tool arguments arrive as a JSON string, and a malformed one must not kill the run. */
function safeArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The tools the surface granted, in the Vercel-AI-SDK shape Mastra passes through.
 *
 * `execute` is deliberately absent: nothing runs here. The tool loop belongs to the client, which is
 * what puts every call through OpenBot's policy gateway instead of this process.
 */
function toMastraTools(input: RunAgentInput) {
  const tools: Record<string, unknown> = {};
  for (const tool of input.tools ?? []) {
    tools[tool.name] = {
      description: tool.description,
      parameters: tool.parameters,
    };
  }
  return tools;
}

async function runAgent(input: RunAgentInput): Promise<Response> {
  const encoder = new EventEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) =>
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);

      try {
        /*
         * Streamed, not generated. `generate` waits for the whole answer and hands it over in one
         * piece; `stream` exposes tokens as they arrive, and tool-call promises resolve when it
         * finishes.
         */
        const result = await bot.stream(toMastraMessages(input) as never, {
          toolsets: { surface: toMastraTools(input) as never },
        });

        const messageId = `msg_${input.runId}`;

        // Opened on the first chunk rather than up front: a run that only calls a tool has no message,
        // and starting one leaves an empty bubble above the work.
        let started = false;
        for await (const delta of result.textStream) {
          if (!delta) continue;
          if (!started) {
            started = true;
            send({
              type: "TEXT_MESSAGE_START",
              messageId,
              role: "assistant",
            } as BaseEvent);
          }
          send({
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta,
          } as BaseEvent);
        }
        if (started) send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);

        for (const call of (await result.toolCalls) ?? []) {
          const toolCallId = call.toolCallId ?? `call_${crypto.randomUUID()}`;
          send({
            type: "TOOL_CALL_START",
            toolCallId,
            toolCallName: call.toolName,
            parentMessageId: messageId,
          } as BaseEvent);
          send({
            type: "TOOL_CALL_ARGS",
            toolCallId,
            delta: JSON.stringify(call.args ?? {}),
          } as BaseEvent);
          send({ type: "TOOL_CALL_END", toolCallId } as BaseEvent);
        }

        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error) {
        send({
          type: "RUN_ERROR",
          message: error instanceof Error ? error.message : "The agent failed.",
        } as BaseEvent);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", framework: "mastra" });
    }
    if (url.pathname === "/ag-ui" && request.method === "POST") {
      const input = (await request.json()) as RunAgentInput;
      return runAgent(input);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.info(
  `mastra-bot listening on http://localhost:${PORT}/ag-ui (model ${MODEL})`,
);
