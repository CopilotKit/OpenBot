import {
  CLIENT_HEADER,
  CLIENT_KINDS,
  CLIENT_UPDATE_REQUIRED,
  type ClientKind,
  clientToken,
  clientUpdateDetail,
  isVersion,
  SECURITY_UPDATE_SENTENCE,
} from "@openbot/shared/client-version";
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

  /** True when OpenBot refused this Recorder as older than it serves (CLIENT_UPDATE_REQUIRED). */
  get updateRequired(): boolean {
    return this.body?.code === CLIENT_UPDATE_REQUIRED;
  }

  /** True when that refusal's minimum was raised because of a security problem in older releases. */
  get securityUpdateRequired(): boolean {
    return (
      this.updateRequired &&
      (this.body as Record<string, unknown> | null)?.security === true
    );
  }
}

/** What the person reads when OpenBot serves only newer Recorders and its answer names no release we can use. */
export const RECORDER_UPDATE_REQUIRED =
  "This OpenBot needs a newer OpenBot Recorder. Update OpenBot, then try again.";

/**
 * The sentence for OpenBot refusing this Recorder as too old, or null for any other failure. It is the Recorder's own
 * sentence, the same one OpenBot words its refusal with (`clientUpdateDetail`), built from the app and release the
 * answer names, or the security sentence when the minimum was raised for a security problem. The text of the answer
 * itself is never shown: any site can answer as OpenBot, and only a known app, a release number and the security flag
 * pass through.
 */
export function updateRequiredSentence(error: unknown): string | null {
  if (!(error instanceof OpenBotError) || !error.updateRequired) return null;
  if (error.securityUpdateRequired) return SECURITY_UPDATE_SENTENCE;
  const body = error.body as Record<string, unknown> | null;
  const named = body?.client;
  const kind: ClientKind = (CLIENT_KINDS as readonly unknown[]).includes(named)
    ? (named as ClientKind)
    : "recorder";
  const minimum = body?.minimumVersion;
  return isVersion(minimum)
    ? clientUpdateDetail(kind, minimum)
    : RECORDER_UPDATE_REQUIRED;
}

type OpenBotTarget = {
  openbotUrl: string;
  token?: string;
  /** The organization the connection was made in, as its grant named it. Absent: {@link DEFAULT_ORGANIZATION_ID}. */
  organizationId?: string;
};

/**
 * Sends the request with the bearer when there is one, never with cookies, and never follows a redirect. Every request
 * names the Recorder and the OpenBot release it was built from (`OpenBot-Client: recorder/<release>`), so OpenBot can
 * refuse a Recorder older than it serves with a sentence. These requests run in the service worker and the offscreen
 * document, which the install's host access lets reach any OpenBot without a CORS preflight; never from a content script.
 */
export async function openbotRaw(
  target: OpenBotTarget,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (target.token) headers.set("Authorization", `Bearer ${target.token}`);
  headers.set(CLIENT_HEADER, clientToken("recorder"));
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

/**
 * The organization every install has, which the API addresses as `default`. A connection is made there (the code it
 * exchanges names the organization it is for), and a connection whose grant named no organization works there too: that
 * is every connection an OpenBot older than organizations made.
 */
export const DEFAULT_ORGANIZATION_ID = "default";

/**
 * The organization a connection's requests go to: the one its grant named (`RecorderConnectionGrant.organizationId`),
 * else {@link DEFAULT_ORGANIZATION_ID}. A person can be in several organizations, and a Recorder connected in one records
 * into that one only.
 */
export function organizationOf(connection: {
  organizationId?: string | null;
}): string {
  return connection.organizationId || DEFAULT_ORGANIZATION_ID;
}

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
