/**
 * One AG-UI run: the LangGraph graph that answers it, and the events it streams.
 *
 * THE CONTRACT: PLAIN AG-UI, the one a Bot somebody connects keeps. Nothing here is OpenBot's alone,
 * so anything the built-in Bot does, a connected Bot can do the same way.
 *  - The whole thread the caller sent is the conversation. Its system messages are the Bot's
 *    instructions (`history.ts`).
 *  - `input.tools` are this run's tools, and the caller runs them. A call to any of them ends the
 *    run with the call unanswered: streamed as TOOL_CALL_START / ARGS / END, then RUN_FINISHED with a
 *    success outcome naming the calls left (`pendingToolCallIds`, in the order the model made them),
 *    as AG-UI's tool calls say (https://docs.ag-ui.com/spec/draft/events/tool-calls). The next run
 *    brings each result back as a `tool` message, and the turn carries on from there. Several calls
 *    in one step hand back together, each under its own id. OpenBot answers them through policy,
 *    approvals and the audit trail, and runs computer calls in the order the model made them.
 *  - The one tool answered here is the engine's own `recall_earlier_results` (`context-room.ts`),
 *    which reads back a result this engine cleared for room. A step mixing it with other calls
 *    answers the recall and hands back the rest; nothing else is ever run here.
 *  - Gemini's thought signature on a handed-back call travels the AG-UI way: a
 *    REASONING_ENCRYPTED_VALUE on the call, and `encryptedValue` on it in the snapshot, which the
 *    caller returns unchanged with the call (https://docs.ag-ui.com/spec/draft/events/reasoning).
 *  - Every run ends with RUN_FINISHED or one RUN_ERROR (`errors.ts`).
 *
 * THE ONE OPENBOT EXTENSION: MODEL ROUTING. This engine has no model of its own, so the caller may
 * name one in `forwardedProps`, AG-UI's channel for what only the agent reads: `openbotModel`,
 * `openbotModelRoute`, `openbotOrganization` and `openbotSendOnce` (`models.ts`). Every key is
 * optional, and a stock agent ignores them; a connected Bot brings its own model.
 *
 * HOW THIS AGENT WORKS INSIDE, which no caller needs to know:
 *  - A 40-step budget per turn. The last step is sent with tools off (`tool_choice: "none"`) and the
 *    last-step notice (shared/run-notices.ts), so a turn always ends by saying something rather than
 *    on its fortieth search. A turn spans its hand-backs, so the steps it has already taken are the
 *    assistant tool-call messages since the person's latest message (`stepsTaken`).
 *  - History sanitising, so no dangling tool call reaches the model.
 *  - Room in the conversation (`context-room.ts`): old tool results cleared from what each step
 *    sends, harder retries when a provider still says too long, and `recall_earlier_results` to read
 *    a cleared result back. Without it a long task outgrew the model's window and stopped.
 */
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message, RunAgentInput, Tool } from "@ag-ui/core";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { ChatGoogle } from "@langchain/google";
import {
  Annotation,
  END,
  messagesStateReducer,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { LAST_STEP_NOTICE } from "../../shared/run-notices.ts";
import {
  clearsOnServer,
  LAST_STAGE,
  RECALL,
  recall,
  refusesContextEditing,
  roomFor,
  stopContextEditing,
  tooLong,
  withRecall,
} from "./context-room.ts";
import {
  MessageTooLongError,
  ModelDeclinedError,
  runFailure,
} from "./errors.ts";
import { forGemini, modelMessages, STANDING_ROLE_PREFIX } from "./history.ts";
import {
  chatModel,
  type Env,
  gatewayUrl,
  modelBaseUrl,
  providerName,
  type RunModel,
  runModel,
  runRoute,
} from "./models.ts";

/** Model steps a turn may take: the built-in Bot's `TOOL_STEPS`. The last one answers in words. */
export const MAX_STEPS = 40;

export type Emit = (event: BaseEvent) => void;

export type RunContext = {
  tools: readonly Tool[];
  model: BaseChatModel;
  emit: Emit;
  signal?: AbortSignal;
  maxSteps: number;
  /**
   * How hard this run clears what it sends (`STAGES` in context-room.ts). A stage that got a
   * too-long request through is where every later step starts, so it is not refused again first.
   */
  room: { stage: number };
};

export type RunOptions = {
  emit: Emit;
  signal?: AbortSignal;
  env?: Env;
  /** For tests: the model a run would otherwise build from the environment. */
  makeModel?: (run: RunModel, env: Env) => BaseChatModel;
  maxSteps?: number;
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
 * The provider's opaque artefact on a call: Gemini's thought signature, as @langchain/google puts it
 * on the call. It goes out as the call's AG-UI `encryptedValue` and comes back the same way.
 */
function signatureOf(call: unknown): string | undefined {
  const value = (call as { thoughtSignature?: unknown } | undefined)
    ?.thoughtSignature;
  return typeof value === "string" && value ? value : undefined;
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
    const sealed = signatureOf(parsed[position]);
    if (sealed)
      run.emit({
        type: "REASONING_ENCRYPTED_VALUE",
        subtype: "tool-call",
        entityId: slot.id,
        encryptedValue: sealed,
      } as BaseEvent);
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
  const toolChars = JSON.stringify(offered).length;
  for (;;) {
    // Only what this call sends is cleared: the run's own thread stays whole, for recall and for
    // the snapshot it hands back.
    const room = roomFor(state.messages, {
      stage: run.room.stage,
      clearsOnServer: clearsOnServer(run.model),
      extraChars: toolChars,
    });
    const sent = run.model instanceof ChatGoogle ? forGemini(room) : room;
    // The notice is this call's only: the conversation keeps what the model said and did.
    const messages = last
      ? [...sent, new HumanMessage(LAST_STEP_NOTICE)]
      : sent;
    const model =
      offered.length && run.model.bindTools
        ? run.model.bindTools(offered, last ? { tool_choice: "none" } : {})
        : run.model;
    try {
      const message = await streamStep(model, messages, run, last);
      return { messages: [message], steps: step };
    } catch (error) {
      if (run.signal?.aborted) throw error;
      // A proxy in front of Claude that does not take context editing: clear here instead.
      if (clearsOnServer(run.model) && refusesContextEditing(error)) {
        stopContextEditing(run.model);
        continue;
      }
      const words = tooLong(error);
      if (words === undefined) throw error;
      // Everything earlier is already cleared and cut: what is too long is the latest message.
      if (run.room.stage >= LAST_STAGE) throw new MessageTooLongError(words);
      run.room.stage += 1;
    }
  }
}

/** The calls of the step the run just took, or none. */
function lastCalls(state: StateType) {
  const last = [...state.messages]
    .reverse()
    .find((message) => message.getType() === "ai") as AIMessage | undefined;
  return last?.tool_calls ?? [];
}

/**
 * Where a step goes next: its recalls answered here, or the end of the run.
 *
 * Every other call, whatever its name, is the caller's: a tool OpenBot runs, a component the
 * browser draws, the computer, or a name nobody holds, which OpenBot refuses in words. The run ends
 * with those calls unanswered, and the next run brings their results.
 */
export function nextStep(state: StateType): "tools" | typeof END {
  const calls = lastCalls(state);
  return calls.some((call) => call.name === RECALL) ? "tools" : END;
}

/** After the recalls: the next step, or the end of the run if the caller still owns a call. */
export function afterRecall(state: StateType): "answer" | typeof END {
  return lastCalls(state).some((call) => call.name !== RECALL) ? END : "answer";
}

/** A recall, read from the whole thread this run holds rather than from what the model was sent. */
async function recalled(
  call: { id?: string; name: string; args: unknown },
  thread: readonly BaseMessage[],
): Promise<ToolMessage> {
  const args =
    call.args && typeof call.args === "object"
      ? (call.args as Record<string, unknown>)
      : {};
  return new ToolMessage({
    id: randomUUID(),
    content: recall(thread, args),
    tool_call_id: call.id ?? "",
    name: call.name,
    status: "success",
  });
}

/** Answer the step's recalls, and only those: every other call is the caller's to answer. */
async function tools(state: StateType, config: RunnableConfig) {
  const run = runOf(config);
  const results = await Promise.all(
    lastCalls(state)
      .filter((call) => call.name === RECALL)
      .map((call) => recalled(call, state.messages)),
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
  .addConditionalEdges("tools", afterRecall, ["answer", END])
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
            toolCalls: calls.map((call) => {
              const sealed = signatureOf(call);
              return {
                id: call.id ?? "",
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args ?? {}),
                },
                ...(sealed ? { encryptedValue: sealed } : {}),
              };
            }),
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

/**
 * The calls this run made and left for the caller, in the order the model made them: every call
 * with no result in the run. AG-UI's `pendingToolCallIds` must be exactly these.
 */
function pendingCalls(added: readonly BaseMessage[]): string[] {
  const answered = new Set(
    added
      .filter((message) => message.getType() === "tool")
      .map((message) => (message as ToolMessage).tool_call_id),
  );
  return added
    .filter((message) => message.getType() === "ai")
    .flatMap((message) => (message as AIMessage).tool_calls ?? [])
    .map((call) => call.id ?? "")
    .filter((id) => id && !answered.has(id));
}

/**
 * The model steps this turn has already taken, in the runs before this one: the assistant messages
 * that called a tool since the person's latest message. Each was one step that ended its run on a
 * hand-back (or answered a recall), so a turn's budget runs across its hand-backs rather than
 * starting again on each.
 */
export function stepsTaken(thread: readonly BaseMessage[]): number {
  let taken = 0;
  for (const message of [...thread].reverse()) {
    if (message.getType() === "human") break;
    if (
      message.getType() === "ai" &&
      ((message as AIMessage).tool_calls?.length ?? 0) > 0
    )
      taken += 1;
  }
  return taken;
}

/**
 * The Bot a run is for, from its standing role's id, for model routing only: a Claude plan's query
 * is named by it (`claudeThreadId`). Absent, every run of the thread still shares one name.
 */
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

/** Who serves the model and where it is dialled, for the sentence a failed run ends with. */
function failureContext(env: Env, run: RunModel) {
  const gateway = gatewayUrl(env);
  const via = gateway ? run.route?.via : undefined;
  if (via === "anthropic")
    return { provider: "Anthropic", baseUrl: `${gateway}/anthropic` };
  if (via === "openai")
    // The gateway can stand in front of any OpenAI-compatible provider: named by its model where
    // that says (Gemini, Grok), as for the sign-in proxy.
    return {
      provider: providerName({
        OPENAI_BASE_URL: `${gateway}/v1`,
        BOT_MODEL: run.model,
      }),
      baseUrl: `${gateway}/v1`,
    };
  if (via === "claude-plan")
    return { provider: "Claude", baseUrl: env.CLAUDE_PLAN_HARNESS_URL };
  if (via === "chatgpt-plan")
    return { provider: "ChatGPT", baseUrl: env.CHATGPT_PLAN_HARNESS_URL };
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
  // The route and its token stay in this run's model: neither is logged or sent anywhere else.
  const choice: RunModel = {
    ...runModel(props),
    sendOnce: props.openbotSendOnce === true,
    botId: botIdOf(input.messages ?? []),
    route: runRoute(props),
    threadId: input.threadId,
    ...(typeof props.openbotOrganization === "string" &&
    props.openbotOrganization
      ? { organization: props.openbotOrganization }
      : {}),
    signal: options.signal,
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
      // A Bot with tools can read back a result cleared to make room (context-room.ts).
      tools: withRecall(input.tools ?? []),
      model,
      emit,
      signal: options.signal,
      maxSteps: options.maxSteps ?? MAX_STEPS,
      room: { stage: 0 },
    };
    const thread = modelMessages(input.messages ?? [], input.context ?? []);
    const final = await graph.invoke(
      { messages: thread, steps: stepsTaken(thread) },
      {
        configurable: { openbot: run },
        // Each step is an answer and, at most, a recall: room for every step and the last.
        recursionLimit: run.maxSteps * 2 + 2,
        signal: options.signal,
      },
    );
    const all = final.messages as BaseMessage[];
    const added = all
      .slice(thread.length)
      .map(asAgui)
      .filter((message): message is Message => !!message);
    emit({
      type: "MESSAGES_SNAPSHOT",
      messages: [...(input.messages ?? []), ...added],
    } as BaseEvent);
    const pending = pendingCalls(all.slice(thread.length));
    emit({
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
      ...(pending.length
        ? { outcome: { type: "success", pendingToolCallIds: pending } }
        : {}),
    } as BaseEvent);
  } catch (error) {
    if (options.signal?.aborted) return;
    const failure = runFailure(error, failureContext(env, choice));
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
