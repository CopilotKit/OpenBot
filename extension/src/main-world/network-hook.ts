// The page-level network hook: a classic script the service worker injects into the MAIN world of recorded tabs only,
// when policy refuses the debugger. It wraps fetch and XMLHttpRequest, masks each finished request IN THE PAGE (each
// body read up to NETWORK_BODY_READ_MAX_BYTES and masked as one piece, so a credential-named key is redacted wherever it
// sits), trims the event to fit one Intelligence event, and hands it to the service worker through
// chrome.runtime.sendMessage. It never uses window.postMessage: anything posted to the window is readable by every script
// on the page.
//
// It also sees the page's AG-UI traffic as the debugger does (shared/agui.ts): an agent run's request, the events of an
// SSE or protobuf answer read through response.clone() as they arrive, and the AG-UI events each WebSocket receives,
// sent raw as `recorder.page-agent` observations for the agent events to mask. An agent run is never a network event.
// The page gets its own response and socket untouched, and nothing on its path waits for any of this.

import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  type JsonValue,
  maskNetworkEvent,
  sanitiseForIntelligence,
  trimEvent,
} from "@openbot/shared/recorder-masking";
import {
  type Channels,
  createChannels,
  createHttpStream,
  createSocketReader,
  isRuntimeInfoAnswer,
  matchRun,
  matchRuntimeInfoRequest,
  type PageObservation,
  runChannel,
  streamFormat,
} from "../shared/agui";
import {
  type NetworkBody as Body,
  isReadableBody as isReadable,
  textBody,
  unavailableBody as unavailable,
} from "../shared/network-body";

type Transport = "fetch" | "xhr";
type Outcome = "ok" | "error" | "aborted";
type Request = { url: string; method: string; headers: Record<string, string> };

const CONFIGURE = Symbol.for("openbot.recorder.configure");
const STOP = Symbol.for("openbot.recorder.stop");
const registry = globalThis as unknown as Record<symbol, unknown>;

// Pages matching externally_connectable (all URLs) get chrome.runtime.sendMessage; the page's own scripts could replace it
// later, so it is captured once, at load.
const send = (
  globalThis as { chrome?: { runtime?: typeof chrome.runtime } }
).chrome?.runtime?.sendMessage?.bind(
  (globalThis as { chrome: { runtime: typeof chrome.runtime } }).chrome.runtime,
) as ((id: string, message: unknown) => unknown) | undefined;

const absolute = (url: string) => new URL(url, location.href).href;
const isAbort = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "AbortError";

/** The Content-Type the browser adds when a page sends a body without one (the Fetch standard's "extract a body", which
 * XHR send() follows, and send()'s own rule for a Document). The page never sees it, but the body must be masked as what
 * it is: a URLSearchParams body is a form, so its credential pairs are redacted by key. */
function impliedContentType(body: unknown): string | undefined {
  if (typeof body === "string") return "text/plain;charset=UTF-8";
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
    return "application/x-www-form-urlencoded;charset=UTF-8";
  // The browser adds a boundary of its own choosing, which the page cannot see.
  if (typeof FormData !== "undefined" && body instanceof FormData)
    return "multipart/form-data";
  if (typeof Blob !== "undefined" && body instanceof Blob)
    return body.type || undefined;
  if (typeof Document !== "undefined" && body instanceof Document)
    return body.contentType === "text/html"
      ? "text/html;charset=UTF-8"
      : "application/xml;charset=UTF-8";
  return undefined;
}

/** Records the implied Content-Type in the request's own headers when the page set none, as the debugger would see it. */
function withImpliedContentType(
  headers: Record<string, string>,
  body: unknown,
): void {
  if (body === undefined || body === null || "content-type" in headers) return;
  const implied = impliedContentType(body);
  if (implied) headers["content-type"] = implied;
}

function sentBody(
  body: unknown,
  contentType: string | undefined,
): Body | Promise<Body> {
  if (body === undefined || body === null) return { status: "empty" };
  if (typeof body === "string") return textBody(body);
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
    return textBody(body.toString());
  if (typeof Document !== "undefined" && body instanceof Document)
    return textBody(new XMLSerializer().serializeToString(body));
  return unavailable(isReadable(contentType) ? "unread" : "binary");
}

async function receivedBody(response: Response): Promise<Body> {
  if (response.type === "opaque" || response.type === "opaqueredirect")
    return unavailable("opaque-response");
  if (!isReadable(response.headers.get("content-type")))
    return unavailable("binary");
  return textBody(await response.clone().text());
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

function report(
  transport: Transport,
  extensionId: string,
  request: Request,
  startedAt: number,
  status: number | null,
  outcome: Outcome,
  requestBody: Body | Promise<Body>,
  response: {
    url?: string;
    headers: Record<string, string>;
    body: Promise<Body>;
  },
): void {
  const durationMs = Math.round(performance.now() - startedAt);
  const completedAt = Date.now();
  void Promise.all([requestBody, response.body])
    .then(
      ([sent, received]) =>
        new Promise<void>((resolve) =>
          // Masking a large body is slow: do it after the page's own work, never inside the request path.
          setTimeout(() => {
            try {
              const url = new URL(request.url);
              const event: CapturedEvent = {
                type: "CUSTOM",
                name: "network",
                timestamp: completedAt,
                value: {
                  transport,
                  method: request.method,
                  url: request.url,
                  origin: url.origin,
                  route: url.pathname,
                  status,
                  durationMs,
                  completedAt,
                  outcome,
                  request: {
                    headers: request.headers,
                    body: sent as unknown as JsonValue,
                  },
                  response: {
                    ...(response.url ? { url: response.url } : {}),
                    headers: response.headers,
                    body: received as unknown as JsonValue,
                  },
                },
              };
              // Masked whole first, then cut to fit: the service worker masks again with the typed-value digests.
              const trimmed = trimEvent(
                maskNetworkEvent(event),
                EVENT_BUDGET_BYTES,
              ).event;
              const message = {
                type: "recorder.page-network",
                event: {
                  ...trimmed,
                  value: sanitiseForIntelligence(trimmed.value),
                },
              };
              const answer = send?.(extensionId, message);
              if (answer instanceof Promise) answer.catch(() => {});
            } catch {
              /* Capture must never affect the page. */
            }
            resolve();
          }, 0),
        ),
    )
    .catch(() => {});
}

/** This document's AG-UI streams: ids unique to this copy of the hook, the Intelligence channels its run answers
 * named, and the run answers still being read (a socket's frames wait for them, so a channel is known first). */
type AgentContext = {
  extensionId: string;
  nextId(): string;
  channels: Channels;
  reading: Promise<unknown>;
};

function createAgentContext(extensionId: string): AgentContext {
  const prefix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  let count = 0;
  return {
    extensionId,
    nextId: () => `${prefix}/${count++}`,
    channels: createChannels(),
    reading: Promise.resolve(),
  };
}

function sendObservation(
  context: AgentContext,
  observation: PageObservation,
): void {
  try {
    const answer = send?.(context.extensionId, {
      type: "recorder.page-agent",
      observation,
    });
    if (answer instanceof Promise) answer.catch(() => {});
  } catch {
    /* Capture must never affect the page. */
  }
}

/** A fetch's AG-UI side: created at the call, it reads the answer's clone when it is an event stream (or a run's
 * JSON answer, which may name an Intelligence channel). `run` is whether the call is an agent run: true or false at
 * once, a promise for a candidate whose answer decides. */
function followAgent(
  context: AgentContext,
  url: string,
  method: string,
  body: string | undefined,
) {
  const match = matchRun(url, method, body);
  const info = matchRuntimeInfoRequest(url, method, body);
  const stream = createHttpStream({
    streamId: context.nextId(),
    url,
    match,
    at: Date.now(),
    emit: (observation) => sendObservation(context, observation),
  });
  let decide: (run: boolean) => void = () => {};
  const decided = new Promise<boolean>((resolve) => {
    decide = resolve;
  });
  const settle = () => {
    const run = stream.isRun();
    if (run !== null) decide(run);
  };
  const finish = (ok: boolean) => {
    stream.finish(ok, Date.now());
    decide(stream.isRun() === true);
  };
  settle();
  return {
    run: match?.kind === "candidate" ? decided : match?.kind === "run",
    /** The answer arrived: read synchronously from here, before the page can read its own copy. */
    response(response: Response): void {
      if (
        info &&
        response.type !== "opaque" &&
        response.type !== "opaqueredirect"
      )
        // CopilotKit's runtime `info` call: when its answer is CopilotKit's RuntimeInfo, the page runs CopilotKit.
        void response
          .clone()
          .text()
          .then((text) => {
            if (isRuntimeInfoAnswer(response.status, text))
              sendObservation(context, {
                kind: "runtime",
                url,
                at: Date.now(),
              });
          })
          .catch(() => {});
      const type = response.headers.get("content-type");
      stream.response(type, response.status);
      settle();
      const format = streamFormat(type);
      const readable =
        response.type !== "opaque" && response.type !== "opaqueredirect";
      if (format && readable && response.body) {
        const reader = response.clone().body?.getReader();
        if (!reader) {
          finish(false);
          return;
        }
        void (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stream.data(value, Date.now());
            settle();
            // Another app's event stream: the copy is let go, and the page reads on alone.
            if (stream.ignored()) {
              await reader.cancel().catch(() => {});
              break;
            }
          }
        })().then(
          () => finish(true),
          () => finish(false),
        );
        return;
      }
      if (match?.kind === "run" && readable) {
        const read = response
          .clone()
          .text()
          .then((text) => {
            const channel = runChannel(text);
            if (channel)
              context.channels.set(channel.topic, {
                agentId: match.agentId,
                threadId: channel.threadId ?? match.threadId,
              });
            finish(true);
          })
          .catch(() => finish(false));
        context.reading = Promise.all([context.reading, read]);
        return;
      }
      finish(true);
    },
    failed(): void {
      finish(false);
    },
  };
}

function wrapFetch(
  extensionId: string,
  active: () => boolean,
  agents: AgentContext,
): () => void {
  const original = globalThis.fetch;
  if (typeof original !== "function") return () => {};
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!active()) return original.call(globalThis, input, init);
    let request: Request;
    let requestBody: Body | Promise<Body>;
    let agent: ReturnType<typeof followAgent> | null = null;
    try {
      const source =
        typeof globalThis.Request !== "undefined" &&
        input instanceof globalThis.Request
          ? input
          : undefined;
      const headers = headerRecord(
        new Headers(init?.headers ?? source?.headers),
      );
      withImpliedContentType(headers, init?.body);
      request = {
        url: absolute(source ? source.url : String(input)),
        method: (init?.method ?? source?.method ?? "GET").toUpperCase(),
        headers,
      };
      requestBody =
        init?.body !== undefined && init.body !== null
          ? sentBody(init.body, headers["content-type"])
          : source?.body
            ? isReadable(headers["content-type"])
              ? source
                  .clone()
                  .text()
                  .then(textBody, () => unavailable("request-clone-failed"))
              : unavailable("binary")
            : { status: "empty" };
    } catch {
      return original.call(globalThis, input, init);
    }
    try {
      // A Request object's own body is not read for this: CopilotKit and AG-UI's clients post a string.
      agent = followAgent(
        agents,
        request.url,
        request.method,
        typeof init?.body === "string" ? init.body : undefined,
      );
    } catch {
      agent = null;
    }
    const startedAt = performance.now();
    const failed = (error: unknown) => {
      try {
        agent?.failed();
      } catch {
        /* Capture must never affect the page. */
      }
      // An agent run is never a network event; a candidate that failed before answering is not one.
      if (agent?.run === true) return;
      report(
        "fetch",
        extensionId,
        request,
        startedAt,
        null,
        isAbort(error) ? "aborted" : "error",
        requestBody,
        { headers: {}, body: Promise.resolve(unavailable("no-response")) },
      );
    };
    let promise: Promise<Response>;
    try {
      promise = original.call(globalThis, input, init);
    } catch (error) {
      failed(error);
      throw error;
    }
    promise
      .then((response) => {
        if (!active()) return;
        try {
          agent?.response(response);
        } catch {
          agent = null;
        }
        const run = agent?.run ?? false;
        if (run === true) return;
        let body: Promise<Body>;
        try {
          body = receivedBody(response).catch(() =>
            unavailable("response-clone-failed"),
          );
        } catch {
          body = Promise.resolve(unavailable("response-clone-failed"));
        }
        const network = () =>
          report(
            "fetch",
            extensionId,
            request,
            startedAt,
            response.status,
            "ok",
            requestBody,
            {
              url: response.url,
              headers: headerRecord(response.headers),
              body,
            },
          );
        // A candidate is a network event only once its answer showed it is no agent run.
        if (run === false) network();
        else
          run.then((isRun) => {
            if (!isRun) network();
          });
      }, failed)
      .catch(() => {});
    // The page gets the identical native promise, response and rejection.
    return promise;
  }) as typeof fetch;
  globalThis.fetch = wrapped;
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
  };
}

function wrapXhr(extensionId: string, active: () => boolean): () => void {
  if (typeof XMLHttpRequest !== "function") return () => {};
  const proto = XMLHttpRequest.prototype;
  const { open, send: nativeSend, setRequestHeader } = proto;
  const requests = new WeakMap<XMLHttpRequest, Request>();

  const wrappedOpen = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const result = Reflect.apply(open, this, [method, url, ...rest]);
    try {
      requests.set(this, {
        url: absolute(String(url)),
        method: method.toUpperCase(),
        headers: {},
      });
    } catch {
      requests.delete(this);
    }
    return result;
  };
  const wrappedSetHeader = function (
    this: XMLHttpRequest,
    name: string,
    value: string,
  ) {
    const result = setRequestHeader.call(this, name, value);
    const request = requests.get(this);
    if (request) {
      const key = name.toLowerCase();
      request.headers[key] =
        key in request.headers ? `${request.headers[key]}, ${value}` : value;
    }
    return result;
  };
  const wrappedSend = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const request = requests.get(this);
    if (!active() || !request) return nativeSend.call(this, body);
    const startedAt = performance.now();
    let requestBody: Body | Promise<Body>;
    try {
      withImpliedContentType(request.headers, body);
      requestBody = sentBody(body, request.headers["content-type"]);
    } catch {
      requestBody = unavailable("request-body-unavailable");
    }
    let aborted = false;
    const onAbort = () => {
      aborted = true;
    };
    const onEnd = () => {
      this.removeEventListener("abort", onAbort);
      this.removeEventListener("loadend", onEnd);
      if (!active()) return;
      const outcome: Outcome = aborted
        ? "aborted"
        : this.status === 0
          ? "error"
          : "ok";
      const headers: Record<string, string> = {};
      try {
        for (const line of this.getAllResponseHeaders().split(/\r?\n/)) {
          const split = line.indexOf(":");
          if (split > 0)
            headers[line.slice(0, split).toLowerCase()] = line
              .slice(split + 1)
              .trim();
        }
      } catch {
        /* Cross-origin or failed requests can hide response headers. */
      }
      let received: Body;
      try {
        // responseText throws InvalidStateError for any responseType other than "" and "text".
        if (this.responseType === "json")
          received = textBody(JSON.stringify(this.response));
        else if (this.responseType === "" || this.responseType === "text")
          received = isReadable(headers["content-type"])
            ? textBody(this.responseText)
            : unavailable("binary");
        else received = unavailable("binary");
      } catch {
        received = unavailable("response-body-unavailable");
      }
      report(
        "xhr",
        extensionId,
        request,
        startedAt,
        outcome === "ok" ? this.status : null,
        outcome,
        requestBody,
        {
          ...(this.responseURL ? { url: this.responseURL } : {}),
          headers,
          body: Promise.resolve(received),
        },
      );
    };
    this.addEventListener("abort", onAbort);
    this.addEventListener("loadend", onEnd);
    try {
      return nativeSend.call(this, body);
    } catch (error) {
      this.removeEventListener("abort", onAbort);
      this.removeEventListener("loadend", onEnd);
      report(
        "xhr",
        extensionId,
        request,
        startedAt,
        null,
        isAbort(error) ? "aborted" : "error",
        requestBody,
        { headers: {}, body: Promise.resolve(unavailable("no-response")) },
      );
      throw error;
    }
  };
  proto.open = wrappedOpen as typeof proto.open;
  proto.setRequestHeader = wrappedSetHeader;
  proto.send = wrappedSend;
  return () => {
    if (proto.open === wrappedOpen) proto.open = open;
    if (proto.setRequestHeader === wrappedSetHeader)
      proto.setRequestHeader = setRequestHeader;
    if (proto.send === wrappedSend) proto.send = nativeSend;
  };
}

/** Wraps the WebSocket constructor (a Proxy: the prototype, instanceof, the static constants and subclassing stay the
 * browser's own) to read the AG-UI events each new socket receives, and `send` for the Phoenix joins and leaves the
 * page sends. Listening adds nothing the page can see. */
function wrapWebSocket(
  active: () => boolean,
  agents: AgentContext,
): () => void {
  const Native = globalThis.WebSocket;
  if (typeof Native !== "function") return () => {};
  const readers = new WeakMap<
    WebSocket,
    { reader: ReturnType<typeof createSocketReader>; work: Promise<void> }
  >();
  let sockets = 0;
  /** A frame waits for the run answers still being read when it came. */
  const queue = (
    socket: WebSocket,
    step: (reader: ReturnType<typeof createSocketReader>) => void,
  ) => {
    const entry = readers.get(socket);
    if (!entry) return;
    const pending = agents.reading;
    entry.work = entry.work
      .then(() => pending)
      .then(() => step(entry.reader))
      .catch(() => {});
  };
  const observe = (socket: WebSocket) => {
    const n = sockets++;
    const id = agents.nextId();
    readers.set(socket, {
      work: Promise.resolve(),
      reader: createSocketReader({
        streamId: (topic, count) =>
          topic === null
            ? `${id}/ws/${n}/${count}`
            : `${id}/ws/${n}/${count}/${topic}`,
        emit: (observation) => sendObservation(agents, observation),
        channels: agents.channels,
      }),
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (!active() || typeof event.data !== "string") return;
      const data = event.data;
      const at = Date.now();
      queue(socket, (reader) => reader.received(data, at));
    });
    socket.addEventListener("close", () => {
      if (!active()) return;
      const at = Date.now();
      queue(socket, (reader) => reader.closed(at));
    });
  };
  const Wrapped = new Proxy(Native, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as WebSocket;
      if (active())
        try {
          observe(socket);
        } catch {
          /* Capture must never affect the page. */
        }
      return socket;
    },
  });
  const proto = Native.prototype;
  const nativeSend = proto.send;
  const wrappedSend = function (
    this: WebSocket,
    data: string | ArrayBufferLike | Blob | ArrayBufferView,
  ) {
    try {
      if (active() && typeof data === "string" && readers.has(this)) {
        const at = Date.now();
        queue(this, (reader) => reader.sent(data, at));
      }
    } catch {
      /* Capture must never affect the page. */
    }
    return nativeSend.call(this, data);
  };
  globalThis.WebSocket = Wrapped;
  proto.send = wrappedSend;
  return () => {
    if (globalThis.WebSocket === Wrapped) globalThis.WebSocket = Native;
    if (proto.send === wrappedSend) proto.send = nativeSend;
  };
}

(() => {
  // Injected again into a document that already has the hook (a second start, a followed tab added later): the older
  // copy restores the originals first, so the wrappers never stack.
  (registry[STOP] as (() => void) | undefined)?.();
  let restore: (() => void) | null = null;
  let running = false;

  const stop = () => {
    running = false;
    restore?.();
    restore = null;
  };
  registry[STOP] = stop;
  registry[CONFIGURE] = (extensionId: unknown) => {
    if (!send || typeof extensionId !== "string") return;
    stop();
    running = true;
    const active = () => running;
    const agents = createAgentContext(extensionId);
    const restoreFetch = wrapFetch(extensionId, active, agents);
    const restoreXhr = wrapXhr(extensionId, active);
    const restoreSocket = wrapWebSocket(active, agents);
    restore = () => {
      restoreFetch();
      restoreXhr();
      restoreSocket();
    };
  };
})();
