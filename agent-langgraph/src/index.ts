import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { ChatAnthropic } from "@langchain/anthropic";
import { type AIMessage, ToolMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { serve } from "bun";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { toLangChainMessages } from "./history";
import { readReasoningEffort } from "./model-options";
import { streamRun } from "./stream";

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
 * gpt-5.6 costs it a rewritten streaming loop: those models reject function tools on that endpoint
 * unless reasoning is turned off, and turning reasoning off on a Bot that has to decide when to ask
 * a person for help is the wrong trade. Here it is `useResponsesApi`, one line, because the
 * migration belongs to the people who maintain the integration.
 *
 * The tool loop still runs on the client, exactly as it does in `agent-bot`: a Bot's actions happen
 * on a browser the person is watching, and the surface remains the place that executes those tools.
 * The graph provides model orchestration without changing that contract.
 */

const PORT = Number.parseInt(process.env.PORT ?? "4201", 10);
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) {
  console.error(
    "MANAGED_AGENT_TOKEN is not set. This process holds a model credential and will not start without a token for OpenBot's server.",
  );
  process.exit(1);
}

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
/*
 * An unset model and an empty one are the same thing.
 *
 * `??` only catches undefined, and a compose file passing `BOT_MODEL: ${BOT_MODEL:-}` hands this an
 * empty string, which is a value. The agent then asked its provider for a model named "" and the
 * run died with "you must provide a model parameter", which reads as a broken Bot rather than as
 * missing configuration.
 */
const MODEL = process.env.BOT_MODEL?.trim() || defaultModelFor(PROVIDER);
/**
 * OpenAI only. Its newer models require the Responses API, which the integration handles.
 *
 * Inferred from the model rather than left to a separate switch. `gpt-5.6-*` rejects function tools
 * on `/v1/chat/completions`, so a deployment that set `BOT_MODEL` to one and did not also know about
 * this flag got a Bot that started, looked healthy, and failed on its first tool call. The switch is
 * still honoured, so a model this list has not heard of can be told to use it.
 */
const NEEDS_RESPONSES_API = /^gpt-5\.[6-9]|^gpt-[6-9]/.test(MODEL);
const USE_RESPONSES_API =
  process.env.BOT_RESPONSES_API === "true" || NEEDS_RESPONSES_API;
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

/**
 * OpenAI only, and Responses API only: how hard this Bot is allowed to think.
 *
 * Checked here rather than sent onward and forgotten. An effort the API does not have is dropped
 * somewhere down the stack, and a Bot that starts, looks healthy and then thinks for as long as it
 * likes is a worse outcome than one that refuses to start and says why.
 */
const { effort: REASONING_EFFORT, problem: REASONING_PROBLEM } =
  readReasoningEffort(process.env.BOT_REASONING_EFFORT);
if (REASONING_PROBLEM) {
  console.error(REASONING_PROBLEM);
  process.exit(1);
}
/*
 * The two ways this setting would reach an API with nowhere to put it.
 *
 * Anthropic and Google express thinking budgets differently, and on `/v1/chat/completions` the
 * field does not exist at all. Refusing is the same call the issue makes about invalid values:
 * configuration that goes nowhere is worse than configuration that is absent, because the Bot looks
 * configured either way. Both messages name the variable that would make it work.
 */
if (REASONING_EFFORT && PROVIDER !== "openai") {
  console.error(
    `BOT_REASONING_EFFORT is OpenAI's setting, and BOT_PROVIDER=${PROVIDER}. Unset it, or set BOT_PROVIDER=openai.`,
  );
  process.exit(1);
}
if (REASONING_EFFORT && !USE_RESPONSES_API) {
  console.error(
    `BOT_REASONING_EFFORT needs the Responses API, and BOT_MODEL=${MODEL} is not being run on it. Use a model that requires it, or set BOT_RESPONSES_API=true.`,
  );
  process.exit(1);
}

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
    /*
     * `reasoning.effort`, not the `reasoningEffort` convenience field: the integration deprecated
     * the latter in favour of merging it into this object, and one of them is the one that survives.
     */
    ...(REASONING_EFFORT ? { reasoning: { effort: REASONING_EFFORT } } : {}),
  });
}

/**
 * Where this Bot runs a tool.
 *
 * Not the vendor: this deployment. A Bot that called an MCP server directly would be a Bot that
 * walked around the grant, the policy and the audit row, and those are the product. So the loop runs
 * here, in this process, and every call it makes goes back through the deployment that granted it.
 */
const TOOL_URL =
  process.env.OPENBOT_TOOL_URL ?? "http://localhost:3001/api/agent-tools/call";
const TOOL_TOKEN = process.env.AGENT_TOOL_TOKEN ?? "";

async function callTool(
  run: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!TOOL_TOKEN) {
    return "Refused. This Bot has no credential for calling tools back through its deployment.";
  }
  if (!run) {
    /*
     * No statement from the deployment about whose run this is, so there is nothing to act on behalf
     * of. Reported as a result rather than thrown: the run continues and says what it could not do.
     */
    return "Refused. This run carried no signed statement of which Bot and person it is for.";
  }
  try {
    const response = await fetch(TOOL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": TOOL_TOKEN,
      },
      /*
       * The deployment's own statement, handed straight back.
       *
       * The Bot and the actor used to be sent from here, which meant this process asserted who it was
       * acting for. It is not in a position to know, and anything holding the token could claim
       * anything, so the deployment says it and this only carries the note.
       */
      body: JSON.stringify({ name, args, run }),
    });
    const body = (await response.json()) as { text?: string };
    return body.text ?? "The tool returned nothing.";
  } catch (error) {
    // Reported to the model as a result rather than thrown: the run continues and says what broke.
    return `That tool could not be called: ${
      error instanceof Error ? error.message : "unknown error"
    }`;
  }
}

/**
 * The deployment's signed statement of what this run is.
 *
 * Opaque here on purpose: this process cannot read it and has no reason to. It carries it back when it
 * calls a tool, and the deployment that signed it is the only thing that can open it.
 */
function runAssertionOf(input: RunAgentInput): string {
  const props = input.forwardedProps as { openbotRun?: unknown } | undefined;
  return typeof props?.openbotRun === "string" ? props.openbotRun : "";
}

/**
 * The tools this deployment runs, as opposed to the ones the surface draws.
 *
 * Both arrive in the same list and no naming rule separates them, so the deployment names its own.
 * Absent, nothing is treated as the deployment's: a Bot that guessed wrong would either apologise for
 * a component it did show, or quietly report a governed tool as drawn without ever calling it. The
 * first is embarrassing and the second is a lie about governance, so an unmarked run does neither.
 */
function deploymentToolsOf(input: RunAgentInput): Set<string> {
  const props = input.forwardedProps as
    | { openbotDeploymentTools?: unknown }
    | undefined;
  const names = props?.openbotDeploymentTools;
  return new Set(
    Array.isArray(names)
      ? names.filter((name) => typeof name === "string")
      : [],
  );
}

/** Did the model reach for something the surface owns rather than something this deployment runs? */
function callsTheSurface(
  calls: { name: string }[],
  ours: Set<string>,
): boolean {
  return calls.some((call) => !ours.has(call.name));
}

/**
 * The graph, with the tool loop where it belongs.
 *
 * The loop used to run in the browser: this emitted a call, ended the run, and waited for a surface
 * to execute it and start another. That made a watching browser a requirement for a Bot to do
 * anything, which rules out an embed, a schedule, and anything unattended.
 *
 * Now it answers, calls what it needs, reads the results and answers again, which is what a harness
 * is for. `recursionLimit` bounds a model that would otherwise call tools in a circle.
 */
function buildGraph(input: RunAgentInput) {
  const model = buildModel();
  const run = runAssertionOf(input);

  const tools = toBoundTools(input);
  const bound = tools.length > 0 ? model.bindTools(tools) : model;
  const ours = deploymentToolsOf(input);

  return new StateGraph(MessagesAnnotation)
    .addNode("answer", async (state) => ({
      messages: [await bound.invoke(state.messages)],
    }))
    .addNode("tools", async (state) => {
      const last = state.messages.at(-1) as AIMessage;
      const results = await Promise.all(
        /*
         * Only this deployment's own tools. A component is drawn by the surface, and a decision is
         * answered there by a person, so neither is executed here and neither gets a result invented
         * here. The run ends instead, and the surface starts the next one carrying what it produced.
         */
        (last.tool_calls ?? [])
          .filter((call) => ours.has(call.name))
          .map(async (call) => {
            const text = await callTool(
              run,
              call.name,
              (call.args ?? {}) as Record<string, unknown>,
            );
            return new ToolMessage({
              content: text,
              tool_call_id: call.id ?? call.name,
              name: call.name,
            });
          }),
      );
      return { messages: results };
    })
    .addEdge(START, "answer")
    .addConditionalEdges("answer", (state) => {
      const last = state.messages.at(-1) as AIMessage | undefined;
      const calls = last?.tool_calls ?? [];
      if (calls.length === 0) return END;
      /*
       * A call the surface owns ends the run.
       *
       * This is how a tool that lives in the browser is supposed to work: the Bot asks for it, the
       * run finishes, the surface draws it or puts the question to a person, and the surface begins
       * the next run with the answer in hand. Running the loop through it here instead invents a
       * result: the Bot apologises for a chart the person is looking at, and an approval card that
       * has already been answered on its behalf sits waiting for a click that can never land.
       *
       * A turn that asks for both kinds at once ends too, and the model asks again for what it still
       * has no answer to. That is the rarer case and the safe way round: the alternative runs a
       * governed tool whose result nobody is waiting for.
       */
      if (callsTheSurface(calls, ours)) return END;
      return "tools";
    })
    .addEdge("tools", "answer")
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

      // The graph is built and its event stream opened inside `streamRun`, so a failure doing either
      // is reported as RUN_ERROR through the same path as a failure mid-stream.
      await streamRun(
        async () =>
          buildGraph(input).streamEvents(
            { messages: toLangChainMessages(input) },
            { version: "v2" },
          ),
        input,
        send,
      );

      controller.close();
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
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }
      const input = (await request.json()) as RunAgentInput;
      return runAgent(input);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-langgraph listening on http://localhost:${PORT}/ag-ui`);
