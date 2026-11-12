import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { RemoteOAuthConfig } from "../db/schema/remote-oauth-config";
import { OAUTH_REQUEST_TIMEOUT_MS } from "../timeouts";
import {
  type CatalogueAuth,
  type CatalogueEntry,
  customUrlRefusal,
} from "./catalogue";
import type { OAuthClient } from "./plugin-store/model";

export type { RemoteOAuthConfig };

/**
 * Signing a person in to an MCP server somebody added by its address.
 *
 * The catalogue's OAuth vendors have their endpoints reviewed and pinned in code. A server added by
 * URL has none of that, so this follows the MCP authorization spec instead: the server's 401 names
 * its protected resource metadata (RFC 9728), that names the authorization server, whose own
 * metadata (RFC 8414 or OpenID discovery) names the endpoints. OpenBot registers itself there (RFC
 * 7591), sends the person to consent with PKCE (S256) and the `resource` parameter (RFC 8707), and
 * redeems the code on the server side.
 *
 * Every one of those steps is the official MCP TypeScript SDK's own (`client/auth.js`), not a copy of
 * it. What this module adds is the part the SDK leaves to its caller: every address it is asked to
 * fetch on the server side is held to the same floor as the server's own address
 * ({@link customUrlRefusal}), and nothing follows a redirect. Discovery hands OpenBot addresses that
 * somebody else's server chose, so without the floor "add a server" would become a way to make this
 * deployment fetch whatever its network can reach.
 */

/** Why a server could not be added or signed in to, in a sentence a person reads. */
export class RemoteServerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteServerRefusedError";
  }
}

/**
 * `fetch`, held to the address floor, with no redirect followed and a deadline.
 *
 * A redirect is left as the response rather than followed: a 3xx from a discovery or token endpoint
 * is somebody else deciding where this deployment sends its next request, which is exactly the
 * choice the floor exists to take away.
 */
export const guardedFetch = async (
  url: string | URL,
  init?: RequestInit,
): Promise<Response> => {
  const address = String(url);
  const refusal = customUrlRefusal(address);
  if (refusal) {
    throw new RemoteServerRefusedError(
      `The server pointed OpenBot at ${safeHost(address)}, which OpenBot won't reach.`,
    );
  }
  return fetch(address, {
    ...init,
    redirect: "manual",
    signal: init?.signal ?? AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
  });
};

function safeHost(address: string): string {
  try {
    return new URL(address).host || "an address";
  } catch {
    return "an address";
  }
}

/** What a server said when OpenBot first asked it something, with no credential at all. */
export type RemoteProbe =
  /** It answered. Nothing to sign in to. */
  | { kind: "open" }
  /** It asked for a sign-in, and said where. */
  | { kind: "oauth"; config: RemoteOAuthConfig }
  /** It refused and named no sign-in, so it wants a key. */
  | { kind: "key" };

/** The `initialize` request every MCP client opens with, as the probe sends it. */
const PROBE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "openbot", version: "1.0.0" },
  },
});

/**
 * Ask the server, with no credential, whether it needs one and which kind.
 *
 * A 401 or 403 with a Bearer challenge is the MCP authorization spec's answer; whatever the challenge
 * names (or the well-known addresses, where it names none) is followed to an authorization server.
 * A refusal that leads to no authorization server is a server that wants a key. Anything else that is
 * not a success means the address is not an MCP server OpenBot can talk to.
 */
export async function probeRemoteServer(
  url: string,
  fetchFn: typeof guardedFetch = guardedFetch,
): Promise<RemoteProbe> {
  const host = safeHost(url);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: PROBE_BODY,
    });
  } catch (error) {
    if (error instanceof RemoteServerRefusedError) throw error;
    throw new RemoteServerRefusedError(
      `Couldn't reach ${host}. Check the address and try again.`,
    );
  }
  // The body is not read past this point; release it.
  void response.body?.cancel().catch(() => {});

  if (response.ok) return { kind: "open" };
  if (response.status !== 401 && response.status !== 403) {
    throw new RemoteServerRefusedError(
      response.status === 404 || response.status === 405
        ? `${host} didn't answer as an MCP server. Check the address. It usually ends in /mcp.`
        : `${host} didn't answer as an MCP server (it said ${response.status}). Check the address and try again.`,
    );
  }

  const challenge = extractWWWAuthenticateParams(response);
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(url, {
      ...(challenge.resourceMetadataUrl
        ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
        : {}),
      fetchFn,
    });
  } catch (error) {
    if (error instanceof RemoteServerRefusedError) throw error;
    return { kind: "key" };
  }
  const metadata = info.authorizationServerMetadata;
  if (!metadata) return { kind: "key" };
  /*
   * The metadata has to be the authorization server's own (RFC 8414 section 3.3): its `issuer` is
   * the address it was fetched for. The SDK does not check this, so it is checked here. A trailing
   * slash is the only difference forgiven, since issuers are written both ways.
   */
  const trimmed = (value: string) => value.replace(/\/+$/, "");
  if (trimmed(metadata.issuer) !== trimmed(info.authorizationServerUrl)) {
    throw new RemoteServerRefusedError(
      `${host}'s sign-in details don't match the server that published them, so OpenBot won't use them.`,
    );
  }

  /*
   * The resource a token is asked for. The server's own metadata names it, and the SDK's rule decides
   * whether that name may stand for this address: a resource metadata document naming some other
   * server would otherwise have a person consent to a token for that server.
   */
  let resource = url;
  if (info.resourceMetadata?.resource) {
    if (
      !checkResourceAllowed({
        requestedResource: url,
        configuredResource: info.resourceMetadata.resource,
      })
    ) {
      throw new RemoteServerRefusedError(
        `${host} says its sign-in is for a different address, so OpenBot won't use it.`,
      );
    }
    resource = info.resourceMetadata.resource;
  }

  // The endpoints this deployment fetches from itself are held to the floor now, at add, so a server
  // whose sign-in could never work is refused with a reason rather than at somebody's first Connect.
  for (const endpoint of [
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ]) {
    if (endpoint && customUrlRefusal(endpoint)) {
      throw new RemoteServerRefusedError(
        `${host} signs people in at ${safeHost(endpoint)}, which OpenBot won't reach.`,
      );
    }
  }
  // The authorization endpoint is opened in the person's browser, never fetched here, but it is still
  // an address OpenBot sends somebody to, so it has to be a web address and not a script.
  if (!/^https?:$/.test(new URL(metadata.authorization_endpoint).protocol)) {
    throw new RemoteServerRefusedError(
      `${host} names a sign-in page OpenBot can't open.`,
    );
  }
  if (!metadata.registration_endpoint) {
    throw new RemoteServerRefusedError(
      `${host} signs people in, but it doesn't let apps like OpenBot register themselves, so OpenBot can't connect to it yet.`,
    );
  }

  const scope =
    challenge.scope ??
    (info.resourceMetadata?.scopes_supported?.length
      ? info.resourceMetadata.scopes_supported.join(" ")
      : undefined);

  return {
    kind: "oauth",
    config: {
      metadata: metadata as unknown as Record<string, unknown>,
      authorizationServer: info.authorizationServerUrl,
      resource,
      ...(scope ? { scope } : {}),
    },
  };
}

const metadataOf = (config: RemoteOAuthConfig) =>
  config.metadata as unknown as AuthorizationServerMetadata;

/** The SDK's shape for the client this deployment registered. */
function clientInformation(client: OAuthClient): OAuthClientInformationMixed {
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    ...(client.authMethod
      ? { token_endpoint_auth_method: client.authMethod }
      : {}),
  } as OAuthClientInformationMixed;
}

/**
 * Register OpenBot as a client of the server's authorization server (RFC 7591).
 *
 * A public client proving itself with PKCE where the server allows one; otherwise a confidential one,
 * whose secret the server issues and this deployment keeps in the vault like any other.
 */
export async function registerRemoteClient(input: {
  config: RemoteOAuthConfig;
  redirectUri: string;
  serverTitle: string;
  fetchFn?: typeof guardedFetch;
}): Promise<OAuthClient> {
  const metadata = metadataOf(input.config);
  const supported = metadata.token_endpoint_auth_methods_supported ?? [];
  const method =
    supported.length === 0 || supported.includes("none")
      ? "none"
      : supported.includes("client_secret_post")
        ? "client_secret_post"
        : "client_secret_basic";
  const loopback = /^http:\/\/(127\.0\.0\.1|\[::1\])(:|\/)/.test(
    input.redirectUri,
  );
  const clientMetadata = {
    client_name: "OpenBot",
    redirect_uris: [input.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    // Required by the current MCP authorization spec for a registration request.
    application_type: loopback ? "native" : "web",
  } as OAuthClientMetadata;
  try {
    const registered = await registerClient(input.config.authorizationServer, {
      metadata,
      clientMetadata,
      ...(input.config.scope ? { scope: input.config.scope } : {}),
      fetchFn: input.fetchFn ?? guardedFetch,
    });
    return {
      clientId: registered.client_id,
      clientSecret: registered.client_secret ?? "",
      authMethod: registered.token_endpoint_auth_method ?? method,
    };
  } catch (error) {
    if (error instanceof RemoteServerRefusedError) throw error;
    console.error(
      JSON.stringify({
        type: "remote-mcp-registration-refused",
        server: input.config.resource,
        error: error instanceof Error ? error.message.slice(0, 400) : "",
      }),
    );
    throw new RemoteServerRefusedError(
      `${input.serverTitle} didn't let OpenBot register to sign you in. Some servers only accept apps they've approved.`,
    );
  }
}

/**
 * The consent page to send a person to, and the PKCE verifier that redeems what comes back.
 *
 * The SDK builds the address (with `resource` and the server's scope) and mints the verifier. The
 * `state` it is given is a placeholder: the caller seals the verifier into the real state and puts
 * it on the address itself, because the state has to carry the very verifier this call produces.
 */
export async function startRemoteAuthorization(input: {
  config: RemoteOAuthConfig;
  client: OAuthClient;
  redirectUri: string;
}): Promise<{ authorizationUrl: URL; verifier: string }> {
  const started = await startAuthorization(input.config.authorizationServer, {
    metadata: metadataOf(input.config),
    clientInformation: clientInformation(input.client),
    redirectUrl: input.redirectUri,
    state: "pending",
    resource: new URL(input.config.resource),
    ...(input.config.scope ? { scope: input.config.scope } : {}),
  });
  return {
    authorizationUrl: started.authorizationUrl,
    verifier: started.codeVerifier,
  };
}

/**
 * Whether the `iss` a consent came back with is the authorization server it was sent to (RFC 9207).
 *
 * Required where the server says it sends one; checked whenever one arrives. It is what stops a code
 * minted by one authorization server being redeemed at another's token endpoint.
 */
export function issuerMatches(
  config: RemoteOAuthConfig,
  iss: string | undefined,
): boolean {
  const metadata = config.metadata as {
    issuer?: unknown;
    authorization_response_iss_parameter_supported?: unknown;
  };
  if (iss === undefined || iss === "") {
    return metadata.authorization_response_iss_parameter_supported !== true;
  }
  return typeof metadata.issuer === "string" && metadata.issuer === iss;
}

/**
 * One person's tokens for one server, as the vault holds them.
 *
 * The catalogue's vendors are held as a refresh token alone, because each of them issues one. A
 * server added by URL may issue only an access token, or one that lasts an hour, so the whole set is
 * kept and the access token is used until it is about to expire.
 */
export type RemoteTokenSet = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. Absent when the server gave no lifetime. */
  expiresAt?: number;
};

/** How early an access token is treated as expired, so it does not lapse in flight. */
const EXPIRY_MARGIN_MS = 60_000;

export function tokenSetFrom(
  tokens: OAuthTokens,
  previous?: RemoteTokenSet,
  now: number = Date.now(),
): RemoteTokenSet {
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  return {
    accessToken: tokens.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof tokens.expires_in === "number"
      ? { expiresAt: now + tokens.expires_in * 1000 }
      : {}),
  };
}

export function serializeTokenSet(set: RemoteTokenSet): string {
  return JSON.stringify({ v: 1, ...set });
}

/** A stored set, or null for anything that is not one. */
export function parseTokenSet(raw: string): RemoteTokenSet | null {
  try {
    const value = JSON.parse(raw) as Partial<RemoteTokenSet> & { v?: number };
    if (value?.v !== 1 || typeof value.accessToken !== "string") return null;
    return {
      accessToken: value.accessToken,
      ...(typeof value.refreshToken === "string"
        ? { refreshToken: value.refreshToken }
        : {}),
      ...(typeof value.expiresAt === "number"
        ? { expiresAt: value.expiresAt }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Whether the access token in a set can still be presented. */
export function accessTokenLive(
  set: RemoteTokenSet,
  now: number = Date.now(),
): boolean {
  return set.expiresAt === undefined || set.expiresAt - EXPIRY_MARGIN_MS > now;
}

/** Redeem the code a consent came back with, at the server's own token endpoint. */
export async function redeemRemoteCode(input: {
  config: RemoteOAuthConfig;
  client: OAuthClient;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchFn?: typeof guardedFetch;
}): Promise<RemoteTokenSet> {
  const tokens = await exchangeAuthorization(input.config.authorizationServer, {
    metadata: metadataOf(input.config),
    clientInformation: clientInformation(input.client),
    authorizationCode: input.code,
    codeVerifier: input.verifier,
    redirectUri: input.redirectUri,
    resource: new URL(input.config.resource),
    fetchFn: input.fetchFn ?? guardedFetch,
  });
  return tokenSetFrom(tokens);
}

/** Thrown when the server no longer honours a person's refresh token: they have to connect again. */
export class RemoteGrantEndedError extends Error {
  constructor() {
    super("The server no longer honours this sign-in.");
    this.name = "RemoteGrantEndedError";
  }
}

/** A fresh access token for a set whose own has expired. */
export async function refreshRemoteTokens(input: {
  config: RemoteOAuthConfig;
  client: OAuthClient;
  set: RemoteTokenSet;
  fetchFn?: typeof guardedFetch;
}): Promise<RemoteTokenSet> {
  if (!input.set.refreshToken) throw new RemoteGrantEndedError();
  try {
    const tokens = await refreshAuthorization(
      input.config.authorizationServer,
      {
        metadata: metadataOf(input.config),
        clientInformation: clientInformation(input.client),
        refreshToken: input.set.refreshToken,
        resource: new URL(input.config.resource),
        fetchFn: input.fetchFn ?? guardedFetch,
      },
    );
    return tokenSetFrom(tokens, input.set);
  } catch (error) {
    const code = (error as { errorCode?: unknown }).errorCode;
    if (code === "invalid_grant" || code === "invalid_client") {
      throw new RemoteGrantEndedError();
    }
    throw error;
  }
}

/**
 * A server added by URL that signs people in, described in the catalogue's own words for a vendor
 * that does: a `user-oauth` server that registers itself. Every reader that asks "is this reached on
 * the person's own grant, and does anybody have to set a client up first" then answers the same for
 * both, rather than each learning a second shape.
 */
export function remoteOAuthAuth(
  config: RemoteOAuthConfig,
): Extract<CatalogueAuth, { kind: "user-oauth" }> {
  const metadata = metadataOf(config);
  return {
    kind: "user-oauth",
    authorizationUrl: metadata.authorization_endpoint,
    tokenUrl: metadata.token_endpoint,
    revokeUrl:
      (metadata as { revocation_endpoint?: string }).revocation_endpoint ?? "",
    scopes: config.scope ? config.scope.split(" ").filter(Boolean) : [],
    clientRegistration: "dynamic",
    ...(metadata.registration_endpoint
      ? { registrationUrl: metadata.registration_endpoint }
      : {}),
  };
}

/**
 * How a server is reached, as the catalogue would describe it: its entry's own auth, or for a server
 * added by URL that signs people in, {@link remoteOAuthAuth}. Null for any other server added by URL.
 */
export function authOf(
  entry: CatalogueEntry | null,
  row: { oauth?: RemoteOAuthConfig | null },
): CatalogueAuth | null {
  if (entry) return entry.auth;
  return row.oauth ? remoteOAuthAuth(row.oauth) : null;
}
