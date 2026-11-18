import {
  RECORDER_SIGNED_OUT,
  type RecorderErrorBody,
} from "@openbot/shared/recorder-api";

export class OpenBotError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: RecorderErrorBody | null,
  ) {
    super(message);
    this.name = "OpenBotError";
  }

  /** True only for the recorder guard's own 401. */
  get signedOut(): boolean {
    return this.status === 401 && this.body?.code === RECORDER_SIGNED_OUT;
  }
}

type OpenBotTarget = { openbotUrl: string; token?: string };

/** Sends the request with the bearer when there is one, never with cookies, and never follows a redirect. */
export async function openbotRaw(
  target: OpenBotTarget,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (target.token) headers.set("Authorization", `Bearer ${target.token}`);
  const url = new URL(path, target.openbotUrl);
  if (url.origin !== new URL(target.openbotUrl).origin) {
    throw new Error(
      `Refusing to send the OpenBot bearer to ${url.origin}; "${path}" leaves ${new URL(target.openbotUrl).origin}.`,
    );
  }
  return fetch(url, {
    ...init,
    headers,
    redirect: "error",
    credentials: "omit",
  });
}

async function readErrorBody(
  response: Response,
): Promise<RecorderErrorBody | null> {
  try {
    const body: unknown = await response.json();
    // The API's problem details (RFC 9457): the sentence is `detail`.
    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { detail?: unknown }).detail === "string"
    ) {
      return body as RecorderErrorBody;
    }
  } catch {
    // A body that is not JSON carries no error code.
  }
  return null;
}

/**
 * A key for one write, so OpenBot's API does it once: every write there carries one. `getRandomValues` rather than
 * `randomUUID`, which needs a secure context.
 */
function idempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** The organization the Recorder works in: an install has one, and the API addresses it as `default`. */
export const ORGANIZATION_ID = "default";

/** What a caller of a generated function (src/shared/generated) adds to the request it makes. */
export type OpenBotRequestInit = RequestInit & {
  /** The OpenBot the request goes to, and the connection's bearer when it has one. Every call names it. */
  target?: OpenBotTarget;
};

/**
 * How the Recorder's generated API client reaches OpenBot: Orval's mutator for src/shared/generated.
 *
 * Every Recorder operation in api/openapi.yaml calls this with the address, method, headers and serialised body the
 * spec gives it, and the caller's `target`. It is sent through {@link openbotRaw}: to that OpenBot only, with the bearer
 * when there is one, `redirect: "error"`, no cookies. A write (anything but a GET) carries a fresh `Idempotency-Key`
 * unless the caller sent its own. A refusal is thrown as an {@link OpenBotError} in the server's own sentence; a 204 or
 * an empty body answers `undefined`.
 */
export async function openbotRequest<T>(
  url: string,
  init: OpenBotRequestInit = {},
): Promise<T> {
  const { target, ...request } = init;
  if (!target) throw new Error(`Name the OpenBot to send "${url}" to.`);
  const method = (request.method ?? "GET").toUpperCase();
  const headers = new Headers(request.headers);
  headers.set("Accept", "application/json");
  if (method !== "GET" && !headers.has("Idempotency-Key"))
    headers.set("Idempotency-Key", idempotencyKey());
  const response = await openbotRaw(target, url, {
    ...request,
    method,
    headers,
  });
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new OpenBotError(
      response.status,
      body?.detail ?? `OpenBot answered ${response.status}.`,
      body,
    );
  }
  const text = await response.text();
  if (response.status === 204 || text === "") return undefined as T;
  return JSON.parse(text) as T;
}
