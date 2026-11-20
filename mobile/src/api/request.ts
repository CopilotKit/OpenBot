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
  IN_NO_ORGANIZATION,
  type ListedOrganization,
  ORGANIZATION,
  ORGANIZATION_HEADER,
  type OrganizationChoices,
} from "../organization";
import { reportOrganizationGone } from "../organization-gone";
import { reportRenewalNeedsClick } from "../renewal";
import { clientHeaders } from "../release";
import { reportSessionRefused } from "../session-refused";
import type { Deployment } from "./generated/model";
import { getDeployment } from "./generated/organization-settings/organization-settings";
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
 * asked of the organization they work in ({@link readDeployment}), since `default` need not be one of theirs.
 */
export const DEPLOYMENT_ORGANIZATION_ID = "default";

/** The API's code for a hosted OpenBot's sign-in needing renewal: the session is still signed in. */
const RENEWAL_REQUIRED = "HOSTED_SIGN_IN_RENEWAL_REQUIRED";

/** The header that names where sign-in renews it. */
const SIGN_IN_HEADER = "OpenBot-Sign-In";

/** Where the hosted sign-in starts: the path the server named, when it is one of its own, else the usual one. */
function signInAddress(named: string | null): string {
  return named?.startsWith("/") && !named.startsWith("//")
    ? named
    : "/api/auth/hosted/sign-in";
}

/** The API's code for an organization that isn't there for the person asking: never theirs, left, or deleted. */
const ORGANIZATION_NOT_FOUND = "ORGANIZATION_NOT_FOUND";

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

/** Who the sign-in client says is signed in, by their account's id: the root layout says (`setSignedInPerson`). */
let signedInPerson: string | undefined;

/**
 * Say who is signed in, as the sign-in client reports them, or that nobody is. Each person's pick of organization is
 * their own (../organization.ts), so the phone works in the one this person picked, never the last person's.
 */
export function setSignedInPerson(person: string | undefined): void {
  signedInPerson = person || undefined;
}

const organizations = createOrganizationChoice(
  everyOrganization,
  // Read off the module when used, so a phone with nowhere to keep it (a test that stands in for sign-in) keeps nothing.
  {
    read: async (person) =>
      (await auth.organizationStore?.read(person)) ?? null,
    write: async (person, id) => {
      await auth.organizationStore?.write(person, id);
    },
  },
  () => signedInPerson,
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
  if (named) return decodeURIComponent(named);
  // A cookie that is not a live session can't read the person's organizations: the request goes without the header,
  // and is answered as whoever holds that cookie is.
  return organizations.current(cookie).catch(() => undefined);
}

/**
 * An address under the person's organization, for one that is opened and not fetched: a socket. `rest` is what follows
 * the organization, starting with a slash.
 */
export async function organizationAddress(rest: string): Promise<string> {
  return inOrganization(`${ORGANIZATION}${rest}`, await authClient.getCookie());
}

/**
 * What the deployment offers (how people sign in, which apps it serves), read in the organization the person works in
 * while they hold a live session (`signedIn`, the session the sign-in client reports), and in `default` otherwise.
 *
 * Whether somebody is signed in is the session's answer, never whether the phone holds a cookie: sign-in leaves cookies
 * of its own behind (an unfinished sign-in's state, an expired or revoked session), and reading the person's
 * organizations with one of those is refused, which left the signed-out screen with no way to sign in. A session that
 * turns out to have ended on the way (refused as signed out), or whose organization isn't found, is read in `default`
 * too.
 *
 * `default`'s is read as nobody: no cookie and no organization of the person's. It answers anybody, and a signed-in
 * person who isn't a member of `default` is refused there as if it didn't exist.
 */
export async function readDeployment(signedIn: boolean): Promise<Deployment> {
  const asNobody = () =>
    getDeployment(DEPLOYMENT_ORGANIZATION_ID, { anonymous: true });
  if (!signedIn) return asNobody();
  try {
    return await getDeployment(ORGANIZATION_ID);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 404)
    )
      return asNobody();
    throw error;
  }
}

/**
 * Every organization the signed-in person is in, or none: somebody removed from their last organization is in none,
 * which is an answer here and not a failure.
 */
export async function organizationsHeld(): Promise<ListedOrganization[]> {
  try {
    return (await organizationChoices()).organizations;
  } catch (error) {
    if (error instanceof Error && error.message === IN_NO_ORGANIZATION)
      return [];
    throw error;
  }
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

/**
 * What a generated call may add to its request. `anonymous` sends it as nobody: no session cookie and no organization,
 * for an address that answers anybody (`default`'s deployment) and would refuse the person's own session.
 */
export type ApiRequestInit = RequestInit & {
  anonymous?: boolean;
  /** Sent again after the hosted sign-in was renewed: refused for renewal again, it isn't renewed again. */
  renewed?: boolean;
};

export async function apiRequest<T>(
  url: string,
  options: ApiRequestInit = {},
): Promise<T> {
  const { anonymous = false, renewed = false, ...init } = options;
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
  const cookie = anonymous ? null : await authClient.getCookie();
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
    // Sent as somebody signed in and refused as nobody: the session is gone, and the app reads it again.
    // Except a hosted OpenBot's sign-in needing renewal, which is never being signed out: the session still works.
    if (response.status === 401 && cookie && code !== RENEWAL_REQUIRED)
      reportSessionRefused();
    /*
     * A hosted OpenBot's proof ran out: renewed through the hosted sign-in in the in-app browser, then the request is
     * sent again, once, exactly as it was, its Idempotency-Key and all, so a write that did land is answered as a
     * repeat and never done twice. Refused for renewal again, the person is offered "Sign in again".
     */
    if (code === RENEWAL_REQUIRED && cookie) {
      const signIn = signInAddress(response.headers.get(SIGN_IN_HEADER));
      if (!renewed && auth.renewHostedSignIn) {
        const { cookie: _sent, ...again } = headers;
        await auth.renewHostedSignIn(signIn);
        return apiRequest<T>(url, { ...init, headers: again, renewed: true });
      }
      reportRenewalNeedsClick(signIn);
    }
    // The organization the person works in isn't there for them any more: forgotten, so the next request reads their
    // organizations again and works in another of theirs, and Home is told.
    if (
      code === ORGANIZATION_NOT_FOUND &&
      cookie &&
      organization &&
      (await organizations.gone(organization, cookie))
    )
      reportOrganizationGone();
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
