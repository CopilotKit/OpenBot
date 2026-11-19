/**
 * How the phone reaches OpenBot's API: Orval's mutator for src/api/generated.
 *
 * Every operation the app uses calls this with the address, method, headers and serialised body the spec gives it. It
 * goes to the deployment the app was built for, in the organization the signed-in person is working in, with the
 * session's cookie and never the platform's own cookie jar, and a refusal is thrown as an {@link ApiError} in the server's own sentence.
 * Every request names the app and the OpenBot release it was built from (`OpenBot-Client: mobile/<release>`), and a
 * refusal of this app as too old (CLIENT_UPDATE_REQUIRED) is also told to the root layout, which shows Update OpenBot.
 */
import * as Crypto from "expo-crypto";
import * as auth from "../auth";
import { authClient, serverUrl } from "../auth";
import {
  CLIENT_UPDATE_REQUIRED,
  phoneUpdateDetail,
  reportUpdateRequired,
} from "../client-version";
import {
  createOrganizationChoice,
  type ListedOrganization,
  ORGANIZATION,
  ORGANIZATION_HEADER,
  type OrganizationChoices,
} from "../organization";
import { clientHeaders } from "../release";
import {
  getListOrganizationsUrl,
  listOrganizations,
} from "./generated/organizations/organizations";

/**
 * A refusal from the server, with its status and the API's problem code when it gave one, and whether a refusal of
 * this app as too old was for a security problem.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly security = false,
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
 * The organization every install has. What the deployment itself offers (how people sign in) is asked of it before
 * anybody has signed in, when the organization a person works in is not known yet. Once somebody is signed in it is
 * asked of the organization they work in ({@link deploymentOrganization}), since `default` need not be one of theirs.
 */
export const DEPLOYMENT_ORGANIZATION_ID = "default";

/** {@link ORGANIZATION_ID} as a generated call writes it into an address: each parameter is encoded as one segment. */
const WRITTEN = `/api/v2/organizations/${encodeURIComponent(ORGANIZATION_ID)}`;

/** Where the person's organizations are listed. It names no organization, and is what tells which ones there are. */
const OWN_ORGANIZATIONS = getListOrganizationsUrl();

/** Every organization the person is in, page by page. */
async function everyOrganization(): Promise<ListedOrganization[]> {
  const listed: ListedOrganization[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const page = await listOrganizations({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      listed.push(...page.organizations);
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
  return listed;
}

const organizations = createOrganizationChoice(
  everyOrganization,
  // Read off the module when used, so a phone with nowhere to keep it (a test that stands in for sign-in) keeps nothing.
  {
    read: async () => (await auth.organizationStore?.read()) ?? null,
    write: async (id) => {
      await auth.organizationStore?.write(id);
    },
  },
);

/** An address with its organization filled in, for whoever holds `cookie`. Any other address is left as it is. */
function inOrganization(url: string, cookie: string | null): Promise<string> {
  return organizations.address(
    url.startsWith(WRITTEN)
      ? `${ORGANIZATION}${url.slice(WRITTEN.length)}`
      : url,
    cookie ?? "",
  );
}

/**
 * The organization a request is for, for its OpenBot-Organization header: the one its address names, else the one the
 * person works in. Nothing before sign-in, when nobody works anywhere yet, and nothing for the list of the person's
 * organizations, which is how the one they work in is found.
 */
async function organizationFor(
  address: string,
  cookie: string | null,
): Promise<string | undefined> {
  if (!cookie || address.startsWith(OWN_ORGANIZATIONS)) return undefined;
  const named = /^\/api\/v2\/organizations\/([^/?]+)/.exec(address)?.[1];
  return named ? decodeURIComponent(named) : organizations.current(cookie);
}

/**
 * An address under the person's organization, for one that is opened and not fetched: a socket. `rest` is what follows
 * the organization, starting with a slash.
 */
export async function organizationAddress(rest: string): Promise<string> {
  return inOrganization(`${ORGANIZATION}${rest}`, await authClient.getCookie());
}

/** The organization the deployment is asked about: `default` before sign-in, else the one the person works in. */
export async function deploymentOrganization(): Promise<string> {
  return (await authClient.getCookie())
    ? ORGANIZATION_ID
    : DEPLOYMENT_ORGANIZATION_ID;
}

/** The signed-in person's organizations, and the one they work in. */
export async function organizationChoices(): Promise<OrganizationChoices> {
  return organizations.choices((await authClient.getCookie()) ?? "");
}

/**
 * Work in another of the person's organizations from now on: every request after this goes there, and the phone keeps
 * the pick for the next time the app opens.
 */
export async function chooseOrganization(
  id: string,
): Promise<OrganizationChoices> {
  return organizations.choose(id, (await authClient.getCookie()) ?? "");
}

/** The person asking, as the API addresses them in its `people/{personId}` operations. */
export const ME = "me";

/** Whether this request is a write to the API, which takes an Idempotency-Key. */
const apiWrite = (url: string, method: string) =>
  url.startsWith("/api/v2/") && method !== "GET";

/** The server's sentence for a refusal: the API's problems say it in `detail`, older routes in `error`. */
function refusal(body: unknown): {
  said?: string;
  code?: string;
  minimumVersion?: string;
  security?: boolean;
} {
  if (!body || typeof body !== "object") return {};
  const field = (name: string) => {
    const value = (body as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  };
  return {
    said: field("detail") ?? field("error"),
    code: field("code"),
    minimumVersion: field("minimumVersion"),
    security: (body as Record<string, unknown>).security === true,
  };
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
  Object.assign(headers, clientHeaders());
  const cookie = await authClient.getCookie();
  if (cookie) headers.cookie = cookie;
  const address = await inOrganization(url, cookie);
  const organization = await organizationFor(address, cookie);
  if (organization) headers[ORGANIZATION_HEADER] = organization;
  const response = await fetch(`${serverUrl}${address}`, {
    ...init,
    method,
    headers,
    credentials: "omit",
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const { said, code, minimumVersion, security } = refusal(body);
    if (code === CLIENT_UPDATE_REQUIRED) {
      // A minimum raised for a security problem is always said in the app's own words for it.
      const detail = security
        ? phoneUpdateDetail(minimumVersion, true)
        : (said ?? phoneUpdateDetail(minimumVersion));
      reportUpdateRequired(detail, security);
      throw new ApiError(detail, response.status, code, security);
    }
    throw new ApiError(
      said ?? `Request failed (${response.status}).`,
      response.status,
      code,
    );
  }
  return body as T;
}
