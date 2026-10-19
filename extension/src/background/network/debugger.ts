// What Chrome's debugger (CDP's Network domain) reports about the calls a followed tab and its frames make: when each
// finished fetch, XHR or top-frame document request ran, so a step can tell which calls it caused, and for a write its
// bodies read through the debugger as the collector's `network` event, so it can be that step's save. Nothing here is
// recorded on its own: the event leaves unmasked, and the capture masks it before the steps (steps.ts) see it.
import type {
  CapturedEvent,
  JsonValue,
} from "@openbot/shared/recorder-masking";
import {
  isReadableBody,
  type NetworkBody,
  textBody,
  unavailableBody,
} from "../../shared/network-body";
import { callSignature, type RepeatMemory, screenCall } from "./screen";

/** A tab, or a frame's own session inside it (flattened auto-attach: cross-site iframes run in their own process). */
export type Debuggee = { tabId: number; sessionId?: string };

type Send = (
  target: Debuggee,
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

type Pending = {
  target: Debuggee;
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  hasPostData: boolean;
  type?: string;
  frameId?: string;
  /** CDP's monotonic seconds when the request was sent, and the wall clock (epoch ms) at that moment. */
  startedAt: number;
  wallStart: number;
  /** Monotonic seconds when the response headers arrived. */
  respondedAt?: number;
  /** The tab already made this exact call before (polling, a refetch): see screen.ts createRepeatMemory. */
  repeat: boolean;
  response?: {
    url: string;
    status: number;
    headers: Record<string, string>;
    mimeType: string;
  };
};

/** The calls a step can cause or save through are the page's API calls and the top frame's own document requests (a
 * link followed, a form posted): images, fonts, stylesheets, scripts, media, beacons (Ping), CSP reports, preflights,
 * prefetches, event streams and websockets never are. */
const RECORDED_TYPES = new Set(["XHR", "Fetch", "Document"]);
/** CDP's own cap on post data it sends inline; anything longer is asked for with Network.getRequestPostData. */
export const MAX_POST_DATA_SIZE = 65_536;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A finished call that passed the screens: when it ran, and for a write its unmasked exchange as a network event. */
export type TrackedCall = {
  tabId: number;
  startedAt: number;
  respondedAt?: number;
  endedAt: number;
  method: string;
  url: string;
  event?: CapturedEvent;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** CDP header objects map names to strings; anything else is dropped. */
function headers(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [name, item] of Object.entries(value))
    if (typeof item === "string") out[name] = item;
  return out;
}

function headerValue(
  values: Record<string, string>,
  name: string,
): string | undefined {
  for (const [key, item] of Object.entries(values))
    if (key.toLowerCase() === name) return item;
  return undefined;
}

/** Chrome hands some bodies over as base64; a text body is decoded as UTF-8, replacing what is not. */
function decodeBase64(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Follows requests per debuggee from `Network.requestWillBeSent` to `Network.loadingFinished` or `loadingFailed`, and
 * hands every finished fetch, XHR or top-frame document request that passed the screens to `call`; a write comes with
 * its bodies, read only then. `writeStarted` and `writeEnded` bracket each write from its start until `call` had it (or
 * it was screened out), so a step waits for a save still in flight. `ignore` names URLs never recorded (OpenBot's own);
 * `topFrame` answers a tab's main frame id.
 */
export function createRequestTracker(options: {
  ignore(url: string): boolean;
  send: Send;
  call(call: TrackedCall): void;
  writeStarted(id: string, tabId: number, startedAt: number): void;
  writeEnded(id: string): void;
  repeats: RepeatMemory;
  topFrame(tabId: number): Promise<string | undefined>;
}) {
  const pending = new Map<string, Pending>();
  /** The writes in flight, by key, until `call` had them. */
  const writes = new Set<string>();
  const endWrite = (key: string) => {
    if (writes.delete(key)) options.writeEnded(key);
  };
  const keyOf = (target: Debuggee, requestId: string) =>
    `${target.tabId}/${target.sessionId ?? ""}/${requestId}`;

  async function requestBody(request: Pending): Promise<NetworkBody> {
    const type = headerValue(request.headers, "content-type");
    // A body sent without a content type is the page's own text (fetch labels a string body text/plain).
    if (type !== undefined && !isReadableBody(type))
      return unavailableBody("binary");
    if (request.postData !== undefined) return textBody(request.postData);
    if (!request.hasPostData) return { status: "empty" };
    try {
      const answer = await options.send(
        request.target,
        "Network.getRequestPostData",
        {
          requestId: request.requestId,
        },
      );
      return textBody(
        text(isRecord(answer) ? answer.postData : undefined) ?? "",
      );
    } catch {
      return unavailableBody("request-body-unavailable");
    }
  }

  async function responseBody(request: Pending): Promise<NetworkBody> {
    const response = request.response;
    if (!response) return unavailableBody("no-response");
    if (
      !isReadableBody(
        response.mimeType || headerValue(response.headers, "content-type"),
      )
    )
      return unavailableBody("binary");
    try {
      const answer = await options.send(
        request.target,
        "Network.getResponseBody",
        {
          requestId: request.requestId,
        },
      );
      if (!isRecord(answer) || typeof answer.body !== "string")
        return unavailableBody("response-body-unavailable");
      return textBody(
        answer.base64Encoded === true ? decodeBase64(answer.body) : answer.body,
      );
    } catch {
      return unavailableBody("response-body-unavailable");
    }
  }

  /** Wall-clock milliseconds for one of the request's monotonic timestamps. */
  const wall = (request: Pending, monotonic: number) =>
    request.wallStart + Math.max(0, (monotonic - request.startedAt) * 1000);

  async function finish(
    request: Pending,
    key: string,
    outcome: "ok" | "error" | "aborted",
    finishedAt: number,
  ): Promise<void> {
    if (request.type === "Document") {
      // A document request counts only in the top frame: an iframe loading is the page's own doing.
      if (request.target.sessionId !== undefined) return;
      const top = await options.topFrame(request.target.tabId);
      if (top === undefined || request.frameId !== top) return;
    }
    const verdict = screenCall({
      url: request.url,
      method: request.method,
      outcome,
      headers: request.headers,
      body: request.postData,
      repeat: request.repeat,
    });
    if (verdict) return;
    const endedAt = wall(request, finishedAt);
    const timing = {
      tabId: request.target.tabId,
      startedAt: request.wallStart,
      respondedAt:
        request.respondedAt === undefined
          ? undefined
          : Math.min(endedAt, wall(request, request.respondedAt)),
      endedAt,
      method: request.method,
      url: request.url,
    };
    // A read can only lead to a save: when it ran is all a step needs, and its bodies are never read.
    if (!WRITE_METHODS.has(request.method)) {
      options.call(timing);
      return;
    }
    options.call({
      ...timing,
      event: await networkEvent(request, outcome, finishedAt),
    });
    endWrite(key);
  }

  /** Reads the call's bodies into the collector's network event. */
  async function networkEvent(
    request: Pending,
    outcome: "ok" | "error" | "aborted",
    finishedAt: number,
  ): Promise<CapturedEvent> {
    const [sent, received] = await Promise.all([
      requestBody(request),
      outcome === "ok"
        ? responseBody(request)
        : Promise.resolve(unavailableBody("no-response")),
    ]);
    const url = new URL(request.url);
    const completedAt = Date.now();
    const response = request.response;
    return {
      type: "CUSTOM",
      name: "network",
      timestamp: completedAt,
      value: {
        transport:
          request.type === "XHR"
            ? "xhr"
            : request.type === "Document"
              ? "document"
              : "fetch",
        method: request.method,
        url: request.url,
        origin: url.origin,
        route: url.pathname,
        status: outcome === "ok" ? (response?.status ?? null) : null,
        durationMs: Math.max(
          0,
          Math.round((finishedAt - request.startedAt) * 1000),
        ),
        completedAt,
        outcome,
        request: {
          headers: request.headers,
          body: sent as unknown as JsonValue,
        },
        response: {
          ...(response ? { url: response.url } : {}),
          headers: response?.headers ?? {},
          body: received as unknown as JsonValue,
        },
        capturedBy: "debugger",
      },
    };
  }

  function settle(
    target: Debuggee,
    params: Record<string, unknown>,
    outcome: "ok" | "error" | "aborted",
  ): void {
    const requestId = text(params.requestId);
    if (requestId === undefined) return;
    const key = keyOf(target, requestId);
    const request = pending.get(key);
    pending.delete(key);
    if (!request) {
      endWrite(key);
      return;
    }
    const type = text(params.type) ?? request.type;
    if (!type || !RECORDED_TYPES.has(type)) {
      endWrite(key);
      return;
    }
    request.type = type;
    void finish(
      request,
      key,
      outcome,
      number(params.timestamp) ?? request.startedAt,
    )
      .catch((error) =>
        console.error("Recorder: a network call could not be read", error),
      )
      .finally(() => endWrite(key));
  }

  return {
    onEvent(target: Debuggee, method: string, raw: unknown): void {
      if (!isRecord(raw)) return;
      switch (method) {
        case "Network.requestWillBeSent": {
          const requestId = text(raw.requestId);
          const request = isRecord(raw.request) ? raw.request : null;
          const url = text(request?.url);
          if (requestId === undefined || !request || url === undefined) return;
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return;
          }
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
            return;
          const key = keyOf(target, requestId);
          // A redirect reuses the request id: the call that matters is the one it lands on.
          if (options.ignore(url)) {
            pending.delete(key);
            endWrite(key);
            return;
          }
          const method = (text(request.method) ?? "GET").toUpperCase();
          const postData = text(request.postData);
          const type = text(raw.type);
          const wallTime = number(raw.wallTime);
          const wallStart =
            wallTime === undefined ? Date.now() : Math.round(wallTime * 1000);
          pending.set(key, {
            target,
            requestId,
            url,
            method,
            headers: headers(request.headers),
            postData,
            hasPostData: request.hasPostData === true,
            type,
            frameId: text(raw.frameId),
            startedAt: number(raw.timestamp) ?? 0,
            wallStart,
            // Only the kinds a step can cause are remembered: a script or an image is never a repeat that matters.
            repeat:
              type !== undefined && RECORDED_TYPES.has(type)
                ? options.repeats.seen(
                    target.tabId,
                    callSignature(method, url, postData),
                    wallStart,
                  )
                : false,
          });
          if (
            type !== undefined &&
            RECORDED_TYPES.has(type) &&
            WRITE_METHODS.has(method) &&
            !writes.has(key)
          ) {
            writes.add(key);
            options.writeStarted(key, target.tabId, wallStart);
          }
          return;
        }
        case "Network.responseReceived": {
          const requestId = text(raw.requestId);
          if (requestId === undefined) return;
          const request = pending.get(keyOf(target, requestId));
          const response = isRecord(raw.response) ? raw.response : null;
          if (!request || !response) return;
          request.type = text(raw.type) ?? request.type;
          request.respondedAt = number(raw.timestamp) ?? request.respondedAt;
          request.response = {
            url: text(response.url) ?? request.url,
            status: number(response.status) ?? 0,
            headers: headers(response.headers),
            mimeType: text(response.mimeType) ?? "",
          };
          return;
        }
        case "Network.loadingFinished":
          settle(target, raw, "ok");
          return;
        case "Network.loadingFailed":
          settle(target, raw, raw.canceled === true ? "aborted" : "error");
          return;
      }
    },
    /** A tab that closed: its calls still in flight never finish. */
    forgetTab(tabId: number): void {
      for (const [key, request] of pending)
        if (request.target.tabId === tabId) {
          pending.delete(key);
          endWrite(key);
        }
    },
    clear(): void {
      pending.clear();
      for (const key of [...writes]) endWrite(key);
    },
  };
}
