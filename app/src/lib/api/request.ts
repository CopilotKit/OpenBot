/**
 * How the generated API client reaches the server: Orval's mutator for app/src/lib/api/generated.
 *
 * Every operation in api/openapi.yaml calls this with the address, method, headers and serialised
 * body the spec gives it. It sends them through `clientRequest` in lib/client.ts, so a generated call
 * carries the session the way every other request in the app does, and a refusal reaches a screen as
 * the same `ClientError` with the server's own sentence, or the `fallback` the caller named.
 *
 * Until the server answers at the API's addresses, `servedToday` sends an operation to the
 * route that answers it now and puts the answer in the API's shape.
 */
import { clientRequest } from "@/lib/client";
import { servedToday } from "./served-today";

/** What a caller of a generated function may add to the request it makes. */
export type ApiRequestOptions = RequestInit & {
  /**
   * What a person reads when the server sent no message of its own. Name the entity in it, as
   * `client`'s fallback does.
   */
  fallback?: string;
  /**
   * The response a success arrived in, before its body is read: for an operation whose answer says
   * something in a header the generated function does not return, such as how much of the audit
   * trail an export holds.
   */
  onResponse?: (response: Response) => void;
};

/**
 * The answers the spec declares that are not JSON, read as text: the audit trail's CSV export. Any
 * other success that is not JSON is still a failed request.
 */
const TEXT_ANSWERS = ["text/csv"];

/**
 * The organization every request is in.
 *
 * Until multi-organization lands an install has exactly one, and the API addresses it as `default`
 * (api/openapi.yaml, `OrganizationId`). When a person can belong to several, this becomes the one
 * they are working in.
 */
export const ORGANIZATION_ID = "default";

/**
 * A key for one write, so a retry of the same write is recognised as the same one.
 *
 * Not `crypto.randomUUID()`: that exists only in a secure context, and a self-hosted OpenBot opened
 * at a plain-HTTP address on a network is not one, where every write would throw before it was sent.
 * `getRandomValues` is available everywhere.
 */
export function idempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function apiRequest<T>(
  url: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { fallback, onResponse, ...init } = options;
  const today = servedToday(url, init.method);
  const response = await clientRequest(today?.path ?? url, init, fallback);
  onResponse?.(response);
  if (response.status === 204) return undefined as T;
  const type = response.headers.get("content-type") ?? "";
  if (TEXT_ANSWERS.some((answer) => type.startsWith(answer))) {
    return (await response.text()) as T;
  }
  // A success that is not JSON is a failed request, as `client` treats it.
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(fallback ?? "That request failed.");
  }
  return (today ? today.answer(body) : body) as T;
}
