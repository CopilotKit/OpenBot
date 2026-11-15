/**
 * How the phone reaches OpenBot's API: Orval's mutator for src/api/generated.
 *
 * Every operation the app uses calls this with the address, method, headers and serialised body the spec gives it. It
 * goes to the deployment the app was built for, with the signed-in session's cookie and never the platform's own cookie
 * jar, and a refusal is thrown as an {@link ApiError} in the server's own sentence.
 */
import * as Crypto from "expo-crypto";
import { authClient, serverUrl } from "../auth";

/** A refusal from the server, with its status and the API's problem code when it gave one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The organization every request is in: until a person can belong to several, an install has one, addressed as `default`. */
export const ORGANIZATION_ID = "default";

/** The person asking, as the API addresses them in its `people/{personId}` operations. */
export const ME = "me";

/** Whether this request is a write to the API, which takes an Idempotency-Key. */
const apiWrite = (url: string, method: string) =>
  url.startsWith("/api/v2/") && method !== "GET";

/** The server's sentence for a refusal: the API's problems say it in `detail`, older routes in `error`. */
function refusal(body: unknown): { said?: string; code?: string } {
  if (!body || typeof body !== "object") return {};
  const field = (name: string) => {
    const value = (body as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
  return { said: field("detail") ?? field("error"), code: field("code") };
}

export async function apiRequest<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  if (!url.startsWith("/api/")) throw new Error("Use an OpenBot API path.");
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  // A new key for each write, unless the caller sends its own to retry with.
  if (apiWrite(url, method) && !headers["idempotency-key"])
    headers["idempotency-key"] = Crypto.randomUUID();
  const cookie = await authClient.getCookie();
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${serverUrl}${url}`, {
    ...init,
    method,
    headers,
    credentials: "omit",
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const { said, code } = refusal(body);
    throw new ApiError(
      said ?? `Request failed (${response.status}).`,
      response.status,
      code,
    );
  }
  return body as T;
}
