// The page-level network hook: a classic script the service worker injects into the MAIN world of recorded tabs only,
// when policy refuses the debugger. It wraps fetch and XMLHttpRequest, masks each finished request IN THE PAGE (each
// body whole, so a credential-named key is redacted wherever it sits), trims the event to fit one Intelligence event,
// and hands it to the service worker through chrome.runtime.sendMessage. It never uses window.postMessage: anything
// posted to the window is readable by every script on the page.

import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  type JsonValue,
  maskNetworkEvent,
  sanitiseForIntelligence,
  trimEvent,
} from "@openbot/shared/recorder-masking";
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

function wrapFetch(extensionId: string, active: () => boolean): () => void {
  const original = globalThis.fetch;
  if (typeof original !== "function") return () => {};
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!active()) return original.call(globalThis, input, init);
    let request: Request;
    let requestBody: Body | Promise<Body>;
    try {
      const source =
        typeof globalThis.Request !== "undefined" &&
        input instanceof globalThis.Request
          ? input
          : undefined;
      const headers = headerRecord(
        new Headers(init?.headers ?? source?.headers),
      );
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
    const startedAt = performance.now();
    const failed = (error: unknown) =>
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
        let body: Promise<Body>;
        try {
          body = receivedBody(response).catch(() =>
            unavailable("response-clone-failed"),
          );
        } catch {
          body = Promise.resolve(unavailable("response-clone-failed"));
        }
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
    const restoreFetch = wrapFetch(extensionId, active);
    const restoreXhr = wrapXhr(extensionId, active);
    restore = () => {
      restoreFetch();
      restoreXhr();
    };
  };
})();
