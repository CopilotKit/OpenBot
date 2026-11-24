/**
 * The one place the browser talks to the API server.
 *
 * WHAT THIS REPLACES. Every read opened with the same four lines — fetch with `credentials`, check
 * `ok`, throw a sentence, unwrap the envelope — and every entity that wrote more than once grew its
 * own private copy of the same request helper: `agentRequest`, `componentRequest`, and two others,
 * identical apart from the fallback sentence. Four copies of one function is four places for the
 * `body.error` extraction to be forgotten, and it had been, in more than one of them.
 *
 * WHAT IT DOES NOT DO. It owns the transport and nothing about meaning. The envelope key and the
 * sentence a person reads are per-endpoint facts, so they stay at the call site — a client that
 * guessed the envelope would be a client that had to be argued with.
 */

import { CLIENT_HEADER, clientToken } from "@openbot/shared/client-version";
import {
  pendingWrite,
  renewalRequired,
  renewHostedSignIn,
  SIGN_IN_HEADER,
} from "@/lib/auth/renewal";
import { noteRefusal } from "@/lib/client-version/refusal";
import { noteAnswer, noteNoAnswer } from "@/lib/desktop/reachability";
import { PLAN_REQUIRED, showCardNeeded } from "@/lib/plan/card-needed";

/**
 * This app as it names itself to its OpenBot: `web/<release>`, the release it was built from
 * (shared/client-version.ts). The server refuses an app older than the oldest it serves.
 */
export const CLIENT_NAME = clientToken("web");

/**
 * `headers` with this app named in them, in the same shape they were given: a record, a `Headers`,
 * or a list of pairs. For the few requests the app makes to OpenBot without the client: the
 * runtime's, sign-in's and finishing a consent. A file's own address is read like a picture's,
 * which carries no header either, and can be sent on to wherever the file is kept.
 */
export function withClientName(
  headers: Record<string, string>,
): Record<string, string>;
export function withClientName(headers?: HeadersInit): HeadersInit;
export function withClientName(headers?: HeadersInit): HeadersInit {
  const header = CLIENT_HEADER.toLowerCase();
  if (headers instanceof Headers) {
    const named = new Headers(headers);
    named.set(CLIENT_HEADER, CLIENT_NAME);
    return named;
  }
  if (Array.isArray(headers)) {
    return [
      ...headers.filter(([name]) => name.toLowerCase() !== header),
      [CLIENT_HEADER, CLIENT_NAME],
    ];
  }
  const named: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== header) named[name] = value;
  }
  named[CLIENT_HEADER] = CLIENT_NAME;
  return named;
}

export type ClientOptions = {
  /** Absent means GET. */
  method?: string;
  /** Serialised as JSON, which is also what sets the content type. */
  body?: unknown;
  /**
   * What a person reads when the server sent no message of its own.
   *
   * Name the entity in it — "Couldn't load your Bots." rather than "Request failed" — because this
   * is the sentence that reaches the screen when the server is the one that broke.
   */
  fallback?: string;
  /** For the calls a Bot makes on a person's behalf, which are abandoned when the turn is. */
  signal?: AbortSignal;
  /**
   * Headers a request carries beside the content type: the organization a tab works in, for the
   * runtime's addresses (lib/organizations/current.ts, `organizationHeaders`).
   */
  headers?: Record<string, string>;
};

/** What a person reads when a request got no answer at all. */
export const NO_ANSWER =
  "Couldn't reach OpenBot. Check your connection and try again.";

/**
 * A request that got no answer: the network failed, or OpenBot wasn't there. The browser's own
 * error says so in its words ("Load failed" in Safari and the Mac window, "Failed to fetch" in
 * Chromium), which a screen would show as they are. This carries OpenBot's sentence instead, and
 * the browser's error as its cause.
 *
 * Still a TypeError, as `fetch`'s own is, so whatever tells a lost connection by that
 * (`lib/desktop/reachability.ts`) keeps telling it.
 */
export class NoAnswerError extends TypeError {
  constructor(cause: unknown) {
    super(NO_ANSWER, { cause });
    this.name = "NoAnswerError";
  }
}

/**
 * The one `fetch`. Each outcome is reported to `lib/desktop/reachability.ts`, which is how the app
 * knows the OpenBot it is connected to stopped answering, and answers again.
 *
 * A 502 is read before it is handed back, so a read failing on the relay's own answer fails with
 * the connection already known to be lost, and waits for OpenBot (`connection-lost.ts`).
 *
 * Every request names this app ({@link CLIENT_NAME}). A 400 is read before it is handed back too, so
 * a refusal for being too old an app is known before the request fails, and the update screen shows
 * in place of whatever failed (`lib/client-version/refusal.ts`).
 */
async function request(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: withClientName(init.headers),
      // The session's cookie, unless the caller asks as nobody (`readDeployment` for somebody in no organization).
      credentials: init.credentials ?? "include",
    });
  } catch (error) {
    noteNoAnswer(error);
    // A request the page gave up on (an AbortError) is not this, and is handed back as it is.
    if (error instanceof TypeError) throw new NoAnswerError(error);
    throw error;
  }
  const noted = noteAnswer(response);
  if (response.status === 502) await noted;
  if (response.status === 400) await noteRefusal(response);
  return response;
}

/** Every request in this app is authenticated, and every one of them is JSON or nothing. */
async function send(path: string, options: ClientOptions): Promise<Response> {
  const headers = {
    ...options.headers,
    ...(options.body === undefined
      ? {}
      : { "content-type": "application/json" }),
  };
  return request(path, {
    method: options.method,
    headers: Object.keys(headers).length === 0 ? undefined : headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * A request whose failure is a value rather than a throw.
 *
 * For the endpoints where a refusal is the answer: the gateway declining a component call, or the
 * catalogue announcement that is allowed to come back empty. Those callers read the status
 * themselves, and turning a refusal into an exception would make the boundary working look like the
 * boundary breaking.
 */
export function tryClient(
  path: string,
  options: ClientOptions = {},
): Promise<Response> {
  return send(path, options);
}

/** The server answered, and said no. `status` tells a refusal (4xx) from a server that broke (5xx). */
export class ClientError extends Error {
  readonly status: number;
  /**
   * The refusal's stable name, when the server gave one: the API's problem `code`
   * (`LINKED_ACCOUNTS_UNAVAILABLE`), or the `code` a few of today's routes answer beside `error`.
   */
  readonly code: string | undefined;
  /**
   * What else the refusal said, when it was JSON: the members a problem carries beside its sentence,
   * such as the rule that refused a Bot's action on its computer.
   */
  readonly body: Record<string, unknown> | undefined;
  /**
   * The server's own sentence, when it sent one: `error` today, `detail` in problem details. Undefined
   * when the message is the caller's fallback.
   */
  readonly said: string | undefined;
  /** How long the server asked to be left before it is asked again (`Retry-After`), when it said. */
  readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    status: number,
    code?: string,
    body?: Record<string, unknown>,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ClientError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.said =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.detail === "string"
          ? body.detail
          : undefined;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * `Retry-After` as milliseconds from now: a number of seconds, or a date (RFC 9110). Undefined when
 * there is none, or it is neither.
 */
function retryAfterOf(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * The error a refusal becomes, carrying the server's own sentence.
 *
 * The server's message is the useful one: it names the field or the permission that failed. Today's
 * routes put it in `error`; the API's problem details (RFC 9457) put it in `detail`. The fallback is
 * only for the cases where it sent neither, or sent something that is not JSON.
 */
async function refusal(
  response: Response,
  fallback: string | undefined,
  /** The request that was refused, as it was sent, for a write a renewal sends again. */
  sent?: { path: string; init: RequestInit },
): Promise<ClientError> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    detail?: unknown;
    code?: unknown;
    appId?: unknown;
  } | null;
  const message =
    typeof body?.error === "string"
      ? body.error
      : typeof body?.detail === "string"
        ? body.detail
        : undefined;
  const error = new ClientError(
    message ?? fallback ?? "That request failed.",
    response.status,
    typeof body?.code === "string" ? body.code : undefined,
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined,
    retryAfterOf(response),
  );
  /*
   * A run refused for want of a plan, from whichever screen asked for it: the one dialog that says
   * why opens, so an action no screen checked first still tells the person (`lib/plan/card-needed.ts`).
   */
  if (error.code === PLAN_REQUIRED) showCardNeeded(error.body ?? {});
  /*
   * A hosted OpenBot's sign-in needing renewal, which is never being signed out: renewed in the
   * background, and the write it interrupted is sent again once the page is back.
   */
  if (renewalRequired(error))
    renewHostedSignIn(
      response.headers.get(SIGN_IN_HEADER),
      sent ? pendingWrite(sent.path, sent.init) : null,
    );
  return error;
}

/**
 * A request the generated API client has already shaped: its method, headers and serialised body.
 *
 * For `lib/api/request.ts` only, which is how every operation in api/openapi.yaml reaches the server.
 * It adds what every request here carries, the session cookie, and turns a refusal into the same
 * `ClientError` with the same sentence `client` gives, so a screen cannot tell which one it called.
 */
export async function clientRequest(
  path: string,
  init: RequestInit,
  fallback?: string,
): Promise<Response> {
  const response = await request(path, init);
  if (!response.ok) throw await refusal(response, fallback, { path, init });
  return response;
}

/**
 * A request that throws when the server says no, carrying the server's own message.
 *
 * With a `key`, the JSON body is parsed and that key unwrapped, so a caller receives the payload
 * rather than the envelope it arrived in. Without one, the `Response` is returned for a caller that
 * only needed to know it worked.
 */
export async function client<T>(
  path: string,
  key: string,
  options?: ClientOptions,
): Promise<T>;
export async function client(
  path: string,
  options?: ClientOptions,
): Promise<Response>;
export async function client<T>(
  path: string,
  keyOrOptions?: string | ClientOptions,
  maybeOptions?: ClientOptions,
): Promise<T | Response> {
  const key = typeof keyOrOptions === "string" ? keyOrOptions : undefined;
  const options =
    (typeof keyOrOptions === "string" ? maybeOptions : keyOrOptions) ?? {};

  const response = await send(path, options);

  if (!response.ok) throw await refusal(response, options.fallback);

  if (key === undefined) return response;

  // A 204 or a non-JSON body used to throw a bare SyntaxError, and `null` or an array body threw
  // a TypeError on property access. Malformed success is a failed request with the fallback.
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(options.fallback ?? "That request failed.");
  }
  return (body as Record<string, T>)[key];
}
