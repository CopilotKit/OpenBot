/**
 * How the phone reaches OpenBot's API: Orval's mutator for src/api/generated.
 *
 * Every operation the app uses calls this with the address, method, headers and serialised body the spec gives it. It
 * goes to the deployment the app was built for, in the organization the signed-in person is working in, with the
 * session's cookie and never the platform's own cookie jar, and a refusal is thrown as an {@link ApiError} in the server's own sentence.
 */
import * as Crypto from "expo-crypto";
import { authClient, serverUrl } from "../auth";
import {
  createOrganizationAddress,
  type ListedOrganization,
  ORGANIZATION,
} from "../organization";
import { listOrganizations } from "./generated/organizations/organizations";

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

/**
 * The organization every request is in: the one the signed-in person is working in. A generated call is given this in
 * place of an id, and the request below fills in the id from the person's own organizations, read once for each sign-in
 * (../organization.ts). So no screen names an organization, and none can name the wrong one.
 */
export const ORGANIZATION_ID = "{organizationId}";

/**
 * The organization every install has. What the deployment itself offers (how people sign in) is asked of it, because
 * that is asked before anybody has signed in, when the organization a person works in is not known yet.
 */
export const DEPLOYMENT_ORGANIZATION_ID = "default";

/** {@link ORGANIZATION_ID} as a generated call writes it into an address: each parameter is encoded as one segment. */
const WRITTEN = `/api/v2/organizations/${encodeURIComponent(ORGANIZATION_ID)}`;

const addressed = createOrganizationAddress(async () => {
  const organizations: ListedOrganization[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const page = await listOrganizations({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      organizations.push(...page.organizations);
      if (cursor) seen.add(cursor);
      cursor =
        typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor && !seen.has(cursor));
  } catch (error) {
    // An OpenBot that keeps one organization may have no list of them.
    if (error instanceof ApiError && error.status === 404)
      return [{ id: DEPLOYMENT_ORGANIZATION_ID, active: true }];
    throw error;
  }
  return organizations;
});

/** An address with its organization filled in, for whoever holds `cookie`. Any other address is left as it is. */
function inOrganization(url: string, cookie: string | null): Promise<string> {
  return addressed(
    url.startsWith(WRITTEN)
      ? `${ORGANIZATION}${url.slice(WRITTEN.length)}`
      : url,
    cookie ?? "",
  );
}

/**
 * An address under the person's organization, for one that is opened and not fetched: a socket. `rest` is what follows
 * the organization, starting with a slash.
 */
export async function organizationAddress(rest: string): Promise<string> {
  return inOrganization(`${ORGANIZATION}${rest}`, await authClient.getCookie());
}

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
  const address = await inOrganization(url, cookie);
  const response = await fetch(`${serverUrl}${address}`, {
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
