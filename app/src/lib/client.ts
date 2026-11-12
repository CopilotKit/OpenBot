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
};

/** Every request in this app is authenticated, and every one of them is JSON or nothing. */
async function send(path: string, options: ClientOptions): Promise<Response> {
  return fetch(path, {
    method: options.method,
    credentials: "include",
    headers:
      options.body === undefined
        ? undefined
        : { "content-type": "application/json" },
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
  constructor(message: string, status: number) {
    super(message);
    this.name = "ClientError";
    this.status = status;
  }
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
): Promise<ClientError> {
  const message = await response
    .json()
    .then((body: { error?: unknown; detail?: unknown }) =>
      typeof body.error === "string"
        ? body.error
        : typeof body.detail === "string"
          ? body.detail
          : undefined,
    )
    .catch(() => undefined);
  return new ClientError(
    message ?? fallback ?? "That request failed.",
    response.status,
  );
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
  const response = await fetch(path, { ...init, credentials: "include" });
  if (!response.ok) throw await refusal(response, fallback);
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
