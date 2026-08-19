import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { serve } from "bun";
import OpenAI from "openai";
import { SYSTEM_PROMPT } from "../../shared/bot-prompt";

/**
 * The built-in Bot is an AG-UI HTTP service registered the same way as any customer-provided Bot.
 *
 * It publishes no tools of its own. Every callable tool arrives in `input.tools`, forwarded by the
 * runtime from the surface registration.
 *
 * The loop runs on the client. When this emits a tool call it ends the run; the surface executes the
 * tool, appends the result, and starts a new run with the fuller conversation. That keeps the tool
 * running where its effects are visible to the person watching.
 */

const PORT = Number.parseInt(process.env.PORT ?? "4200", 10);
/**
 * Which model drives the Bot.
 *
 * `gpt-5.5` works through `/v1/chat/completions`, which is the API this file uses.
 *
 * `gpt-5.6-*` models require the Responses API for tool use and cannot be used by this
 * chat-completions streaming loop.
 */
const MODEL = process.env.BOT_MODEL ?? "gpt-5.5";

/**
 * Where that model is answered from.
 *
 * Unset, this is OpenAI. Set, it is any endpoint speaking the same `/v1/chat/completions` API: a
 * gateway in front of several providers, a proxy, or a model on hardware you control. Which is the
 * point of writing against that API by hand rather than against one company's URL.
 *
 * `BOT_MODEL` is sent verbatim, because an endpoint names its own catalogue.
 */
const BASE_URL = process.env.OPENAI_BASE_URL?.trim() || undefined;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: BASE_URL,
});

/** Translate the conversation AG-UI carries into the shape the model provider expects. */
function toProviderMessages(input: RunAgentInput) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  for (const message of input.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: String(message.content ?? "") });
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push({ role: "system", content: String(message.content ?? "") });
      continue;
    }
    if (message.role === "tool") {
      // Tool results are appended so the model can continue from the completed call.
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: String(message.content ?? ""),
      });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      }));
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return messages;
}

/** Every tool comes from the caller. This service publishes none of its own, on purpose. */
function toProviderTools(input: RunAgentInput) {
  if (!input.tools?.length) return undefined;
  return input.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
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
        const completion = await openai.chat.completions.create({
          model: MODEL,
          messages: toProviderMessages(input),
          tools: toProviderTools(input),
          stream: true,
        });

        const messageId = `msg_${input.runId}`;
        let textOpen = false;
        // Providers stream a tool call's arguments in fragments across many chunks, keyed only by
        // index. Buffering per index is what turns that back into one call the surface can run.
        const toolCalls = new Map<
          number,
          { id: string; name: string; args: string }
        >();

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            if (!textOpen) {
              send({
                type: "TEXT_MESSAGE_START",
                messageId,
                role: "assistant",
              } as BaseEvent);
              textOpen = true;
            }
            send({
              type: "TEXT_MESSAGE_CONTENT",
              messageId,
              delta: delta.content,
            } as BaseEvent);
          }

          for (const call of delta.tool_calls ?? []) {
            const existing = toolCalls.get(call.index) ?? {
              id: call.id ?? `call_${input.runId}_${call.index}`,
              name: "",
              args: "",
            };
            if (call.id) existing.id = call.id;
            if (call.function?.name) existing.name = call.function.name;
            if (call.function?.arguments)
              existing.args += call.function.arguments;
            toolCalls.set(call.index, existing);
          }
        }

        if (textOpen) {
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        }

        for (const call of toolCalls.values()) {
          send({
            type: "TOOL_CALL_START",
            toolCallId: call.id,
            toolCallName: call.name,
            parentMessageId: messageId,
          } as BaseEvent);
          send({
            type: "TOOL_CALL_ARGS",
            toolCallId: call.id,
            delta: call.args || "{}",
          } as BaseEvent);
          send({ type: "TOOL_CALL_END", toolCallId: call.id } as BaseEvent);
        }

        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error) {
        // Reported as a run error rather than a dropped connection, so the transcript can say what
        // went wrong. A stream that simply ends leaves the surface waiting forever with no reason.
        send({
          type: "RUN_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "The Bot could not answer.",
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
      return Response.json({ status: "ok", model: MODEL });
    }

    if (url.pathname === "/ag-ui" && request.method === "POST") {
      const input = (await request.json()) as RunAgentInput;
      return runAgent(input);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-bot listening on http://localhost:${PORT}/ag-ui`);
