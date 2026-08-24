import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { serve } from "bun";
import OpenAI from "openai";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { toProviderMessages } from "./history";

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
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) {
  console.error(
    "MANAGED_AGENT_TOKEN is not set. This process holds a model credential and will not start without a token for OpenBot's server.",
  );
  process.exit(1);
}
/**
 * Which model drives the Bot.
 *
 * `gpt-5.5` works through `/v1/chat/completions`, which is the API this file uses.
 *
 * `gpt-5.6-*` models require the Responses API for tool use and cannot be used by this
 * chat-completions streaming loop.
 */
const MODEL = process.env.BOT_MODEL ?? "gpt-5.5";
/*
 * Refuse a model this file cannot use, rather than discover it one tool call at a time.
 *
 * `gpt-5.6-*` rejects function tools on `/v1/chat/completions`: "To use function tools, use
 * /v1/responses or set reasoning_effort to 'none'." The provider answers with an error, this Bot
 * ends the run, and the person sees no reply and no reason. Silence is the worst failure available
 * here, and it is what a single mistaken `BOT_MODEL` produced: every tool-using turn stopped dead
 * while the Bot looked healthy.
 *
 * Startup is where a deployment can act on it, which is the same posture as the token check above.
 */
if (/^gpt-5\.[6-9]|^gpt-[6-9]/.test(MODEL)) {
  console.error(
    `BOT_MODEL=${MODEL} cannot be used by this Bot. It speaks /v1/chat/completions directly, and ` +
      "that endpoint refuses function tools for this model, so every tool call would fail with no " +
      "reply. Use gpt-5.5, or the framework Bot on port 4201, which speaks the Responses API.",
  );
  process.exit(1);
}

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

/**
 * The key that model is answered with, checked at startup rather than on the first conversation.
 *
 * Without the check the Bot starts, answers the healthcheck, and then fails every run, so the
 * compose healthcheck reports a Bot that cannot answer as healthy. The LangGraph Bot already
 * refuses to start without its provider's key, and this file already refuses without its token
 * above; the model key was the one configuration that escaped the same posture. A missing key
 * should fail in front of whoever is deploying, not in front of whoever is asking.
 */
const BUILT_IN_SMOKE_MODE = process.env.OPENBOT_BUILT_IN_SMOKE_MODE === "1";
if (BUILT_IN_SMOKE_MODE && process.env.NODE_ENV === "production") {
  console.error(
    "OPENBOT_BUILT_IN_SMOKE_MODE is local-only and cannot be enabled in production.",
  );
  process.exit(1);
}

const API_KEY = process.env.OPENAI_API_KEY?.trim();
if (!BUILT_IN_SMOKE_MODE && !API_KEY) {
  console.error(
    "OPENAI_API_KEY is not set. This Bot cannot answer without a model.",
  );
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: API_KEY ?? "smoke-mode-does-not-call-a-provider",
  baseURL: BASE_URL,
});

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
        if (BUILT_IN_SMOKE_MODE) {
          const messageId = `msg_${input.runId}`;
          send({
            type: "TEXT_MESSAGE_START",
            messageId,
            role: "assistant",
          } as BaseEvent);
          send({
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: "OPENBOT_BUILT_IN_SAFE_SMOKE_OK",
          } as BaseEvent);
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
          send({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          return;
        }

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
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }
      const input = (await request.json()) as RunAgentInput;
      return runAgent(input);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-bot listening on http://localhost:${PORT}/ag-ui`);
