/**
 * One AG-UI run: the LangGraph graph that answers it, and the events it streams.
 *
 * THE HARNESS CONTRACT, as agent-langgraph-agui keeps it (`tool_runtime.py`, `whole_thread.py`):
 *  - The whole thread the server sent is the conversation. Nothing is remembered between runs.
 *  - `input.tools` are this run's tools. A call to a tool the server runs here
 *    (`forwardedProps.openbotDeploymentTools`) goes through its signed callback, with the run's
 *    signed statement (`openbotRun`). Any other call (computer_*, render_ui, a component, a tool this
 *    step was not sent) ends the run for the surface to answer, and the next run brings the call and
 *    its result back in `messages`. A mixed step ends too: a governed action is never run while the
 *    surface still owns an unanswered call.
 *  - Several calls in one step stream as parallel tool events, each with its own id.
 *  - Every run ends with RUN_FINISHED or one RUN_ERROR (`errors.ts`).
 *
 * WHAT BUILT-IN BOTS HAVE THAT THE PYTHON HARNESS LACKS:
 *  - The built-in Bot's full prompt (`openbotSystemPrompt`), see `history.ts`.
 *  - A 40-step budget. The last step is sent with tools off (`tool_choice: "none"`) and the server's
 *    own last-step notice (shared/run-notices.ts), so a run always ends by saying something rather
 *    than on its fortieth search (`answersOnLastStep` in the built-in engine).
 *  - History sanitising, so no dangling tool call reaches the model.
 */
import { randomUUID } from "node:crypto";
import type {
  BaseEvent,
  Context,
  Message,
  RunAgentInput,
  Tool,
} from "@ag-ui/core";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  END,
  messagesStateReducer,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { LAST_STEP_NOTICE } from "../../shared/run-notices.ts";
import { ModelDeclinedError, runFailure } from "./errors.ts";
import { modelMessages, STANDING_ROLE_PREFIX } from "./history.ts";
import {
  chatModel,
  type Env,
  modelBaseUrl,
  providerName,
  type RunModel,
  runModel,
} from "./models.ts";

/** Model steps a run may take: the built-in Bot's `TOOL_STEPS`. The last one answers in words. */
export const MAX_STEPS = 40;

export type Emit = (event: BaseEvent) => void;

export type RunContext = {
  tools: readonly Tool[];
  context: readonly Context[];
  deployment: ReadonlySet<string>;
  assertion: string;
  model: BaseChatModel;
  emit: Emit;
  signal?: AbortSignal;
  maxSteps: number;
  env: Env;
  fetch: typeof fetch;
};

export type RunOptions = {
  emit: Emit;
  signal?: AbortSignal;
  env?: Env;
  /** For tests: the model a run would otherwise build from the environment. */
  makeModel?: (run: RunModel, env: Env) => BaseChatModel;
  maxSteps?: number;
  fetch?: typeof fetch;
  log?: Pick<Console, "warn" | "error">;
};

const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  steps: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
});
type StateType = typeof State.State;

function runOf(config: RunnableConfig): RunContext {
  return (config.configurable as { openbot: RunContext }).openbot;
}

/** The step's tools as OpenAI-format function tools, which every LangChain chat model binds. */
function boundTools(tools: readonly Tool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

type Slot = {
  index: number;
  id?: string;
  name?: string;
  args: string;
  started: boolean;
};

/** Whether the model declined to answer, in its provider's way of saying so. */
function declined(message: AIMessageChunk): string | undefined {
  const metadata = (message.response_metadata ?? {}) as Record<string, unknown>;
  const kwargs = (message.additional_kwargs ?? {}) as Record<string, unknown>;
  const said = message.text;
  // Anthropic's stop reason: in the response metadata on a whole answer, in additional_kwargs on a
  // streamed one.
  if (metadata.stop_reason === "refusal" || kwargs.stop_reason === "refusal")
    return said || "Claude declined to answer this request.";
  const refusal = (
    message.additional_kwargs as { refusal?: unknown } | undefined
  )?.refusal;
  if (typeof refusal === "string" && refusal.trim()) return refusal.trim();
  const finish = metadata.finishReason ?? metadata.finish_reason;
  if (
    typeof finish === "string" &&
    /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII)$/.test(finish)
  )
    return said || "Gemini declined to answer this request.";
  return undefined;
}

/**
 * One model call, streamed as it arrives: its words as one text message, and each tool call under
 * its own id as soon as the provider names it (parallel calls interleave safely: each is keyed by
 * its index in the response). On the last step no tool event is sent and any call is dropped.
 */
async function streamStep(
  model: BaseChatModel | ReturnType<NonNullable<BaseChatModel["bindTools"]>>,
  messages: BaseMessage[],
  run: RunContext,
  last: boolean,
): Promise<AIMessage> {
  const messageId = randomUUID();
  const slots = new Map<string, Slot>();
  let textOpen = false;
  let whole: AIMessageChunk | undefined;

  const start = (slot: Slot) => {
    slot.started = true;
    run.emit({
      type: "TOOL_CALL_START",
      toolCallId: slot.id,
      toolCallName: slot.name,
      parentMessageId: messageId,
    } as BaseEvent);
    if (slot.args)
      run.emit({
        type: "TOOL_CALL_ARGS",
        toolCallId: slot.id,
        delta: slot.args,
      } as BaseEvent);
  };

  /**
   * The tool-call pieces a chunk carries. Most providers stream a call as `tool_call_chunks`; Gemini
   * (@langchain/google) streams it whole, as `tool_calls` with no chunks, and a run that read only
   * the chunks saw no call at all. A whole call is one piece of its own.
   */
  let wholeCalls = 0;
  const callPieces = (chunk: AIMessageChunk) => {
    if (chunk.tool_call_chunks?.length) return chunk.tool_call_chunks;
    return (chunk.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      args: JSON.stringify(call.args ?? {}),
      index: `whole-${wholeCalls++}`,
    }));
  };

  const stream = await model.stream(messages, { signal: run.signal });
  for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
    whole = whole ? whole.concat(chunk) : chunk;
    const delta = chunk.text;
    if (delta) {
      if (!textOpen) {
        textOpen = true;
        run.emit({
          type: "TEXT_MESSAGE_START",
          messageId,
          role: "assistant",
        } as BaseEvent);
      }
      run.emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta } as BaseEvent);
    }
    if (last) continue;
    for (const piece of callPieces(chunk)) {
      const key =
        piece.index !== undefined && piece.index !== null
          ? `index:${piece.index}`
          : `id:${piece.id}`;
      let slot = slots.get(key);
      if (!slot) {
        slot = { index: slots.size, args: "", started: false };
        slots.set(key, slot);
      }
      if (piece.id && !slot.id) slot.id = piece.id;
      if (piece.name && !slot.name) slot.name = piece.name;
      if (slot.started) {
        if (piece.args)
          run.emit({
            type: "TOOL_CALL_ARGS",
            toolCallId: slot.id,
            delta: piece.args,
          } as BaseEvent);
        slot.args += piece.args ?? "";
        continue;
      }
      slot.args += piece.args ?? "";
      if (slot.id && slot.name) start(slot);
    }
  }
  if (textOpen) run.emit({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
  if (!whole) return new AIMessage({ id: messageId, content: "" });

  const refusal = declined(whole);
  if (refusal) throw new ModelDeclinedError(refusal);

  const ordered = [...slots.values()].sort((a, b) => a.index - b.index);
  const parsed = whole.tool_calls ?? [];
  const calls = ordered.map((slot, position) => {
    slot.id ??= parsed[position]?.id ?? randomUUID();
    slot.name ??= parsed[position]?.name ?? "";
    if (!slot.started) start(slot);
    run.emit({ type: "TOOL_CALL_END", toolCallId: slot.id } as BaseEvent);
    let args: Record<string, unknown> = {};
    try {
      const value = slot.args.trim() ? JSON.parse(slot.args) : {};
      if (value && typeof value === "object" && !Array.isArray(value))
        args = value;
    } catch {
      args =
        (parsed[position]?.args as Record<string, unknown> | undefined) ?? {};
    }
    // What else the provider put on the call (Gemini's thought signature) stays with it.
    return {
      ...(parsed[position] ?? {}),
      id: slot.id,
      name: slot.name,
      args,
      type: "tool_call" as const,
    };
  });

  // The provider's own content is kept for the rest of this run (Anthropic's thinking and tool_use
  // blocks, the Responses API's reasoning items), so a tool step continues the way it began.
  const content =
    last && Array.isArray(whole.content)
      ? (whole.content as Record<string, unknown>[]).filter(
          (block) =>
            block?.type !== "tool_use" && block?.type !== "function_call",
        )
      : whole.content;
  return new AIMessage({
    id: messageId,
    content: content as never,
    tool_calls: calls,
    additional_kwargs: whole.additional_kwargs,
    response_metadata: whole.response_metadata,
    ...(whole.usage_metadata ? { usage_metadata: whole.usage_metadata } : {}),
  });
}

async function answer(state: StateType, config: RunnableConfig) {
  const run = runOf(config);
  const step = state.steps + 1;
  const offered = boundTools(run.tools);
  const last = offered.length > 0 && step >= run.maxSteps;
  // The notice is this call's only: the conversation keeps what the model said and did.
  const messages = last
    ? [...state.messages, new HumanMessage(LAST_STEP_NOTICE)]
    : state.messages;
  const model =
    offered.length && run.model.bindTools
      ? run.model.bindTools(offered, last ? { tool_choice: "none" } : {})
      : run.model;
  const message = await streamStep(model, messages, run, last);
  return { messages: [message], steps: step };
}

/** Where a step goes next: the server's tools here, or back to the surface (`next_step` in Python). */
export function nextStep(
  state: StateType,
  config: RunnableConfig,
): "tools" | typeof END {
  const last = state.messages.at(-1) as AIMessage | undefined;
  const calls = last?.tool_calls ?? [];
  if (calls.length === 0) return END;
  const run = runOf(config);
  const offered = new Set(run.tools.map((tool) => tool.name));
  // A tool this run was not offered is handed back like a call the surface owns: the caller answers
  // it, through its own governance, or refuses a name it holds nothing for.
  if (calls.some((call) => !offered.has(call.name))) return END;
  // Mixed turns yield too: never invent a UI result or run a governed action while the surface
  // still owns an unanswered call.
  if (calls.some((call) => !run.deployment.has(call.name))) return END;
  return "tools";
}

/** The deployment's own reason for refusing a callback, when its body says one. */
async function refusalReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body?.error === "string" && body.error.trim()
      ? ` ${body.error.trim()}`
      : "";
  } catch {
    return "";
  }
}

/** One server tool, run through the deployment's signed callback (`_call_tool` in Python). */
async function callTool(
  call: { id?: string; name: string; args: unknown },
  run: RunContext,
): Promise<ToolMessage> {
  const result = async (): Promise<[string, boolean]> => {
    const token = run.env.AGENT_TOOL_TOKEN?.trim();
    if (!token)
      return [
        "Refused. This Bot has no credential for calling tools through its deployment.",
        true,
      ];
    if (!run.assertion)
      return [
        "Refused. This run carried no signed statement of which Bot and person it is for.",
        true,
      ];
    const url =
      run.env.OPENBOT_TOOL_URL?.trim() ||
      "http://127.0.0.1:3001/api/agent-tools/call";
    try {
      // Redirects must never carry this deployment's credential elsewhere.
      const response = await run.fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(run.signal ? [run.signal] : []),
        ]),
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": token,
        },
        body: JSON.stringify({
          name: call.name,
          args: call.args,
          run: run.assertion,
        }),
      });
      if (!response.ok) {
        return [
          `Refused. Tool callback returned HTTP ${response.status}.${await refusalReason(response)}`,
          true,
        ];
      }
      const body = (await response.json()) as { text?: unknown };
      if (!body || typeof body.text !== "string")
        return ["The tool callback returned no readable result.", true];
      return [body.text, false];
    } catch (error) {
      if (run.signal?.aborted) throw error;
      // The error's text can carry the URL; the boundary is reported, never the request.
      return ["The tool callback could not be completed.", true];
    }
  };
  const [content, failed] = await result();
  return new ToolMessage({
    id: randomUUID(),
    content,
    tool_call_id: call.id ?? "",
    name: call.name,
    status: failed ? "error" : "success",
  });
}

async function tools(state: StateType, config: RunnableConfig) {
  const run = runOf(config);
  if (nextStep(state, config) !== "tools") {
    throw new Error(
      "This turn must return to the surface before tools can execute.",
    );
  }
  const calls = (state.messages.at(-1) as AIMessage).tool_calls ?? [];
  // A Bot has one browser: its computer calls go one after another, in the order the model made
  // them. Everything else runs alongside them.
  const computer = calls.filter((call) => call.name.startsWith("computer_"));
  const inOrder = async () => {
    const answered: ToolMessage[] = [];
    for (const call of computer) answered.push(await callTool(call, run));
    return answered;
  };
  const [ordered, others] = await Promise.all([
    inOrder(),
    Promise.all(
      calls
        .filter((call) => !call.name.startsWith("computer_"))
        .map((call) => callTool(call, run)),
    ),
  ]);
  const fromComputer = ordered[Symbol.iterator]();
  const fromOthers = others[Symbol.iterator]();
  const results = calls.map(
    (call) =>
      (call.name.startsWith("computer_") ? fromComputer : fromOthers).next()
        .value as ToolMessage,
  );
  for (const result of results) {
    run.emit({
      type: "TOOL_CALL_RESULT",
      messageId: result.id,
      toolCallId: result.tool_call_id,
      content:
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content),
      role: "tool",
    } as BaseEvent);
  }
  return { messages: results };
}

export const graph = new StateGraph(State)
  .addNode("answer", answer)
  .addNode("tools", tools)
  .addEdge(START, "answer")
  .addConditionalEdges("answer", nextStep, ["tools", END])
  .addEdge("tools", "answer")
  .compile();

/** A message the graph added, as AG-UI carries it, for the run's closing snapshot. */
function asAgui(message: BaseMessage): Message | undefined {
  const type = message.getType();
  if (type === "ai") {
    const ai = message as AIMessage;
    const calls = ai.tool_calls ?? [];
    return {
      id: ai.id ?? randomUUID(),
      role: "assistant",
      content: ai.text,
      ...(calls.length
        ? {
            toolCalls: calls.map((call) => ({
              id: call.id ?? "",
              type: "function" as const,
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args ?? {}),
              },
            })),
          }
        : {}),
    } as Message;
  }
  if (type === "tool") {
    const tool = message as ToolMessage;
    return {
      id: tool.id ?? randomUUID(),
      role: "tool",
      toolCallId: tool.tool_call_id,
      content:
        typeof tool.content === "string"
          ? tool.content
          : JSON.stringify(tool.content),
    } as Message;
  }
  return undefined;
}

/** The Bot a run is for, from the server's standing-role id. */
function botIdOf(messages: readonly Message[]): string | undefined {
  const role = messages.find(
    (message) =>
      typeof message.id === "string" &&
      message.id.startsWith(STANDING_ROLE_PREFIX),
  );
  return role
    ? role.id.slice(STANDING_ROLE_PREFIX.length) || undefined
    : undefined;
}

function failureContext(env: Env) {
  try {
    return { provider: providerName(env), baseUrl: modelBaseUrl(env) };
  } catch {
    return { provider: "Your model provider" };
  }
}

/**
 * Answer one run, emitting its AG-UI events in order. Never throws: a failure is the run's
 * RUN_ERROR, and the error itself goes to the log.
 */
export async function runAgent(
  input: RunAgentInput,
  options: RunOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const log = options.log ?? console;
  const props = (
    input.forwardedProps && typeof input.forwardedProps === "object"
      ? input.forwardedProps
      : {}
  ) as Record<string, unknown>;
  const names = props.openbotDeploymentTools;
  const assertion = props.openbotRun;
  const systemPrompt =
    typeof props.openbotSystemPrompt === "string"
      ? props.openbotSystemPrompt
      : undefined;
  const choice: RunModel = {
    ...runModel(props),
    sendOnce: props.openbotSendOnce === true,
    botId: botIdOf(input.messages ?? []),
  };
  const emit = options.emit;
  emit({
    type: "RUN_STARTED",
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent);

  try {
    const model = (options.makeModel ?? chatModel)(choice, env);
    const run: RunContext = {
      tools: input.tools ?? [],
      context: input.context ?? [],
      deployment: new Set(
        Array.isArray(names)
          ? names.filter((name): name is string => typeof name === "string")
          : [],
      ),
      assertion: typeof assertion === "string" ? assertion : "",
      model,
      emit,
      signal: options.signal,
      maxSteps: options.maxSteps ?? MAX_STEPS,
      env,
      fetch: options.fetch ?? fetch,
    };
    const thread = modelMessages(input.messages ?? [], {
      systemPrompt,
      context: run.context,
    });
    const final = await graph.invoke(
      { messages: thread, steps: 0 },
      {
        configurable: { openbot: run },
        // Each step is an answer and, at most, a tools turn: room for every step and the last.
        recursionLimit: run.maxSteps * 2 + 2,
        signal: options.signal,
      },
    );
    const added = (final.messages as BaseMessage[])
      .slice(thread.length)
      .map(asAgui)
      .filter((message): message is Message => !!message);
    emit({
      type: "MESSAGES_SNAPSHOT",
      messages: [...(input.messages ?? []), ...added],
    } as BaseEvent);
    emit({
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent);
  } catch (error) {
    if (options.signal?.aborted) return;
    const failure = runFailure(error, failureContext(env));
    if (failure.code)
      log.warn(`The model provider refused the run: ${failure.message}`);
    else log.error("The run failed before it finished", error);
    emit({
      type: "RUN_ERROR",
      message: failure.message,
      ...(failure.code ? { code: failure.code } : {}),
      ...(failure.category
        ? { metadata: { errorCategory: failure.category } }
        : {}),
    } as BaseEvent);
  }
}
