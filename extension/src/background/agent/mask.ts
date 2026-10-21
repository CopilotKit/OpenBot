// The agent events as they leave: masked by the Recorder's shared rules (shared/recorder-masking.ts) with the recording's
// sensitive-value digests, so a password the person typed earlier and then pasted into the chat comes out [redacted], and
// cut to fit one Intelligence event. CopilotKit's collector drops an event over 16 KiB; here the longest text is cut
// instead, never an id, a name or an enum-like field, so nothing vanishes, the event still joins its Thread, run, messages
// and tool calls, and `textLength` keeps the full length.
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  type JsonValue,
  maskBody,
  maskJsonValue,
  sanitiseForIntelligence,
  trimEvent,
} from "@openbot/shared/recorder-masking";

/** The fields that join one AG-UI event or message to another: kept as they are, since the masking's long-run rule would
 * otherwise take every UUID. */
const IDS: ReadonlySet<string> = new Set([
  "id",
  "messageId",
  "toolCallId",
  "parentMessageId",
  "threadId",
  "runId",
  "parentRunId",
  "entityId",
  "interruptId",
  "subagentRunId",
  "agentId",
]);

/** The fields never cut to fit, at any depth: the ids above; the names of a tool, a step or an activity; and the short
 * enum-like fields an event, a message, a JSON Patch operation or a tool's JSON Schema hold (an event's type, a role, an
 * operation and its paths, a schema's types, required properties and enum values). What is cut is the bulky text:
 * descriptions, contents, arguments, context values, state. */
const KEPT_WHOLE: ReadonlySet<string> = new Set([
  ...IDS,
  "name",
  "toolCallName",
  "toolName",
  "stepName",
  "activityType",
  "type",
  "role",
  "phase",
  "status",
  "outcome",
  "reason",
  "code",
  "op",
  "path",
  "from",
  "format",
  "mimeType",
  "protocolVersion",
  "required",
  "enum",
]);

type Record_ = { [key: string]: JsonValue };

const isRecord = (value: unknown): value is Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Text a person or an agent wrote, or a tool's JSON: masked as a body is, so JSON is masked field by field. JSON the
 * masking leaves alone keeps its own layout. */
const maskText = (text: string, digests: ReadonlySet<string>): string => {
  const masked = maskBody(text, undefined, { digests });
  if (masked === text) return text;
  try {
    if (JSON.stringify(JSON.parse(text)) === masked) return text;
  } catch {
    // Not JSON: the masked text stands.
  }
  return masked;
};

/** One AG-UI event as agent.event carries it: its ids as they are, every text as a body, every structure as JSON. */
const maskPayload = (
  payload: Record_,
  digests: ReadonlySet<string>,
): Record_ => {
  const out: Record_ = {};
  for (const [field, value] of Object.entries(payload))
    out[field] =
      field === "type" || (IDS.has(field) && typeof value === "string")
        ? value
        : typeof value === "string"
          ? maskText(value, digests)
          : maskJsonValue(value, { digests }, IDS);
  return out;
};

const bytes = (event: CapturedEvent): number =>
  new TextEncoder().encode(JSON.stringify(event)).byteLength;

/** An agent.event still over budget once its strings are cut has more structure than fits (a large state or history):
 * its large fields go as their JSON text, which can be cut. Its ids and type stay. */
const flattened = (event: CapturedEvent): CapturedEvent => {
  const value = event.value as Record_;
  const payload = isRecord(value.event) ? value.event : {};
  const flat: Record_ = {};
  for (const [field, item] of Object.entries(payload))
    flat[field] =
      typeof item === "string" || typeof item === "number" || item === null
        ? item
        : JSON.stringify(item);
  return { ...event, value: { ...value, event: flat } };
};

const isMinimal = (event: CapturedEvent): boolean =>
  isRecord(event.value) && event.value.trimmed === true;

/** Cuts at a code unit count without leaving the first half of a surrogate pair at the end. */
const cutText = (text: string, length: number): string =>
  text.slice(
    0,
    length > 0 &&
      text.charCodeAt(length - 1) >= 0xd800 &&
      text.charCodeAt(length - 1) <= 0xdbff
      ? length - 1
      : length,
  );

/** Every string under a value that is not one of the KEPT_WHOLE fields, with where it sits so it can be cut in place. */
const cuttable = (
  value: JsonValue,
  out: { holder: Record_ | JsonValue[]; key: string | number; text: string }[],
  field: string | null,
): void => {
  const visit = (
    holder: Record_ | JsonValue[],
    key: string | number,
    item: JsonValue,
    itemField: string | null,
  ) => {
    if (typeof item === "string") {
      if (itemField === null || !KEPT_WHOLE.has(itemField))
        out.push({ holder, key, text: item });
    } else cuttable(item, out, itemField);
  };
  if (Array.isArray(value))
    for (const [index, item] of value.entries())
      visit(value, index, item, field);
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value))
      visit(value, key, item, key);
};

/** A RUN_STARTED over budget has the page's setup in its `input` (its tools' descriptions and schemas, its context) cut
 * first, to the longest one length that fits, so the conversation it carries (the person's messages, a frontend tool's
 * result, which nothing else carries) stays whole when cutting the setup is enough. */
const cutSetup = (event: CapturedEvent): CapturedEvent => {
  const value = event.value as Record_;
  const payload = isRecord(value.event) ? value.event : null;
  if (payload?.type !== "RUN_STARTED" || !isRecord(payload.input)) return event;
  const copy = structuredClone(event);
  const input = ((copy.value as Record_).event as Record_).input as Record_;
  const leaves: Parameters<typeof cuttable>[1] = [];
  for (const field of ["tools", "context"])
    if (input[field] !== undefined)
      cuttable(input[field] as JsonValue, leaves, field);
  if (leaves.length === 0) return event;
  const capAt = (length: number) => {
    for (const { holder, key, text } of leaves)
      (holder as Record<string | number, JsonValue>)[key] =
        text.length > length ? cutText(text, length) : text;
  };
  let fits = 0;
  let low = 0;
  let high = Math.max(...leaves.map(({ text }) => text.length)) - 1;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    capAt(length);
    if (bytes(copy) <= EVENT_BUDGET_BYTES) {
      fits = length;
      low = length + 1;
    } else high = length - 1;
  }
  capAt(fits);
  (copy.value as Record_).truncated = true;
  return copy;
};

/** What survives of an event nothing could make fit: its ids, and that it was cut. */
const skeleton = (event: CapturedEvent): CapturedEvent => {
  const value = event.value as Record_;
  const kept: Record_ = { trimmed: true };
  for (const [field, item] of Object.entries(value))
    if (IDS.has(field) || field === "phase" || field === "role")
      kept[field] = item;
  if (isRecord(value.event) && typeof value.event.type === "string")
    kept.event = { type: value.event.type };
  return { ...event, value: kept };
};

/**
 * One agent event ready for the Trajectory. Undefined fields are left out as JSON leaves them out (CopilotKit's events
 * pass through JSON on their way to Intelligence), the text and the AG-UI event are masked, and the result fits
 * EVENT_BUDGET_BYTES.
 */
export function finishAgentEvent(
  name: string,
  value: Record<string, unknown>,
  at: number,
  digests: ReadonlySet<string>,
): CapturedEvent {
  const plain = JSON.parse(JSON.stringify(value)) as Record_;
  if (typeof plain.text === "string")
    plain.text = maskText(plain.text, digests);
  if (isRecord(plain.event)) plain.event = maskPayload(plain.event, digests);
  const event: CapturedEvent = {
    type: "CUSTOM",
    name,
    timestamp: at,
    value: sanitiseForIntelligence(plain),
  };
  if (bytes(event) <= EVENT_BUDGET_BYTES) return event;
  const fit = { strings: true, keep: KEPT_WHOLE };
  const setupCut = name === "agent.event" ? cutSetup(event) : event;
  let fitted = trimEvent(setupCut, EVENT_BUDGET_BYTES, fit).event;
  if (isMinimal(fitted) && name === "agent.event")
    fitted = trimEvent(flattened(setupCut), EVENT_BUDGET_BYTES, fit).event;
  return isMinimal(fitted) ? skeleton(event) : fitted;
}
