import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import {
  AIMessage as AIMessageClass,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { serve } from "bun";

/**
 * A Bot written in LangGraph.
 *
 * This is a real LangGraph `StateGraph` with its own model client and tool loop. OpenBot knows it
 * only as an AG-UI endpoint URL.
 *
 * It is an AG-UI HTTP endpoint. One POST carrying a `RunAgentInput`, and
 * a stream of AG-UI events back. `@ag-ui/langgraph` is a client: it lets a CopilotKit
 * runtime talk to LangGraph Platform. What a Bot has to be here is the other end, a server, so this
 * emits the protocol directly with `@ag-ui/encoder`, the same way `agent-bot` does.
 *
 * Tools arrive in `input.tools` from the surface on every run, so this file never names
 * `computer_navigate` and still drives a governed browser.
 */

const PORT = Number.parseInt(process.env.PORT ?? "4300", 10);
const MODEL = process.env.BOT_MODEL ?? "gpt-5.5";
/**
 * `gpt-5.6-*` rejects function tools on `/v1/chat/completions` and needs the Responses API, which
 * this integration speaks. Inferred from the model so setting `BOT_MODEL` alone cannot produce a
 * Bot that starts, looks healthy, and fails on its first tool call.
 */
const USE_RESPONSES_API =
  process.env.BOT_RESPONSES_API === "true" ||
  /^gpt-5\.[6-9]|^gpt-[6-9]/.test(MODEL);

/**
 * The graph's state.
 *
 * Deliberately small. A bigger graph would prove less: the point is that a LangGraph agent works,
 * not that LangGraph can hold state.
 */
const BotState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

/** Turn the AG-UI conversation into LangChain messages. */
function toLangChainMessages(input: RunAgentInput): BaseMessage[] {
  const messages: BaseMessage[] = [
    new SystemMessage(
      "You are a Bot running on LangGraph inside OpenBot. You have a real web browser available " +
        "through the tools you are given.\n\n" +
        // Page contents must come from a fresh tool result, not from model memory.
        "NEVER state what a page contains unless you have just read it with a tool in this " +
        "conversation. You cannot know a page's contents from memory, and a plausible guess is a " +
        "wrong answer. If you have not read it, call the tool first. Report exactly what the tool " +
        "returned.",
    ),
  ];
  // Replay the whole conversation, including tool results. Tool calls and results must come back as
  // matched pairs so the model has evidence its action worked.
  for (const message of input.messages ?? []) {
    const content = typeof message.content === "string" ? message.content : "";
    const role = message.role;

    if (role === "user" && content) {
      messages.push(new HumanMessage(content));
      continue;
    }

    if (role === "assistant") {
      const toolCalls = (
        message as {
          toolCalls?: {
            id: string;
            function: { name: string; arguments: string };
          }[];
        }
      ).toolCalls;
      if (toolCalls?.length) {
        messages.push(
          new AIMessageClass({
            content: content ?? "",
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              name: call.function.name,
              args: safeArgs(call.function.arguments),
            })),
          }),
        );
      } else if (content) {
        messages.push(new AIMessageClass(content));
      }
      continue;
    }

    if (role === "tool") {
      const toolCallId = (message as { toolCallId?: string }).toolCallId;
      if (toolCallId) {
        messages.push(new ToolMessage({ content, tool_call_id: toolCallId }));
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

/** The tools the surface granted this run, in the shape LangChain binds. */
function toLangChainTools(input: RunAgentInput) {
  return (input.tools ?? []).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
}

function buildGraph(input: RunAgentInput) {
  // Stream tokens because a person is watching. With this off the model is asked for the whole answer,
  // the graph returns once it is finished, and the surface receives a single TEXT_MESSAGE_CONTENT
  // carrying all of it, so a six-hundred-word reply is a blank conversation for eight seconds and
  // then a wall of text. The tokens exist the whole time; nothing was passing them on.
  const model = new ChatOpenAI({
    model: MODEL,
    streaming: true,
    ...(USE_RESPONSES_API ? { useResponsesApi: true } : {}),
  });
  const tools = toLangChainTools(input);
  const bound = tools.length > 0 ? model.bindTools(tools) : model;

  return new StateGraph(BotState)
    .addNode("think", async (state) => {
      const reply = await bound.invoke(state.messages);
      return { messages: [reply] };
    })
    .addEdge(START, "think")
    .addEdge("think", END)
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

      console.info(
        `run ${input.runId}: ${(input.tools ?? []).length} tools granted: ${(input.tools ?? []).map((t) => t.name).join(", ") || "(none)"}`,
      );

      // A deliberate stall, for testing only. Set SLOW_MS to hold the stream open long enough to kill
      // this process mid-run and prove the server survives a customer's agent dying under it.
      const slowMs = Number.parseInt(process.env.SLOW_MS ?? "0", 10);
      if (slowMs > 0)
        await new Promise((resolve) => setTimeout(resolve, slowMs));

      try {
        const graph = buildGraph(input);
        const messageId = `msg_${input.runId}`;

        /*
         * Tokens are forwarded as they arrive.
         *
         * `graph.invoke` waits for the graph to finish, so the only thing it can report is the
         * finished answer. `streamEvents` reports what happens inside it, and `on_chat_model_stream`
         * is one chunk of the model's output, which is what AG-UI's TEXT_MESSAGE_CONTENT is for.
         *
         * `TEXT_MESSAGE_START` is sent on the first chunk rather than up front: a run that produces
         * only a tool call has no message at all, and opening one for it leaves an empty bubble above
         * the work.
         */
        let started = false;
        let last: AIMessage | undefined;

        for await (const event of graph.streamEvents(
          { messages: toLangChainMessages(input) },
          { version: "v2" },
        )) {
          if (event.event === "on_chat_model_stream") {
            const chunk = event.data?.chunk as AIMessage | undefined;
            const delta =
              typeof chunk?.content === "string"
                ? chunk.content
                : Array.isArray(chunk?.content)
                  ? chunk.content
                      .map((part) =>
                        typeof part === "string"
                          ? part
                          : ((part as { text?: string }).text ?? ""),
                      )
                      .join("")
                  : "";
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

          // The finished message, kept for its tool calls. Streaming the text does not change where
          // the tool loop runs, see below.
          if (event.event === "on_chat_model_end") {
            last = event.data?.output as AIMessage | undefined;
          }
        }

        if (started) send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);

        // The tool loop runs on the client, exactly as it does for the Bot in the box: the call is
        // emitted, this run ends, the surface executes it through the governed gateway and starts a
        // new run with the result. That is why this file can drive a browser it has no access to.
        for (const call of last?.tool_calls ?? []) {
          const toolCallId = call.id ?? `call_${crypto.randomUUID()}`;
          send({
            type: "TOOL_CALL_START",
            toolCallId,
            toolCallName: call.name,
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
        // Reported as a protocol event rather than a dropped connection, so the surface can say what
        // went wrong instead of showing a Bot that stopped answering.
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
      return Response.json({ status: "ok", framework: "langgraph" });
    }
    // A key, when REQUIRE_KEY is set. Customer agents commonly sit behind an API key.
    const requiredKey = process.env.REQUIRE_KEY;
    if (
      requiredKey &&
      url.pathname === "/ag-ui" &&
      request.headers.get("authorization") !== requiredKey
    ) {
      console.info("refused a run: wrong or missing key");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (url.pathname === "/ag-ui" && request.method === "POST") {
      const input = (await request.json()) as RunAgentInput;
      return runAgent(input);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.info(
  `langgraph-bot listening on http://localhost:${PORT}/ag-ui (model ${MODEL})`,
);
