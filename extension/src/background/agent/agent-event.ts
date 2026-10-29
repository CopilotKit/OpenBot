// `agent.event`: the part of each AG-UI event that CopilotKit's own agent events (`agent.run`, `agent.message`,
// `tool.call`) do not carry, so every piece of the agent's side lands in the Trajectory exactly once and never one event
// per streamed token. A text or reasoning message is CopilotKit's `agent.message` alone; a tool call's arguments are one
// `TOOL_CALL_ARGS` holding the whole string the library assembled, sent at TOOL_CALL_END; a tool result is the tool's
// `agent.message` (its text) beside a `TOOL_CALL_RESULT` that names the call it answers; consecutive STATE_DELTAs (and
// ACTIVITY_DELTAs of one activity) with nothing between them are one, their JSON Patch operations concatenated, which
// applies exactly as the parts did. History in a RUN_STARTED's `input` or a MESSAGES_SNAPSHOT keeps only what no event
// carried before: a message already carried is its id and role. A frontend tool's result, which the page puts into the
// history itself and CopilotKit announces nowhere, is carried there, in the next run's `input`, once. A RUN_STARTED's
// `tools` and `context` (the page's whole tool list and context, the same in every run of most pages) are carried when
// they differ from what the Thread's runs carried before.
import type { BaseEvent, Message } from "@ag-ui/client";

/** An AG-UI event as `agent.event` carries it. */
export type AgentEventPayload = { type: string; [field: string]: unknown };

/** What a Thread's events have already carried, so nothing is carried twice; shared by every tab's agent for the Thread.
 * A message maps to the text its `agent.message` carried (null when it carried none); a tool call to its name and the
 * arguments its `TOOL_CALL_ARGS` carried; `setup` to the JSON of the `tools` and of the `context` a RUN_STARTED of the
 * Thread carried last. */
export type Expressed = {
  messages: Map<string, string | null>;
  toolCalls: Map<string, { name: string; arguments: string | null }>;
  setup: Map<"tools" | "context", string>;
};

export const createExpressed = (): Expressed => ({
  messages: new Map(),
  toolCalls: new Map(),
  setup: new Map(),
});

/**
 * Per AG-UI event type: the fields CopilotKit's own events carry, the ids kept beside what remains so it can be joined to
 * them, and whether the event goes out always, only when something remains, or never (a streamed delta, carried
 * assembled). An unlisted type goes out whole.
 */
const POLICY: Record<
  string,
  { carried: string[]; keys: string[]; when: "always" | "rest" | "never" }
> = {
  RUN_STARTED: { carried: ["threadId", "runId"], keys: [], when: "rest" },
  RUN_FINISHED: { carried: ["threadId", "runId"], keys: [], when: "rest" },
  TEXT_MESSAGE_START: { carried: ["role"], keys: ["messageId"], when: "rest" },
  TEXT_MESSAGE_CONTENT: { carried: [], keys: [], when: "never" },
  TEXT_MESSAGE_END: { carried: [], keys: ["messageId"], when: "rest" },
  TOOL_CALL_START: {
    carried: ["toolCallName", "parentMessageId"],
    keys: ["toolCallId"],
    when: "rest",
  },
  TOOL_CALL_ARGS: { carried: [], keys: [], when: "never" },
  TOOL_CALL_END: { carried: [], keys: ["toolCallId"], when: "rest" },
  TOOL_CALL_RESULT: {
    carried: ["role"],
    keys: ["messageId", "toolCallId"],
    when: "always",
  },
  REASONING_START: { carried: [], keys: ["messageId"], when: "always" },
  REASONING_MESSAGE_START: {
    carried: ["role"],
    keys: ["messageId"],
    when: "rest",
  },
  REASONING_MESSAGE_CONTENT: { carried: [], keys: [], when: "never" },
  REASONING_MESSAGE_END: { carried: [], keys: ["messageId"], when: "rest" },
  REASONING_END: { carried: [], keys: ["messageId"], when: "always" },
};

/** Intelligence's own bookkeeping (its event id, sequence and ingest id): not the agent's. It rides in the `metadata` of
 * every event Intelligence relays, and in the `metadata` of each message the page got from it, so a run's history
 * (RUN_STARTED's `input.messages`, a MESSAGES_SNAPSHOT) carries it too. */
const INTELLIGENCE_METADATA = /^cpki_/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A `metadata` without Intelligence's bookkeeping; undefined when nothing of it remains. */
const ownMetadata = (
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const kept = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !INTELLIGENCE_METADATA.test(key),
    ),
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
};

/** A value with Intelligence's bookkeeping taken out of every `metadata` in it, at any depth: a copy wherever something
 * was taken out, the value itself where nothing was. */
const withoutIntelligence = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map(withoutIntelligence);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isRecord(value)) return value;
  let out: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(value)) {
    const kept =
      key === "metadata" && isRecord(item)
        ? ownMetadata(withoutIntelligence(item) as Record<string, unknown>)
        : withoutIntelligence(item);
    if (kept === item) continue;
    out ??= { ...value };
    if (kept === undefined) delete out[key];
    else out[key] = kept;
  }
  return out ?? value;
};

/** A field of an event that is not the agent's: its own clock (the Trajectory event has one) and Intelligence's
 * bookkeeping wherever it sits. Undefined when nothing of it remains. */
const withoutTransport = (
  field: string,
  value: unknown,
): unknown | undefined => {
  if (field === "timestamp") return undefined;
  if (field === "metadata" && isRecord(value))
    return ownMetadata(withoutIntelligence(value) as Record<string, unknown>);
  return withoutIntelligence(value);
};

type Pending = {
  kind: "state" | "activity";
  payload: AgentEventPayload & { delta?: unknown[]; patch?: unknown[] };
  at: number;
};

export function createAgentEventBuilder(expressed: Expressed) {
  const results = new Map<string, AgentEventPayload>();
  let pending: Pending | null = null;

  const textOf = (message: Message): string | null =>
    typeof message.content === "string" ? message.content : null;

  /** A message as history carries it: what an earlier event carried taken out, its id and role kept. Intelligence's
   * bookkeeping in its `metadata` is not the message's, so a message an agent.message already carried is not carried
   * again for it. */
  const reduceMessage = (
    message: Message,
  ): { message: Record<string, unknown>; carriedBefore: boolean } => {
    const out = {
      ...(withoutIntelligence(message) as Record<string, unknown>),
    };
    const known = expressed.messages.get(message.id);
    const text = textOf(message);
    if (
      out.content === undefined ||
      (text !== null && known !== undefined && known === text)
    )
      delete out.content;
    if (message.role === "assistant" && Array.isArray(message.toolCalls))
      out.toolCalls = message.toolCalls.map((call) => {
        const carried = expressed.toolCalls.get(call.id);
        return carried &&
          carried.name === call.function.name &&
          carried.arguments === call.function.arguments
          ? { id: call.id }
          : call;
      });
    const remaining = Object.keys(out).filter(
      (key) =>
        key !== "id" &&
        key !== "role" &&
        !(key === "toolCallId" && known !== undefined) &&
        !(
          key === "toolCalls" &&
          (out.toolCalls as Record<string, unknown>[]).every(
            (call) => Object.keys(call).length === 1,
          )
        ),
    );
    return { message: out, carriedBefore: remaining.length === 0 };
  };

  /** Everything a message carried in history is carried from now on. */
  const markCarried = (message: Message) => {
    if (!expressed.messages.has(message.id))
      expressed.messages.set(message.id, textOf(message));
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? [])
        expressed.toolCalls.set(call.id, {
          name: call.function.name,
          arguments: call.function.arguments,
        });
  };

  /** A RUN_STARTED's `input` without its ids (they are the run's), with its `tools` and `context` only when they changed
   * from what the Thread's runs carried, and with only the history no event carried. */
  const reduceInput = (input: unknown): unknown => {
    if (!isRecord(input)) return input;
    const { threadId: _thread, runId: _run, messages, ...rest } = input;
    for (const field of ["tools", "context"] as const) {
      if (rest[field] === undefined) continue;
      const json = JSON.stringify(rest[field]);
      if (expressed.setup.get(field) === json) delete rest[field];
      else expressed.setup.set(field, json);
    }
    if (!Array.isArray(messages)) return rest;
    const fresh = (messages as Message[])
      .map((message) => ({ original: message, ...reduceMessage(message) }))
      .filter(({ carriedBefore }) => !carriedBefore);
    for (const { original } of fresh) markCarried(original);
    return fresh.length > 0
      ? { ...rest, messages: fresh.map(({ message }) => message) }
      : rest;
  };

  /** The event less what CopilotKit's events carry; null when that leaves nothing the policy sends. */
  const rest = (event: BaseEvent): AgentEventPayload | null => {
    const policy = POLICY[event.type] ?? {
      carried: [],
      keys: [],
      when: "always",
    };
    if (policy.when === "never") return null;
    const source = event as unknown as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const key of policy.keys)
      if (source[key] !== undefined) kept[key] = source[key];
    const remaining: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(source)) {
      if (
        field === "type" ||
        policy.carried.includes(field) ||
        policy.keys.includes(field)
      )
        continue;
      let left = withoutTransport(field, value);
      if (event.type === "RUN_STARTED" && field === "input")
        left = reduceInput(left);
      if (event.type === "TOOL_CALL_RESULT" && field === "content") {
        // A string result is the tool's agent.message text.
        if (typeof value === "string") continue;
      }
      if (event.type === "MESSAGES_SNAPSHOT" && field === "messages") {
        const messages = value as Message[];
        left = messages.map((message) => reduceMessage(message).message);
        for (const message of messages) markCarried(message);
      }
      // A copy: the library goes on to apply the event, and a patch's values become part of the state it then patches.
      if (left !== undefined) remaining[field] = structuredClone(left);
    }
    if (policy.when === "rest" && Object.keys(remaining).length === 0)
      return null;
    return { type: event.type, ...kept, ...remaining };
  };

  /** A delta merges into the one before it when it carries nothing but its operations. */
  const mergeable = (event: BaseEvent, operations: string): boolean => {
    const payload = rest(event);
    return (
      payload !== null &&
      Array.isArray(payload[operations]) &&
      Object.keys(payload).every((key) =>
        ["type", operations, "messageId", "activityType"].includes(key),
      )
    );
  };

  const continues = (held: Pending, event: BaseEvent): boolean => {
    const source = event as unknown as Record<string, unknown>;
    if (held.kind === "state")
      return event.type === "STATE_DELTA" && mergeable(event, "delta");
    return (
      event.type === "ACTIVITY_DELTA" &&
      source.messageId === held.payload.messageId &&
      source.activityType === held.payload.activityType &&
      mergeable(event, "patch")
    );
  };

  /** Holds a delta to merge with the next, or returns it to send now when it carries more than its operations. */
  const hold = (
    event: BaseEvent,
    kind: Pending["kind"],
    operations: "delta" | "patch",
    at: number,
  ): AgentEventPayload | null => {
    const payload = rest(event);
    if (payload === null) return null;
    if (!mergeable(event, operations)) return payload;
    if (pending !== null && pending.kind === kind) {
      (pending.payload[operations] as unknown[]).push(
        ...(payload[operations] as unknown[]),
      );
      pending.at = at;
    } else
      pending = {
        kind,
        payload: {
          ...payload,
          [operations]: [...(payload[operations] as unknown[])],
        },
        at,
      };
    return null;
  };

  return {
    rest,
    /** Before an event is applied: a held delta it does not continue goes out first. */
    flushBefore(
      event: BaseEvent,
    ): { payload: AgentEventPayload; at: number }[] {
      if (pending === null || continues(pending, event)) return [];
      const out = pending;
      pending = null;
      return [out];
    },
    /** The run is over: whatever is held goes out. */
    flushAll(): { payload: AgentEventPayload; at: number }[] {
      const out = pending;
      pending = null;
      return out === null ? [] : [out];
    },
    stateDelta: (event: BaseEvent, at: number) =>
      hold(event, "state", "delta", at),
    activityDelta: (event: BaseEvent, at: number) =>
      hold(event, "activity", "patch", at),
    toolCallStarted(
      event: BaseEvent & { toolCallId: string; toolCallName: string },
    ) {
      expressed.toolCalls.set(event.toolCallId, {
        name: event.toolCallName,
        arguments: null,
      });
    },
    /** TOOL_CALL_END: the arguments the library assembled for the call, as one TOOL_CALL_ARGS, then what is left of END. */
    toolCallEnded(
      event: BaseEvent & { toolCallId: string },
      messages: readonly Readonly<Message>[],
    ): AgentEventPayload[] {
      const out: AgentEventPayload[] = [];
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        const call = message.toolCalls?.find(
          ({ id }) => id === event.toolCallId,
        );
        if (!call) continue;
        const carried = expressed.toolCalls.get(call.id);
        expressed.toolCalls.set(call.id, {
          name: carried?.name ?? call.function.name,
          arguments: call.function.arguments,
        });
        if (call.function.arguments !== "")
          out.push({
            type: "TOOL_CALL_ARGS",
            toolCallId: call.id,
            delta: call.function.arguments,
          });
        break;
      }
      const end = rest(event);
      if (end !== null) out.push(end);
      return out;
    },
    /** TOOL_CALL_RESULT goes out after the tool's agent.message, which the library announces once it holds the result. */
    toolCallResult(event: BaseEvent & { messageId: string }) {
      const payload = rest(event);
      if (payload !== null) results.set(event.messageId, payload);
    },
    afterMessage(message: Message): AgentEventPayload | null {
      const payload = results.get(message.id) ?? null;
      results.delete(message.id);
      return payload;
    },
    /** An agent.message carried this message's text. */
    messageExpressed(message: Message) {
      expressed.messages.set(message.id, textOf(message));
    },
  };
}
