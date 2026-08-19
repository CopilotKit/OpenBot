import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { serve } from "bun";
import { SYSTEM_PROMPT } from "../../shared/bot-prompt";

/**
 * The same Bot, on a framework.
 *
 * `agent-bot` is a proof of concept written against a model SDK; this process uses framework integrations while
 * keeping the same AG-UI endpoint contract.
 *
 * A Bot is a registry row pointing at an AG-UI endpoint, so adding a framework does not require
 * server changes.
 *
 * The model API stops being ours. `agent-bot` speaks `/v1/chat/completions` by hand, which is why
 * gpt-5.6 cannot be used there without rewriting its streaming loop: those models reject function
 * tools on that endpoint and require the Responses API. Here it is `useResponsesApi`, one line,
 * because the migration belongs to the people who maintain the integration.
 *
 * The tool loop still runs on the client, exactly as it does in `agent-bot`: a Bot's actions happen
 * on a browser the person is watching, and the surface remains the place that executes those tools.
 * The graph provides model orchestration without changing that contract.
 */

const PORT = Number.parseInt(process.env.PORT ?? "4201", 10);

/**
 * Which model drives this Bot, and from whom.
 *
 * The framework integration owns provider-specific HTTP and streaming details. The proof-of-concept Bot
 * speaks one provider's HTTP API
 * directly, so changing provider there means rewriting its streaming loop and its message
 * translation. Here it is a name and a key, because the integrations already exist and are
 * maintained by the people whose API it is.
 *
 * Each provider reads its own key. A deployment that only runs Anthropic never needs an OpenAI key,
 * which is the point of making this configurable rather than assuming one vendor.
 *
 * The default is unchanged so the two shipped Bots stay comparable out of the box.
 */
const PROVIDER = (process.env.BOT_PROVIDER ?? "openai").toLowerCase();
const MODEL = process.env.BOT_MODEL ?? defaultModelFor(PROVIDER);
/** OpenAI only. Its newer models require the Responses API, which the integration handles. */
const USE_RESPONSES_API = process.env.BOT_RESPONSES_API === "true";
/**
 * OpenAI only, and the same variable the API server reads for its built-in agents.
 *
 * Unset, `openai` means OpenAI. Set, it means any endpoint speaking that API: a gateway in front of
 * several providers, a proxy, or a model on hardware you control. The integration owns the HTTP, so
 * this is a base URL rather than another provider branch, and `BOT_MODEL` is sent verbatim because
 * an endpoint names its own catalogue.
 */
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL?.trim() || undefined;
/**
 * The same idea for the other two providers, under the names the API server already reads.
 *
 * Sharing the variable names is the point: one line moves the built-in agents and this Bot
 * together, and a deployment cannot end up with half of itself pointed somewhere else.
 */
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
const GOOGLE_BASE_URL =
  process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.trim() || undefined;

function defaultModelFor(provider: string): string {
  if (provider === "anthropic") return "claude-sonnet-4-5";
  if (provider === "google") return "gemini-2.5-flash";
  return "gpt-5.5";
}

/**
 * The key this provider needs, checked at startup rather than on the first run.
 *
 * Refusing to start matches the computer-token posture:
 * a missing key should fail in front of whoever is deploying, not as a conversation that errors in
 * front of somebody trying to use it.
 */
const KEY_VARIABLE: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};

const keyVariable = KEY_VARIABLE[PROVIDER];
if (!keyVariable) {
  console.error(
    `BOT_PROVIDER=${PROVIDER} is not one this Bot knows. Use openai, anthropic or google.`,
  );
  process.exit(1);
}
const API_KEY = process.env[keyVariable]?.trim();
if (!API_KEY) {
  console.error(
    `${keyVariable} is not set, and BOT_PROVIDER=${PROVIDER} needs it. This Bot cannot answer without a model.`,
  );
  process.exit(1);
}

/** Translate the conversation AG-UI carries into LangChain's message classes. */
function toLangChainMessages(input: RunAgentInput): BaseMessage[] {
  const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT)];

  for (const message of input.messages) {
    if (message.role === "user") {
      messages.push(new HumanMessage(String(message.content ?? "")));
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push(new SystemMessage(String(message.content ?? "")));
      continue;
    }
    if (message.role === "tool") {
      // Tool results are appended so the model can continue from the completed call.
      messages.push(
        new ToolMessage({
          tool_call_id: message.toolCallId,
          content: String(message.content ?? ""),
        }),
      );
      continue;
    }
    if (message.role === "assistant") {
      messages.push(
        new AIMessage({
          content: message.content ?? "",
          tool_calls:
            message.toolCalls?.map((call) => ({
              id: call.id,
              name: call.function.name,
              // LangChain wants parsed arguments where AG-UI carries the raw string. A call whose
              // arguments did not parse is passed as empty rather than dropped: the model needs to
              // see that it made the call, or it makes it again.
              args: parseArguments(call.function.arguments),
            })) ?? [],
        }),
      );
    }
  }

  return messages;
}

function parseArguments(raw: string): Record<string, unknown> {
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
 * Every tool comes from the caller. This service publishes none of its own, on purpose.
 *
 * Same rule as `agent-bot`: a new capability on the front end needs no change here.
 */
function toBoundTools(input: RunAgentInput) {
  if (!input.tools?.length) return [];
  return input.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
}

/**
 * The chat model, from whichever provider this deployment chose.
 *
 * Every one of these binds tools the same way and streams the same way, which is exactly why the
 * rest of this file does not know which one it got.
 */
function buildModel() {
  if (PROVIDER === "anthropic") {
    return new ChatAnthropic({
      model: MODEL,
      apiKey: API_KEY,
      streaming: true,
      ...(ANTHROPIC_BASE_URL ? { anthropicApiUrl: ANTHROPIC_BASE_URL } : {}),
    });
  }
  if (PROVIDER === "google") {
    return new ChatGoogleGenerativeAI({
      model: MODEL,
      apiKey: API_KEY,
      streaming: true,
      ...(GOOGLE_BASE_URL ? { baseUrl: GOOGLE_BASE_URL } : {}),
    });
  }
  return new ChatOpenAI({
    model: MODEL,
    apiKey: API_KEY,
    streaming: true,
    ...(OPENAI_BASE_URL ? { configuration: { baseURL: OPENAI_BASE_URL } } : {}),
    ...(USE_RESPONSES_API ? { useResponsesApi: true } : {}),
  });
}

/**
 * The graph.
 *
 * One node is enough while the tool loop lives on the client. The graph provides model orchestration
 * without changing the AG-UI contract.
 */
function buildGraph(input: RunAgentInput) {
  const model = buildModel();

  const tools = toBoundTools(input);
  const bound = tools.length > 0 ? model.bindTools(tools) : model;

  return new StateGraph(MessagesAnnotation)
    .addNode("answer", async (state) => ({
      messages: [await bound.invoke(state.messages)],
    }))
    .addEdge(START, "answer")
    .addEdge("answer", END)
    .compile();
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

      const messageId = `msg_${input.runId}`;
      let textOpen = false;

      try {
        const graph = buildGraph(input);
        const events = await graph.streamEvents(
          { messages: toLangChainMessages(input) },
          { version: "v2" },
        );

        // Accumulated rather than emitted per chunk, because a tool call's arguments arrive in
        // fragments and AG-UI wants one call. The framework hands back assembled `tool_calls` on the
        // final message, which is precisely the plumbing agent-bot does by hand.
        let finalMessage: AIMessage | null = null;

        for await (const event of events) {
          if (event.event === "on_chat_model_stream") {
            const chunk = event.data?.chunk as
              | { content?: unknown }
              | undefined;
            const text =
              typeof chunk?.content === "string" ? chunk.content : "";
            if (!text) continue;

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
              delta: text,
            } as BaseEvent);
          }

          if (event.event === "on_chat_model_end") {
            const output = event.data?.output as AIMessage | undefined;
            if (output) finalMessage = output;
          }
        }

        if (textOpen) {
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        }

        for (const call of finalMessage?.tool_calls ?? []) {
          send({
            type: "TOOL_CALL_START",
            toolCallId: call.id ?? `call_${input.runId}_${call.name}`,
            toolCallName: call.name,
            parentMessageId: messageId,
          } as BaseEvent);
          send({
            type: "TOOL_CALL_ARGS",
            toolCallId: call.id ?? `call_${input.runId}_${call.name}`,
            delta: JSON.stringify(call.args ?? {}),
          } as BaseEvent);
          send({
            type: "TOOL_CALL_END",
            toolCallId: call.id ?? `call_${input.runId}_${call.name}`,
          } as BaseEvent);
        }

        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error) {
        // A text message left open would strand the surface mid-message, so it is closed before the
        // error is reported. agent-bot has the same hazard and the same ordering.
        if (textOpen) {
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        }
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
      return Response.json({
        status: "ok",
        provider: PROVIDER,
        model: MODEL,
        framework: "langgraph",
        responsesApi: USE_RESPONSES_API,
      });
    }

    if (url.pathname === "/ag-ui" && request.method === "POST") {
      const input = (await request.json()) as RunAgentInput;
      return runAgent(input);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-langgraph listening on http://localhost:${PORT}/ag-ui`);
