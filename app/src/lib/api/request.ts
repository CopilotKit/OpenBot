/**
 * How the generated API client reaches the server: Orval's mutator for app/src/lib/api/generated.
 *
 * Every operation in api/openapi.yaml calls this with the address, method, headers and serialised
 * body the spec gives it. It sends them through `clientRequest` in lib/client.ts, so a generated call
 * carries the session the way every other request in the app does, and a refusal reaches a screen as
 * the same `ClientError` with the server's own sentence, or the `fallback` the caller named.
 */
import { clientRequest } from "@/lib/client";

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
 * The organization a request is addressed to: the one the person is working in
 * (lib/organizations/current.ts). Called where the request is made, never kept, so a request made
 * after a switch goes to the organization the person switched to.
 */
export { organizationId } from "@/lib/organizations/current";

/**
 * The organization every install has. What the deployment itself offers (how people sign in, what it
 * can do) is asked of it, because that is asked before anybody has signed in, when the organization
 * a person works in is not known yet.
 */
export const DEPLOYMENT_ORGANIZATION = "default";

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
  const response = await clientRequest(url, init, fallback);
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
  return body as T;
}
