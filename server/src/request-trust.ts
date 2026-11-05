import {
  extensionIdFromOrigin,
  recorderExtensionIds,
} from "@openbot/shared/recorder-extension";
import { isAddressLiteral, isLoopbackHost } from "@openbot/shared/this-machine";
import type { Context, MiddlewareHandler } from "hono";
import type { DeploymentConfig, SingleUserAccess } from "./config";

/**
 * Which requests this server trusts, before any route asks who is calling.
 *
 * Two questions, answered in front of every route rather than in each one.
 *
 * WHICH SITE IS ASKING. A browser attaches the person's standing to any request a page makes: their
 * cookies, and on a single-user OpenBot simply being on the machine. So a page on another website
 * could POST to this server, open its sockets, and before this read `/api/copilotkit`, whose runtime
 * answered `Access-Control-Allow-Origin: *` by default. The browser says which page is asking in
 * `Origin` and `Sec-Fetch-Site`, and a page cannot forge either. A request that changes something,
 * and every WebSocket, from anywhere but this deployment's own pages is refused (web.dev's Fetch
 * Metadata resource isolation policy, applied to the unsafe methods). A request with neither header
 * is not a browser's: a webhook, a worker, a Bot calling back, the mobile app, a CLI. Those pass, and
 * their routes ask for their own credentials as they always have.
 *
 * Hono's `csrf` middleware asks the same of a browser and was not used: it also refuses a form post
 * that carries neither header, which is what Twilio's SMS webhook is (`/api/delivery/webhooks`).
 *
 * WHO MAY BE THE ONE ADMINISTRATOR. Single-user mode admits every request as one administrator, and
 * that is the point of it. It is a mode for one person's own machine, so it admits only that machine:
 * a caller connecting from loopback, to a name that is this machine's own. See
 * {@link singleUserRefusal}.
 */

/** What `http-server.ts` knows about the connection a request arrived on, passed to the app as a binding. */
export type NetworkCaller = { address: string | null };

/** The bindings `http-server.ts` hands the app for every request. */
export type FrontDoorBindings = { server: unknown; caller: NetworkCaller };

/**
 * The connection a request arrived on, or undefined for a request that did not arrive on one.
 *
 * Carried as a Hono binding, never on the request: the runtime and its hooks rebuild the request
 * (`new Request(request, …)`), which keeps the headers and loses anything attached to the object, and a
 * header would be something the caller writes. Only `http-server.ts` calls the app, and it always passes
 * one, so undefined is the app called in-process, as a test does.
 */
export function callerOf(context: Context): NetworkCaller | undefined {
  const bindings = context.env as { caller?: unknown } | undefined;
  const caller = bindings?.caller;
  return caller !== null &&
    typeof caller === "object" &&
    "address" in caller &&
    (typeof caller.address === "string" || caller.address === null)
    ? { address: caller.address }
    : undefined;
}

/** What a page from another site is told. The person reads it when something they did not start was stopped. */
export const CROSS_SITE_REFUSAL =
  "OpenBot only takes this from its own pages. Open OpenBot and try again there.";

/** What a single-user OpenBot says to a request addressed to a name it does not answer to. */
export const SINGLE_USER_HOST_REFUSAL =
  "OpenBot doesn't answer at this address. Open it at localhost or 127.0.0.1 on this computer.";

/** What a single-user OpenBot on somebody's own machine says to another machine. */
export const SINGLE_USER_MACHINE_REFUSAL =
  "This OpenBot only answers on the computer it runs on. Open it there, or set up sign-in so other people can use it.";

/**
 * Whether a browser origin is one of this deployment's own pages, or the Recorder extension.
 *
 * The deployment's origins are `config.browserOrigins`; the Recorder's are its fixed id and the configured
 * extras, the same list `/api/recorder/connections` admits, in both spellings Chrome and Edge use.
 */
export function trustedOrigin(
  config: Pick<DeploymentConfig, "browserOrigins" | "recorder">,
): (origin: string) => boolean {
  const origins = new Set(config.browserOrigins);
  const extensions = recorderExtensionIds({
    extra: config.recorder?.extraExtensionIds,
  });
  return (origin) =>
    origins.has(origin) || extensionIdFromOrigin(origin, extensions) !== null;
}

/**
 * The runtime's `cors.origin`: the request's origin echoed back when it is {@link trustedOrigin}, and
 * nothing otherwise, so the runtime sets no CORS headers and the browser keeps its answer from the page.
 */
export function corsOrigin(
  config: Pick<DeploymentConfig, "browserOrigins" | "recorder">,
): (origin: string) => string | null {
  const trusted = trustedOrigin(config);
  return (origin) => (trusted(origin) ? origin : null);
}

export function isWebSocketUpgrade(headers: Headers): boolean {
  return headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Whether a request was made by a page from another site.
 *
 * `Origin` first, because it names the page. Trusted, it passes whatever `Sec-Fetch-Site` says: the
 * Recorder is an extension, and an app served from its own origin names the API's. Otherwise it passes
 * only as the request's own origin, compared by host and not by scheme, because a proxy that ends TLS
 * in front of this server makes the request it forwards `http://` while the browser's page is
 * `https://`. `Origin: null` (a sandboxed frame, a file, a redirect across sites) is nobody's page.
 *
 * With no `Origin`, `Sec-Fetch-Site` alone: a browser that sent one and called the request another
 * site's is refused. `same-site` is refused too, since without an origin there is no telling which
 * sibling it was. Neither header is not a browser.
 */
export function crossSiteRequest(
  request: Request,
  trusted: (origin: string) => boolean,
): boolean {
  const { headers } = request;
  const origin = headers.get("origin");
  const site = headers.get("sec-fetch-site")?.toLowerCase();
  if (origin !== null) {
    if (trusted(origin)) return false;
    return site === "cross-site" || !sameHost(origin, request);
  }
  return site === "cross-site" || site === "same-site";
}

/** The `Host` the request names, or for one built in-process with none, its URL's, which Bun builds from `Host`. */
function sameHost(origin: string, request: Request): boolean {
  try {
    const host =
      request.headers.get("host")?.trim().toLowerCase() ||
      new URL(request.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The cross-site guard, in front of every `/api` route.
 *
 * Two routes are left to their own, stricter checks. `/api/auth/*` is Better Auth's: it checks its own
 * trusted origins, and an identity provider's `form_post` callback arrives carrying the provider's
 * origin. `POST /api/recorder/connections` admits only the Recorder's origin and records every origin
 * it refuses, which a refusal here would leave off the trail.
 *
 * Both spellings of the path, for the reason the enterprise gate gives: Hono routes on the decoded path
 * and the runtime reads the raw one. A route is exempt only when both name it.
 */
export function createOriginGuard(
  config: Pick<DeploymentConfig, "browserOrigins" | "recorder">,
): MiddlewareHandler {
  const trusted = trustedOrigin(config);
  return async (context, next) => {
    const headers = context.req.raw.headers;
    if (SAFE_METHODS.has(context.req.method) && !isWebSocketUpgrade(headers))
      return next();
    const paths = [context.req.path, new URL(context.req.url).pathname];
    const exempt =
      paths.every(
        (path) => path === "/api/auth" || path.startsWith("/api/auth/"),
      ) ||
      (context.req.method === "POST" &&
        paths.every((path) => path === "/api/recorder/connections"));
    if (!exempt && crossSiteRequest(context.req.raw, trusted))
      return context.json({ error: CROSS_SITE_REFUSAL }, 403);
    return next();
  };
}

/** A plain Host header, lowercased: a name or an address, and a port or none. */
const PLAIN_HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::\d{1,5})?$/;

/** A Host header's name, lowercased and without its port, or null for one that is not a plain host. */
function hostName(request: Request): string | null {
  const raw = request.headers.get("host")?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    try {
      return new URL(request.url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  const match = PLAIN_HOST.exec(raw);
  return match?.[1]?.replace(/\.+$/, "") ?? null;
}

/**
 * Why a request may not be this single-user OpenBot's administrator, or null when it may.
 *
 * Asked wherever that administrator is admitted (the single-user guard, the runtime, the live screen's
 * socket) and nowhere else. The routes that answer containers and services (a Bot calling back, the
 * model proxy, the routines worker) prove themselves with their own secrets and are not asked, so a Bot
 * on the engine's network, or the worker calling `http://server:3001`, works as it did.
 *
 * Two checks.
 *
 * THE CALLER IS ON THIS MACHINE, where the server runs on it (`access.thisMachineOnly`). The address is
 * the socket's peer, which nobody can write: the server listens on every interface so containers can
 * call back, and before this anybody on the same network who opened the port was the administrator.
 *
 * THE REQUEST IS ADDRESSED TO THIS MACHINE. A page on an attacker's name, rebound to 127.0.0.1 once it
 * has loaded, is same-origin with itself: it sends no foreign `Origin`, and its peer is loopback. Its
 * `Host` is still the attacker's name. So only this machine's loopback names and the hosts of the
 * configured URLs are accepted, and, where other machines are expected, any IP address, which no DNS
 * answer can stand in for. The same check the MCP SDK's `hostHeaderValidation` makes.
 *
 * Undefined `caller` is the app called in-process, which has no connection to check.
 */
export function singleUserRefusal(
  request: Request,
  caller: NetworkCaller | undefined,
  access: SingleUserAccess | undefined,
): string | null {
  if (!caller) return null;
  const { thisMachineOnly, hosts } = access ?? {
    thisMachineOnly: true,
    hosts: [],
  };
  if (
    thisMachineOnly &&
    !(caller.address !== null && isLoopbackHost(caller.address))
  )
    return SINGLE_USER_MACHINE_REFUSAL;
  const host = hostName(request);
  if (
    host === null ||
    !(
      isLoopbackHost(host) ||
      hosts.includes(host) ||
      (!thisMachineOnly && isAddressLiteral(host))
    )
  )
    return SINGLE_USER_HOST_REFUSAL;
  return null;
}

/**
 * {@link singleUserRefusal} in front of routes that admit the administrator on their own, as the
 * runtime does: it resolves its caller from the request it is handed, which by then may be a copy.
 * `except` names requests that prove somebody else, which the runtime answers without the administrator.
 */
export function createSingleUserGate(
  access: SingleUserAccess | undefined,
  except: (request: Request) => boolean = () => false,
): MiddlewareHandler {
  return async (context, next) => {
    if (except(context.req.raw)) return next();
    const refused = singleUserRefusal(
      context.req.raw,
      callerOf(context),
      access,
    );
    if (refused) return context.json({ error: refused }, 403);
    return next();
  };
}

/**
 * OpenBot's own origin as a caller on this machine reached it, or null.
 *
 * For an address handed to something that is not one of OpenBot's pages, and so has no page to
 * resolve a path against: the Recorder's capture pass names the Intelligence gateway's socket on
 * OpenBot's own address (intelligence-gateway-proxy.ts). Where no public URL is configured, as over a
 * `kubectl port-forward`, the only name that address has is the one the caller used to reach it.
 *
 * Made from `Host` only where nobody else could have written it. The caller is on loopback: the
 * socket's peer, which nobody can write, and what a port-forward's connection is inside the pod. The
 * Host is one of this machine's own loopback names, which no DNS answer can stand in for. And a
 * single-user OpenBot admits the request at all ({@link singleUserRefusal}). Any other caller's Host
 * is its own say-so, and it gets nothing made from it. The scheme is the connection's own, which over
 * a port-forward is plain HTTP.
 *
 * Undefined `caller` is the app called in-process, which has no connection to vouch for anything.
 */
export function ownOriginOnThisMachine(
  request: Request,
  caller: NetworkCaller | undefined,
  config: Pick<DeploymentConfig, "singleUser" | "singleUserAccess">,
): string | null {
  if (!caller?.address || !isLoopbackHost(caller.address)) return null;
  if (
    config.singleUser &&
    singleUserRefusal(request, caller, config.singleUserAccess) !== null
  )
    return null;
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (!host || !PLAIN_HOST.test(host)) return null;
  let origin: URL;
  try {
    origin = new URL(`${new URL(request.url).protocol}//${host}`);
  } catch {
    return null;
  }
  return isLoopbackHost(origin.hostname) ? origin.origin : null;
}
