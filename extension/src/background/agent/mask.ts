// The agent events as they leave: masked by the Recorder's shared rules (shared/recorder-masking.ts) with the recording's
// sensitive-value digests, so a password the person typed earlier and then pasted into the chat comes out [redacted], and
// cut to fit one Intelligence event. CopilotKit's collector drops an event over 16 KiB; here the longest text is cut
// instead, so nothing vanishes, and `textLength` keeps the full length.
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
  let fitted = trimEvent(event, EVENT_BUDGET_BYTES, { strings: true }).event;
  if (isMinimal(fitted) && name === "agent.event")
    fitted = trimEvent(flattened(event), EVENT_BUDGET_BYTES, {
      strings: true,
    }).event;
  return isMinimal(fitted) ? skeleton(event) : fitted;
}
