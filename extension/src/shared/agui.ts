// What AG-UI looks like on the wire, read the same way by the debugger capture in the service worker and by the page
// hook in the MAIN world: which POST is an agent run, the events of a run's SSE or protobuf response as its bytes arrive,
// the AG-UI events a WebSocket receives (CopilotKit Intelligence's Phoenix channel, or AG-UI over a plain socket), and
// the call by which a page running CopilotKit asks its runtime what it serves.
// Everything here is raw and unmasked; the agent events (background/agent/events.ts) mask what leaves.
import { EventType } from "@ag-ui/core";
import { AGUIUnknownEventTypeError, decode } from "@ag-ui/proto";
import { createParser } from "eventsource-parser";
import type {
  AgentObservation,
  AgentRuntimeInfo,
} from "../background/agent/observation";

/** An observation as a page or a socket reader produces it: the capture adds the tab. */
export type StreamObservation =
  | Omit<Extract<AgentObservation, { kind: "request" }>, "tabId">
  | Omit<Extract<AgentObservation, { kind: "event" }>, "tabId">
  | Omit<Extract<AgentObservation, { kind: "end" }>, "tabId">;

/** That the page runs CopilotKit, as a page or the debugger sees it: the capture adds the tab. */
export type RuntimeObservation = Omit<AgentRuntimeInfo, "tabId">;

/** Everything a capture hands over for one tab. */
export type PageObservation = StreamObservation | RuntimeObservation;

/** AG-UI's protobuf binding (`@ag-ui/proto` AGUI_MEDIA_TYPE). */
export const AGUI_PROTO_TYPE = "application/vnd.ag-ui.event+proto";
/** The most a stream's unparsed tail may hold, as `@ag-ui/client` 1.0.2 caps its SSE and protobuf buffers. */
const MAX_BUFFER = 10 * 1024 * 1024;
const EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(EventType));

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** An AG-UI event: an object whose `type` is one of `@ag-ui/core` 1.0.2's EventType values. */
export function isAgUiEvent(value: unknown): value is Json & { type: string } {
  return isRecord(value) && typeof value.type === "string"
    ? EVENT_TYPES.has(value.type)
    : false;
}

/** The binding a response's content type names: SSE, protobuf, or neither. */
export function streamFormat(
  contentType: string | null | undefined,
): "sse" | "proto" | null {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (type === "text/event-stream") return "sse";
  if (type === AGUI_PROTO_TYPE) return "proto";
  return null;
}

/** What a POST is to AG-UI. `run`: CopilotKit's runtime route (`/agent/<id>/run` or `/agent/<id>/connect`) or its
 * single-route `{ method, params, body }` envelope says so. `candidate`: a body with a string threadId, a string runId
 * and a messages array, which is a run when its answer turns out to be an AG-UI stream. `none`: anything else, with
 * the agent and Thread it names when it is one of CopilotKit's other agent routes (`/agent/<id>/suggest`). */
export type RunMatch = {
  kind: "run" | "candidate" | "none";
  method: "agent/run" | "agent/connect";
  agentId: string | null;
  threadId: string | null;
  /** The RunAgentInput as the page sent it, unwrapped from the envelope (the body's text when it is not JSON). */
  input: unknown;
};

const decodeSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment) || null;
  } catch {
    return null;
  }
};

/** CopilotKit's agent routes, matched on the path's end as its runtime router (fetch-router.ts) matches them. */
function agentRoute(
  url: string,
): { action: string; agentId: string | null } | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const segments = path.split("/").filter(Boolean);
  const at = segments.lastIndexOf("agent");
  if (at < 0 || at + 2 >= segments.length) return null;
  const action = segments[at + 2] ?? "";
  const rest = segments.length - at - 3;
  // `/agent/<id>/run|connect|suggest` end the path; `/agent/<id>/stop/<threadId>` has one more segment.
  if ((action === "stop" && rest === 1) || rest === 0)
    return { action, agentId: decodeSegment(segments[at + 1] ?? "") };
  return null;
}

/** Which POST is an AG-UI run (see RunMatch); null for anything that is not a POST. */
export function matchRun(
  url: string,
  method: string,
  body: string | undefined,
): RunMatch | null {
  if (method.toUpperCase() !== "POST") return null;
  let parsed: unknown;
  try {
    parsed = body === undefined ? undefined : JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const route = agentRoute(url);
  const threadOf = (input: unknown) =>
    isRecord(input) ? text(input.threadId) : null;
  if (route && (route.action === "run" || route.action === "connect")) {
    const input = parsed === undefined ? (body ?? null) : parsed;
    return {
      kind: "run",
      method: route.action === "run" ? "agent/run" : "agent/connect",
      agentId: route.agentId,
      threadId: threadOf(input),
      input,
    };
  }
  if (
    !route &&
    isRecord(parsed) &&
    (parsed.method === "agent/run" || parsed.method === "agent/connect")
  ) {
    const params = isRecord(parsed.params) ? parsed.params : {};
    return {
      kind: "run",
      method: parsed.method,
      agentId: text(params.agentId),
      threadId: threadOf(parsed.body),
      input: parsed.body ?? null,
    };
  }
  const shaped =
    isRecord(parsed) &&
    typeof parsed.threadId === "string" &&
    typeof parsed.runId === "string" &&
    Array.isArray(parsed.messages);
  return {
    // CopilotKit's other agent routes (a suggestion, a stop) are never a run, whatever their body.
    kind: shaped && !route ? "candidate" : "none",
    method: "agent/run",
    agentId: route?.agentId ?? null,
    threadId: threadOf(parsed),
    input: parsed ?? null,
  };
}

/** CopilotKit's runtime `info` call, as its AgentRegistry makes it: a GET of `<runtime>/info` (the REST transport, and
 * the first try of the automatic one), or a POST of the single route's `{ "method": "info" }`; a POST to a path ending
 * in `/info` counts too. Whether it is CopilotKit's runtime that answers is for isRuntimeInfoAnswer to say. */
export function matchRuntimeInfoRequest(
  url: string,
  method: string,
  body: string | undefined,
): boolean {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "POST") return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (/\/info\/?$/.test(path)) return true;
  if (verb !== "POST" || body === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && parsed.method === "info";
  } catch {
    return false;
  }
}

/** CopilotKit's RuntimeInfo (`@copilotkit/runtime` get-runtime-info.ts): a successful JSON answer naming the runtime's
 * `version` and the `agents` it serves. An app's own `/info` says neither. */
export function isRuntimeInfoAnswer(
  status: number | null,
  text: string | undefined,
): boolean {
  if (status === null || status < 200 || status >= 300 || text === undefined)
    return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      isRecord(parsed) &&
      typeof parsed.version === "string" &&
      isRecord(parsed.agents)
    );
  } catch {
    return false;
  }
}

/** Reads one response's bytes into AG-UI events as they arrive. The first event decides: a stream whose first event
 * is not AG-UI is not AG-UI, and nothing more of it is read. */
export type StreamReader = {
  push(bytes: Uint8Array): void;
  /** The stream ended: an unterminated last SSE event or a partial protobuf frame is dropped. */
  end(): void;
  readonly verdict: "pending" | "agui" | "other";
};

export function createStreamReader(
  format: "sse" | "proto",
  onEvent: (event: Json & { type: string }) => void,
): StreamReader {
  let verdict: StreamReader["verdict"] = "pending";
  /** Decides on the first event, then hands on each AG-UI one; a later event that is not AG-UI is skipped. */
  const take = (value: unknown) => {
    if (verdict === "other") return;
    const agUi = isAgUiEvent(value);
    if (verdict === "pending") verdict = agUi ? "agui" : "other";
    if (agUi) onEvent(value);
  };
  if (format === "sse") {
    // WHATWG's event stream interpretation: CR, LF or CRLF line ends, `data:` lines joined, comments, `event:`,
    // `id:` and `retry:` fields, a leading BOM, chunks split anywhere (a UTF-8 sequence too: the decoder streams).
    const decoder = new TextDecoder("utf-8");
    const parser = createParser({
      maxBufferSize: MAX_BUFFER,
      onEvent: (message) => {
        let value: unknown;
        try {
          value = JSON.parse(message.data);
        } catch {
          value = undefined;
        }
        take(value);
      },
      onError: (error) => {
        if (error.type === "max-buffer-size-exceeded" && verdict === "pending")
          verdict = "other";
      },
    });
    return {
      push(bytes) {
        if (verdict !== "other")
          parser.feed(decoder.decode(bytes, { stream: true }));
      },
      end() {
        if (verdict !== "other") parser.feed(decoder.decode());
      },
      get verdict() {
        return verdict;
      },
    };
  }
  // The protobuf binding: each event a 4-byte big-endian length, then the encoded message.
  let buffer = new Uint8Array(0);
  return {
    push(bytes) {
      if (verdict === "other") return;
      const joined = new Uint8Array(buffer.length + bytes.length);
      joined.set(buffer);
      joined.set(bytes, buffer.length);
      buffer = joined;
      while (buffer.length >= 4 && verdict !== "other") {
        const size = new DataView(
          buffer.buffer,
          buffer.byteOffset,
          4,
        ).getUint32(0, false);
        if (size + 4 > MAX_BUFFER) {
          verdict = "other";
          return;
        }
        if (buffer.length < size + 4) return;
        const frame = buffer.slice(4, size + 4);
        buffer = buffer.slice(size + 4);
        try {
          take(decode(frame));
        } catch (error) {
          // An event of a later protocol is dropped as @ag-ui/client drops it; bytes that do not decode end the stream.
          if (!(error instanceof AGUIUnknownEventTypeError)) verdict = "other";
        }
      }
    },
    end() {
      buffer = new Uint8Array(0);
    },
    get verdict() {
      return verdict;
    },
  };
}

/** The Thread and agent a channel topic carries (an Intelligence run's `realtime.topic`), from the run's own answer. */
export type Channels = {
  get(
    topic: string,
  ): { agentId: string | null; threadId: string | null } | undefined;
  set(
    topic: string,
    channel: { agentId: string | null; threadId: string | null },
  ): void;
};

/** The last few channels Intelligence run answers named: enough for every socket a tab has open. */
export function createChannels(limit = 64): Channels {
  const channels = new Map<
    string,
    { agentId: string | null; threadId: string | null }
  >();
  return {
    get: (topic) => channels.get(topic),
    set(topic, channel) {
      channels.delete(topic);
      channels.set(topic, channel);
      for (const oldest of channels.keys()) {
        if (channels.size <= limit) break;
        channels.delete(oldest);
      }
    },
  };
}

/** An Intelligence run or connect answers with the channel its events stream on instead of a stream:
 * `{ threadId, runId, joinToken, realtime: { clientUrl, topic } }` (CopilotKit intelligence-agent.ts). */
export function runChannel(
  body: string,
): { topic: string; threadId: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.realtime)) return null;
  const topic = text(parsed.realtime.topic);
  return topic ? { topic, threadId: text(parsed.threadId) } : null;
}

/** One Phoenix channel message: V2 JSON frames are `[joinRef, ref, topic, event, payload]`, V1 frames are objects. */
export type PhoenixMessage = {
  topic: string;
  event: string;
  payload: unknown;
};

export function phoenixMessage(value: unknown): PhoenixMessage | null {
  if (Array.isArray(value)) {
    const [, , topic, event, payload] = value;
    return value.length === 5 &&
      typeof topic === "string" &&
      typeof event === "string"
      ? { topic, event, payload }
      : null;
  }
  if (
    isRecord(value) &&
    typeof value.topic === "string" &&
    typeof value.event === "string" &&
    "payload" in value &&
    "ref" in value
  )
    return { topic: value.topic, event: value.event, payload: value.payload };
  return null;
}

/** The Thread a channel's topic or join names: Intelligence's `thread:<threadId>`, or a join's own thread field. */
function topicThread(topic: string, join: Json | undefined): string | null {
  if (topic.startsWith("thread:")) return text(topic.slice(7));
  return text(join?.threadId) ?? text(join?.thread_id);
}

/** The AG-UI streams on one WebSocket: one per Phoenix topic, or one for AG-UI events sent as plain frames. Only what
 * the socket receives is an event; what the page sends (a join, its own trajectory batches) never is. */
export function createSocketReader(options: {
  /** The socket's own stream id for a topic (null: plain frames); `n` counts its streams, from 0. */
  streamId(topic: string | null, n: number): string;
  emit(observation: StreamObservation): void;
  channels: Channels;
}) {
  type Stream = { id: string; agentId: string | null; threadId: string | null };
  const open = new Map<string | null, Stream>();
  const joins = new Map<string, Json>();
  let count = 0;

  const streamFor = (topic: string | null): Stream => {
    const known = open.get(topic);
    if (known) return known;
    const channel = topic === null ? undefined : options.channels.get(topic);
    const join = topic === null ? undefined : joins.get(topic);
    const stream: Stream = {
      id: options.streamId(topic, count++),
      agentId:
        channel?.agentId ?? text(join?.agentId) ?? text(join?.agent_id) ?? null,
      threadId:
        channel?.threadId ?? (topic === null ? null : topicThread(topic, join)),
    };
    open.set(topic, stream);
    return stream;
  };
  const end = (topic: string | null, at: number) => {
    const stream = open.get(topic);
    if (!stream) return;
    open.delete(topic);
    options.emit({ kind: "end", streamId: stream.id, at, outcome: "complete" });
  };
  const deliver = (topic: string | null, event: Json, at: number) => {
    const stream = streamFor(topic);
    options.emit({
      kind: "event",
      streamId: stream.id,
      at,
      agentId: stream.agentId,
      threadId: stream.threadId,
      event,
    });
  };
  const parse = (data: string): unknown => {
    try {
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  };

  return {
    /** A text frame the page sent: a Phoenix join names its channel, a leave ends it. */
    sent(data: string, at: number): void {
      const message = phoenixMessage(parse(data));
      if (!message) return;
      if (message.event === "phx_join" && isRecord(message.payload))
        joins.set(message.topic, message.payload);
      if (message.event === "phx_leave") end(message.topic, at);
    },
    /** A text frame the socket received: a Phoenix `ag_ui_event` carries one event as its payload (with Intelligence's
     * routing fields, kept as they are), and a plain frame may be an AG-UI event itself. */
    received(data: string, at: number): void {
      const value = parse(data);
      const message = phoenixMessage(value);
      if (message) {
        if (message.event === "ag_ui_event" && isAgUiEvent(message.payload))
          deliver(message.topic, message.payload, at);
        else if (message.event === "phx_close") end(message.topic, at);
        return;
      }
      if (isAgUiEvent(value)) deliver(null, value, at);
    },
    /** The socket closed: every stream on it ends. */
    closed(at: number): void {
      for (const topic of [...open.keys()]) end(topic, at);
    },
  };
}

/** One HTTP request's AG-UI stream: its run request when it is one, the events of its answer as they arrive, and its
 * end. A candidate's request goes out only once its answer's first event shows it is AG-UI. */
export function createHttpStream(options: {
  streamId: string;
  url: string;
  match: RunMatch | null;
  /** When the request was sent. */
  at: number;
  emit(observation: StreamObservation): void;
}) {
  const { match, streamId } = options;
  let reader: StreamReader | null = null;
  let requested = false;
  let status = 0;
  let ended = false;
  let at = options.at;

  const request = () => {
    if (requested || !match || match.kind === "none") return;
    requested = true;
    options.emit({
      kind: "request",
      streamId,
      at: options.at,
      url: options.url,
      agentId: match.agentId,
      method: match.method,
      input: match.input,
    });
  };
  if (match?.kind === "run") request();

  return {
    /** The answer's headers: an SSE or protobuf answer is read for events. */
    response(contentType: string | null | undefined, code: number): void {
      status = code;
      const format = streamFormat(contentType);
      if (!format || reader) return;
      reader = createStreamReader(format, (event) => {
        if (ended) return;
        request();
        options.emit({
          kind: "event",
          streamId,
          at,
          agentId: match?.agentId ?? null,
          threadId: match?.threadId ?? null,
          event,
        });
      });
    },
    /** Bytes of the answer, in order, received at `when`. */
    data(bytes: Uint8Array, when: number): void {
      at = when;
      if (!ended) reader?.push(bytes);
    },
    /** The answer finished (`ok`) or failed at `when`; a run, or a stream that was AG-UI, ends. */
    finish(ok: boolean, when: number): void {
      if (ended) return;
      at = when;
      reader?.end();
      ended = true;
      if (requested || reader?.verdict === "agui")
        options.emit({
          kind: "end",
          streamId,
          at: when,
          outcome: ok && status > 0 && status < 400 ? "complete" : "failed",
        });
    },
    /** The answer showed it is no AG-UI stream: nothing more of it is read. */
    ignored(): boolean {
      return reader?.verdict === "other";
    },
    /** Whether this request is an agent run: a run is from the start, a candidate once its first event was AG-UI.
     * Null while a candidate's answer has not decided. */
    isRun(): boolean | null {
      if (match?.kind === "run") return true;
      if (match?.kind !== "candidate") return false;
      if (reader?.verdict === "agui") return true;
      return ended || reader?.verdict === "other" || (status > 0 && !reader)
        ? false
        : null;
    },
  };
}
