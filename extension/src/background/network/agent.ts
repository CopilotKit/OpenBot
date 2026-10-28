// The AG-UI traffic Chrome's debugger shows in a followed tab, as the agent events read it (agent/observation.ts): each
// agent run a page posts, the events of its SSE or protobuf answer read live as they arrive (Network.streamResourceContent,
// then each Network.dataReceived carries its bytes), the AG-UI events its WebSockets receive, and CopilotKit's runtime
// `info` call when its runtime answers it (the page runs CopilotKit). The request tracker
// (debugger.ts) asks this which requests are runs: a run is never a step's save, nor a write a step waits for.

import {
  createChannels,
  createHttpStream,
  createSocketReader,
  isRuntimeInfoAnswer,
  matchRun,
  matchRuntimeInfoRequest,
  type PageObservation,
  type RunMatch,
  runChannel,
  streamFormat,
} from "../../shared/agui";
import type { CaptureObservation } from "../agent/observation";
import type { Debuggee } from "./debugger";

type Send = (
  target: Debuggee,
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The key the request tracker and this capture share for one request. */
export const requestKey = (target: Debuggee, requestId: string) =>
  `${target.tabId}/${target.sessionId ?? ""}/${requestId}`;

function headerValue(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name && typeof value === "string") return value;
  return undefined;
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();
/** A body Chrome hands over, as base64 or as text. */
const bodyBytes = (body: string, base64: boolean) =>
  base64 ? bytesOf(body) : encoder.encode(body);
const bodyText = (body: string, base64: boolean) =>
  base64 ? new TextDecoder().decode(bytesOf(body)) : body;

/** The resource types an AG-UI run or stream can be: the page's own requests and event sources, never a script,
 * a style sheet, an image or a document. */
const FOLLOWED_TYPES = new Set(["Fetch", "XHR", "EventSource", "Other"]);
/** How many verdicts wait for the tracker at most: it asks for each POST it follows, once. */
const MAX_VERDICTS = 512;

/** CDP's monotonic seconds against the wall clock (epoch ms) at one moment, to read later timestamps as wall time. */
type Clock = { monotonic: number; wall: number };
const wallAt = (clock: Clock, monotonic: number | undefined) =>
  monotonic === undefined
    ? Date.now()
    : Math.round(clock.wall + (monotonic - clock.monotonic) * 1000);

type Request = {
  target: Debuggee;
  requestId: string;
  url: string;
  clock: Clock;
  /** A POST whose body Chrome left out of requestWillBeSent: what it is waits for Network.getRequestPostData. */
  match: RunMatch | null | "pending";
  stream?: ReturnType<typeof createHttpStream>;
  /** Everything that happens to the request, in the order Chrome reported it: a body still being read holds what
   * came after it. */
  work: Promise<void>;
  /** The answer's binding, once its headers came: an SSE or protobuf answer is read for events. */
  format: "sse" | "proto" | null;
  /** live: the answer streams through dataReceived; waiting: streamResourceContent has not answered yet. */
  reading: "off" | "waiting" | "live";
  /** dataReceived bytes that came while streamResourceContent had not answered, after what it had buffered. */
  early: { bytes: Uint8Array; at: number }[];
  /** Whether the request is an agent run, for the tracker. */
  verdict: Verdict;
  /** CopilotKit's runtime `info` call: its answer is read once it finished. */
  info: boolean;
  /** Followed for its `info` call alone (`infoOnly`): never read as AG-UI or as a run. */
  infoOnly: boolean;
  /** The answer's status, once its headers came. */
  status: number | null;
};

/** Whether a request is an agent run: known at once for most, after its answer's first event for a candidate. */
export type RunVerdict = {
  readonly value?: boolean;
  readonly promise: Promise<boolean>;
  /** Chrome's answer to Network.getRequestPostData for a body it left out of requestWillBeSent: asked once, by the
   * AG-UI capture, for the tracker too. */
  readonly postData?: Promise<unknown>;
};
type Verdict = {
  value?: boolean;
  promise: Promise<boolean>;
  decide(run: boolean): void;
  postData?: Promise<unknown>;
};

function verdict(): Verdict {
  let decide: (run: boolean) => void = () => {};
  const result: Verdict = {
    promise: new Promise<boolean>((resolve) => {
      decide = resolve;
    }),
    decide(run) {
      if (result.value !== undefined) return;
      result.value = run;
      decide(run);
    },
  };
  return result;
}

type Socket = {
  tabId: number;
  clock?: Clock;
  reader: ReturnType<typeof createSocketReader>;
  /** Its frames, in order: each waits for the run answers its tab is still reading, which name the channels. */
  work: Promise<void>;
};

export type AgentCapture = ReturnType<typeof createAgentCapture>;

/**
 * Follows the AG-UI traffic per debuggee from the Network domain's events, and hands each observation to `observe`.
 * `ignore` names URLs never followed (OpenBot's own); `infoOnly` names URLs followed only when the request is
 * CopilotKit's runtime `info` call, and then only for its answer (OpenBot's own runtime); `onRun` says a request whose
 * body was read late is a run, so the tracker stops holding steps for it.
 */
export function createAgentCapture(options: {
  send: Send;
  observe(observation: CaptureObservation): void;
  ignore(url: string): boolean;
  infoOnly(url: string): boolean;
  onRun(key: string): void;
}) {
  const requests = new Map<string, Request>();
  const sockets = new Map<string, Socket>();
  /** Each tab's Intelligence channels, from its run answers, for the sockets that join them. */
  const channels = new Map<number, ReturnType<typeof createChannels>>();
  const channelsOf = (tabId: number) => {
    let known = channels.get(tabId);
    if (!known) {
      known = createChannels();
      channels.set(tabId, known);
    }
    return known;
  };
  /** What the tracker asks about a request after this capture let it go: its verdict, until the tracker had it. */
  const verdicts = new Map<string, Verdict>();
  /** Each tab's run answers still being read: a socket's frames wait for them, so a channel is known before its events. */
  const reading = new Map<number, Promise<unknown>>();

  const emitFor =
    (tabId: number) =>
    (observation: PageObservation): void => {
      try {
        options.observe({ ...observation, tabId } as CaptureObservation);
      } catch (error) {
        console.error("Recorder: an agent observation failed", error);
      }
    };

  /** Runs `step` after everything the request had queued, so its observations keep Chrome's order. */
  const then = (request: Request, step: () => Promise<void> | void) => {
    request.work = request.work.then(step).catch((error) => {
      console.error("Recorder: an agent stream could not be read", error);
    });
  };

  /** A post body's text from Chrome's answer to Network.getRequestPostData. */
  const postText = (answer: unknown): string | undefined =>
    isRecord(answer) && typeof answer.postData === "string"
      ? bodyText(answer.postData, answer.base64Encoded === true)
      : undefined;

  function begin(request: Request, match: RunMatch | null, at: number) {
    request.match = match;
    // Not a run, the request is still followed: an event stream it answers with is AG-UI from its agent.
    request.stream = createHttpStream({
      streamId: requestKey(request.target, request.requestId),
      url: request.url,
      match,
      at,
      emit: emitFor(request.target.tabId),
    });
    if (match?.kind === "run") request.verdict.decide(true);
    else if (match?.kind !== "candidate") request.verdict.decide(false);
  }

  function onRequest(target: Debuggee, raw: Json): void {
    const requestId = string(raw.requestId);
    const sent = isRecord(raw.request) ? raw.request : null;
    const url = string(sent?.url);
    if (requestId === undefined || !sent || url === undefined) return;
    const key = requestKey(target, requestId);
    // A redirect reuses the request id: the one it lands on is followed from here.
    requests.delete(key);
    const type = string(raw.type);
    if (
      options.ignore(url) ||
      (type !== undefined && !FOLLOWED_TYPES.has(type))
    )
      return;
    const method = (string(sent.method) ?? "GET").toUpperCase();
    const inline = string(sent.postData);
    const infoOnly = options.infoOnly(url);
    // A URL followed for the info call alone: any other request to it is not followed at all.
    if (infoOnly && !matchRuntimeInfoRequest(url, method, inline)) return;
    const wallTime = number(raw.wallTime);
    const clock: Clock = {
      monotonic: number(raw.timestamp) ?? 0,
      wall: wallTime === undefined ? Date.now() : Math.round(wallTime * 1000),
    };
    const request: Request = {
      target,
      requestId,
      url,
      clock,
      match: null,
      work: Promise.resolve(),
      format: null,
      reading: "off",
      early: [],
      verdict: verdict(),
      info: infoOnly,
      infoOnly,
      status: null,
    };
    requests.set(key, request);
    if (infoOnly) {
      request.verdict.decide(false);
      return;
    }
    if (method === "POST") {
      verdicts.set(key, request.verdict);
      for (const oldest of verdicts.keys()) {
        if (verdicts.size <= MAX_VERDICTS) break;
        verdicts.delete(oldest);
      }
    }
    request.info = matchRuntimeInfoRequest(url, method, inline);
    if (
      method !== "POST" ||
      inline !== undefined ||
      sent.hasPostData !== true
    ) {
      begin(request, matchRun(url, method, inline), clock.wall);
      return;
    }
    // CDP leaves out a body over Network.enable's maxPostDataSize (CopilotKit's run bodies grow with the Thread).
    request.match = "pending";
    const answer = options.send(target, "Network.getRequestPostData", {
      requestId,
    });
    request.verdict.postData = answer;
    // What the body is decides the tracker's verdict as soon as it is read; the stream begins in its turn.
    const matched = answer
      .then(postText, () => undefined)
      .then((body) => {
        request.info = matchRuntimeInfoRequest(url, method, body);
        const match = matchRun(url, method, body);
        if (match?.kind !== "run" && match?.kind !== "candidate")
          request.verdict.decide(false);
        return match;
      });
    then(request, async () => {
      const match = await matched;
      begin(request, match, clock.wall);
      if (match && match.kind !== "none") options.onRun(key);
    });
  }

  /** Reads the answer live from here on: what Chrome buffered so far comes back, every later dataReceived carries
   * its bytes. A response that already finished cannot stream; its body is read at loadingFinished instead. */
  function stream(request: Request, at: number): void {
    request.reading = "waiting";
    const answer = options.send(
      request.target,
      "Network.streamResourceContent",
      { requestId: request.requestId },
    );
    then(request, async () => {
      let buffered: string | undefined;
      try {
        const result = await answer;
        buffered = isRecord(result) ? string(result.bufferedData) : undefined;
      } catch {
        request.reading = "off";
        request.early = [];
        return;
      }
      request.reading = "live";
      if (buffered) request.stream?.data(bytesOf(buffered), at);
      for (const chunk of request.early.splice(0))
        request.stream?.data(chunk.bytes, chunk.at);
    });
  }

  function onResponse(target: Debuggee, raw: Json): void {
    const requestId = string(raw.requestId);
    const response = isRecord(raw.response) ? raw.response : null;
    if (requestId === undefined || !response) return;
    const request = requests.get(requestKey(target, requestId));
    if (!request) return;
    const contentType =
      string(response.mimeType) ||
      headerValue(response.headers, "content-type");
    const status = number(response.status) ?? 0;
    const at = wallAt(request.clock, number(raw.timestamp));
    request.status = status;
    request.format = streamFormat(contentType);
    then(request, () => {
      request.stream?.response(contentType, status);
      if (request.stream?.isRun() === false) request.verdict.decide(false);
    });
    if (request.format && !request.infoOnly) stream(request, at);
  }

  function onData(target: Debuggee, raw: Json): void {
    const requestId = string(raw.requestId);
    const data = string(raw.data);
    if (requestId === undefined || data === undefined) return;
    const request = requests.get(requestKey(target, requestId));
    // A stream that showed it is not AG-UI (another app's event stream) keeps coming: its bytes are not even decoded.
    if (!request || request.reading === "off" || request.stream?.ignored())
      return;
    const chunk = {
      bytes: bytesOf(data),
      at: wallAt(request.clock, number(raw.timestamp)),
    };
    if (request.reading === "waiting") {
      request.early.push(chunk);
      return;
    }
    then(request, () => {
      request.stream?.data(chunk.bytes, chunk.at);
      const run = request.stream?.isRun();
      if (run !== null && run !== undefined) request.verdict.decide(run);
    });
  }

  function onDone(target: Debuggee, raw: Json, ok: boolean): void {
    const requestId = string(raw.requestId);
    if (requestId === undefined) return;
    const key = requestKey(target, requestId);
    const request = requests.get(key);
    if (!request) return;
    requests.delete(key);
    const at = wallAt(request.clock, number(raw.timestamp));
    const { tabId } = target;
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    reading.set(tabId, Promise.all([reading.get(tabId), finished]));
    then(request, async () => {
      try {
        await finish(request, ok, at);
      } finally {
        done();
      }
    });
  }

  /** CopilotKit's runtime `info` call answered: when its answer is CopilotKit's RuntimeInfo, the page runs CopilotKit. */
  async function runtimeInfo(request: Request, at: number) {
    const body = await options
      .send(request.target, "Network.getResponseBody", {
        requestId: request.requestId,
      })
      .catch(() => null);
    if (
      isRecord(body) &&
      typeof body.body === "string" &&
      isRuntimeInfoAnswer(
        request.status,
        bodyText(body.body, body.base64Encoded === true),
      )
    )
      emitFor(request.target.tabId)({ kind: "runtime", url: request.url, at });
  }

  async function finish(request: Request, ok: boolean, at: number) {
    if (ok && request.info) await runtimeInfo(request, at);
    const { stream, match } = request;
    if (!stream || match === "pending") return;
    const run = match?.kind === "run";
    // An event stream that could not be read live (it finished first) is read whole now; a run's JSON answer may
    // name the Intelligence channel its events stream on.
    if (ok && request.reading !== "live" && (run || request.format)) {
      const body = await options
        .send(request.target, "Network.getResponseBody", {
          requestId: request.requestId,
        })
        .catch(() => null);
      if (isRecord(body) && typeof body.body === "string") {
        const base64 = body.base64Encoded === true;
        if (request.format) stream.data(bodyBytes(body.body, base64), at);
        const channel = run ? runChannel(bodyText(body.body, base64)) : null;
        if (channel)
          channelsOf(request.target.tabId).set(channel.topic, {
            agentId: match?.agentId ?? null,
            threadId: channel.threadId ?? match?.threadId ?? null,
          });
      }
    }
    stream.finish(ok, at);
    request.verdict.decide(stream.isRun() === true);
  }

  function socketFor(target: Debuggee, requestId: string): Socket | undefined {
    return sockets.get(requestKey(target, requestId));
  }

  function onSocketCreated(target: Debuggee, raw: Json): void {
    const requestId = string(raw.requestId);
    const url = string(raw.url);
    if (requestId === undefined || url === undefined) return;
    let followed = true;
    try {
      const parsed = new URL(url);
      parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
      followed = !options.ignore(parsed.href);
    } catch {
      followed = false;
    }
    const key = requestKey(target, requestId);
    if (!followed) {
      sockets.delete(key);
      return;
    }
    sockets.set(key, {
      tabId: target.tabId,
      work: Promise.resolve(),
      reader: createSocketReader({
        streamId: (topic, n) =>
          topic === null ? `${key}/ws/${n}` : `${key}/ws/${n}/${topic}`,
        emit: emitFor(target.tabId),
        channels: channelsOf(target.tabId),
      }),
    });
  }

  /** Frames carry only CDP's monotonic time: the handshake ties it to the wall clock. */
  function onHandshake(target: Debuggee, raw: Json): void {
    const socket = socketFor(target, string(raw.requestId) ?? "");
    const monotonic = number(raw.timestamp);
    const wall = number(raw.wallTime);
    if (socket && monotonic !== undefined && wall !== undefined)
      socket.clock = { monotonic, wall: Math.round(wall * 1000) };
  }

  function onFrame(target: Debuggee, raw: Json, received: boolean): void {
    const socket = socketFor(target, string(raw.requestId) ?? "");
    const frame = isRecord(raw.response) ? raw.response : null;
    // Text frames only (opcode 1): a binary frame's payload is base64 and never a JSON AG-UI event.
    if (!socket || !frame || frame.opcode !== 1) return;
    const data = string(frame.payloadData);
    if (data === undefined) return;
    const timestamp = number(raw.timestamp);
    const at = socket.clock ? wallAt(socket.clock, timestamp) : Date.now();
    queue(socket, () => {
      if (received) socket.reader.received(data, at);
      else socket.reader.sent(data, at);
    });
  }

  function queue(socket: Socket, step: () => void): void {
    const pending = reading.get(socket.tabId);
    socket.work = socket.work
      .then(() => pending)
      .then(step)
      .catch((error) => {
        console.error("Recorder: a WebSocket frame could not be read", error);
      });
  }

  function onSocketClosed(target: Debuggee, raw: Json): void {
    const key = requestKey(target, string(raw.requestId) ?? "");
    const socket = sockets.get(key);
    if (!socket) return;
    sockets.delete(key);
    const timestamp = number(raw.timestamp);
    const at = socket.clock ? wallAt(socket.clock, timestamp) : Date.now();
    queue(socket, () => socket.reader.closed(at));
  }

  return {
    onEvent(target: Debuggee, method: string, raw: unknown): void {
      if (!isRecord(raw)) return;
      switch (method) {
        case "Network.requestWillBeSent":
          onRequest(target, raw);
          return;
        case "Network.responseReceived":
          onResponse(target, raw);
          return;
        case "Network.dataReceived":
          onData(target, raw);
          return;
        case "Network.loadingFinished":
          onDone(target, raw, true);
          return;
        case "Network.loadingFailed":
          onDone(target, raw, false);
          return;
        case "Network.webSocketCreated":
          onSocketCreated(target, raw);
          return;
        case "Network.webSocketWillSendHandshakeRequest":
          onHandshake(target, raw);
          return;
        case "Network.webSocketFrameReceived":
          onFrame(target, raw, true);
          return;
        case "Network.webSocketFrameSent":
          onFrame(target, raw, false);
          return;
        case "Network.webSocketClosed":
          onSocketClosed(target, raw);
          return;
      }
    },
    /** What the tracker reads at requestWillBeSent: a run or a candidate is never a write a step waits for; a body
     * still being read is, until onRun says otherwise. */
    kind(key: string): "run" | "candidate" | "pending" | null {
      const match = requests.get(key)?.match;
      if (match === "pending") return "pending";
      if (match?.kind === "run" || match?.kind === "candidate")
        return match.kind;
      return null;
    },
    /** Whether the request is an agent run (`value` once known, `promise` until then), and the body this capture read
     * for it when Chrome left it out. The tracker never makes a run a step's call. */
    inspect(key: string): RunVerdict | undefined {
      return verdicts.get(key);
    },
    /** The tracker had the request: its verdict is no longer kept. */
    release(key: string): void {
      verdicts.delete(key);
    },
    /** A tab that closed or navigated away: its requests and sockets are dropped, their streams unended. */
    forgetTab(tabId: number): void {
      for (const [key, request] of requests)
        if (request.target.tabId === tabId) {
          requests.delete(key);
          request.verdict.decide(false);
        }
      for (const [key, socket] of sockets)
        if (socket.tabId === tabId) sockets.delete(key);
      for (const [key, known] of verdicts)
        if (key.startsWith(`${tabId}/`)) {
          known.decide(false);
          verdicts.delete(key);
        }
      channels.delete(tabId);
      reading.delete(tabId);
    },
    clear(): void {
      for (const known of verdicts.values()) known.decide(false);
      requests.clear();
      sockets.clear();
      verdicts.clear();
      channels.clear();
      reading.clear();
    },
  };
}
