// What Chrome's debugger (CDP's Network domain) reports about the calls a followed tab and its frames make, turned into
// the collector's `network` event: one per finished fetch or XHR, with its bodies read through the debugger. The event
// leaves here unmasked; the capture masks and trims it before anything else sees it.
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
  startedAt: number;
  response?: {
    url: string;
    status: number;
    headers: Record<string, string>;
    mimeType: string;
  };
};

/** The calls a Skill repeats are the page's own API calls: images, scripts, stylesheets and documents are dropped. */
const RECORDED_TYPES = new Set(["XHR", "Fetch"]);
/** CDP's own cap on post data it sends inline; anything longer is asked for with Network.getRequestPostData. */
export const MAX_POST_DATA_SIZE = 65_536;

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
 * hands every finished fetch or XHR to `emit` as a network event. `ignore` names URLs never recorded (OpenBot's own).
 */
export function createRequestTracker(options: {
  ignore(url: string): boolean;
  send: Send;
  emit(event: CapturedEvent): void;
}) {
  const pending = new Map<string, Pending>();
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

  async function finish(
    request: Pending,
    outcome: "ok" | "error" | "aborted",
    finishedAt: number,
  ): Promise<void> {
    const [sent, received] = await Promise.all([
      requestBody(request),
      outcome === "ok"
        ? responseBody(request)
        : Promise.resolve(unavailableBody("no-response")),
    ]);
    const url = new URL(request.url);
    const completedAt = Date.now();
    const response = request.response;
    options.emit({
      type: "CUSTOM",
      name: "network",
      timestamp: completedAt,
      value: {
        transport: request.type === "XHR" ? "xhr" : "fetch",
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
    });
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
    if (!request) return;
    const type = text(params.type) ?? request.type;
    if (!type || !RECORDED_TYPES.has(type)) return;
    request.type = type;
    void finish(
      request,
      outcome,
      number(params.timestamp) ?? request.startedAt,
    ).catch((error) =>
      console.error("Recorder: a network call could not be recorded", error),
    );
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
            return;
          }
          pending.set(key, {
            target,
            requestId,
            url,
            method: (text(request.method) ?? "GET").toUpperCase(),
            headers: headers(request.headers),
            postData: text(request.postData),
            hasPostData: request.hasPostData === true,
            type: text(raw.type),
            startedAt: number(raw.timestamp) ?? 0,
          });
          return;
        }
        case "Network.responseReceived": {
          const requestId = text(raw.requestId);
          if (requestId === undefined) return;
          const request = pending.get(keyOf(target, requestId));
          const response = isRecord(raw.response) ? raw.response : null;
          if (!request || !response) return;
          request.type = text(raw.type) ?? request.type;
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
        if (request.target.tabId === tabId) pending.delete(key);
    },
    clear(): void {
      pending.clear();
    },
  };
}
