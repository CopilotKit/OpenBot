/**
 * The credential request an ADK agent makes, read defensively.
 *
 * A remote agent built on Google ADK asks for a person's own sign-in by emitting a tool call named
 * `adk_request_credential` and pausing its run. The arguments carry an `authConfig`: the OAuth
 * authorization URL the person must visit, and room for the answer. The client's half of the
 * contract is to send that same `authConfig` back as the tool result with `authResponseUri` (the
 * full callback URL the provider redirected to) and `redirectUri` (where we asked it to redirect)
 * filled in; the agent then exchanges the code for a token on its own side. The token itself never
 * passes through here.
 *
 * ADK serializes with camelCase aliases, but other stacks dump the same models in snake_case, so
 * everything is read in both spellings and answers are written back in the spelling that arrived.
 */

/** The path the consent popup returns to. The server serves a static page at this address. */
export const AGENT_OAUTH_CALLBACK_PATH = "/api/agents/oauth/callback";

/** The `type` of the message that page posts to its opener. */
export const AGENT_OAUTH_CALLBACK_MESSAGE = "openbot:agent-oauth-callback";

type Json = Record<string, unknown>;

export type CredentialRequest = {
  /** The whole config as it arrived, echoed back verbatim on decline and completed on consent. */
  authConfig: Json;
  /** Where the person signs in. The provider's consent page, built by the agent. */
  authorizationUrl: string;
  /** The state the agent minted into that URL, used to match the callback to this request. */
  state: string | undefined;
  /** The host asking for the sign-in, e.g. accounts.google.com. For display. */
  provider: string;
  /** What is being asked for, when the request says. For display. */
  scopes: string[];
};

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** Read a field in whichever spelling the sender used. An explicit camelCase value wins. */
function pick(object: Json | undefined, camel: string, snake: string): unknown {
  if (!object) return undefined;
  return object[camel] !== undefined ? object[camel] : object[snake];
}

function oauth2Of(authConfig: Json): Json | undefined {
  const exchanged = asObject(
    pick(authConfig, "exchangedAuthCredential", "exchanged_auth_credential"),
  );
  return asObject(exchanged?.oauth2);
}

/**
 * Read the tool call's arguments into a request, or nothing when they do not carry one.
 *
 * Arguments stream in, so an incomplete object is the normal in-progress state rather than an
 * error; the card shows a placeholder until this returns something.
 */
export function readCredentialRequest(
  args: unknown,
): CredentialRequest | undefined {
  const authConfig = asObject(
    pick(asObject(args), "authConfig", "auth_config"),
  );
  if (!authConfig) return undefined;

  const authUri = pick(oauth2Of(authConfig), "authUri", "auth_uri");
  if (typeof authUri !== "string" || !authUri) return undefined;

  let url: URL;
  try {
    url = new URL(authUri);
  } catch {
    return undefined;
  }
  // Only somewhere a person can actually sign in. A javascript: or data: "URL" is not that.
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  return {
    authConfig,
    authorizationUrl: url.toString(),
    state: url.searchParams.get("state") ?? undefined,
    provider: url.hostname,
    scopes: readScopes(authConfig),
  };
}

/**
 * What the request asks to reach, pulled from wherever the auth scheme keeps it.
 *
 * OAuth2 schemes name scopes per flow as `{scope: description}`; OpenID Connect configs carry a
 * plain list. Both appear in the wild, so both are read, and an empty answer just means the card
 * shows none rather than guessing.
 */
function readScopes(authConfig: Json): string[] {
  const scheme = asObject(pick(authConfig, "authScheme", "auth_scheme"));
  const found: string[] = [];

  const flows = asObject(scheme?.flows);
  for (const flowName of [
    "authorizationCode",
    "authorization_code",
    "implicit",
    "password",
    "clientCredentials",
    "client_credentials",
  ]) {
    const scopes = asObject(asObject(flows?.[flowName])?.scopes);
    if (scopes) found.push(...Object.keys(scopes));
  }

  const listed = scheme?.scopes;
  if (Array.isArray(listed)) {
    found.push(
      ...listed.filter((scope): scope is string => typeof scope === "string"),
    );
  }

  return [...new Set(found)];
}

/**
 * The URL the person is sent to, with our callback as the redirect.
 *
 * The agent's URL usually has no `redirect_uri` because the agent cannot know where its client
 * lives; when it names one anyway it is replaced, because the provider will only ever redirect a
 * browser of ours to an address of ours.
 */
export function consentUrl(
  request: CredentialRequest,
  redirectUri: string,
): string {
  const url = new URL(request.authorizationUrl);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

/**
 * Whether a callback URL answers this request, decided by the `state` the agent minted.
 *
 * Two consent cards can wait at once, and both hear every message the callback page posts. The
 * state is the correlation the OAuth flow already carries, so it is the one used here too. A
 * request without state accepts any callback: there is nothing to compare, and refusing would
 * strand the person who just signed in.
 */
export function callbackMatches(
  callbackUrl: string,
  state: string | undefined,
): boolean {
  if (state === undefined) return true;
  try {
    return new URL(callbackUrl).searchParams.get("state") === state;
  } catch {
    return false;
  }
}

/**
 * The tool result that says yes: the config as it arrived, plus where the provider sent the
 * browser back. Written in the sender's own spelling so its parser recognizes its own model, and
 * into a copy, because the original is render state.
 */
export function completedAuthConfig(
  authConfig: Json,
  callbackUrl: string,
  redirectUri: string,
): Json {
  const completed = structuredClone(authConfig);

  const exchangedKey =
    "exchanged_auth_credential" in completed &&
    !("exchangedAuthCredential" in completed)
      ? "exchanged_auth_credential"
      : "exchangedAuthCredential";
  let exchanged = asObject(completed[exchangedKey]);
  if (!exchanged) {
    exchanged = {};
    completed[exchangedKey] = exchanged;
  }
  let oauth2 = asObject(exchanged.oauth2);
  if (!oauth2) {
    oauth2 = {};
    exchanged.oauth2 = oauth2;
  }

  const snake = "auth_uri" in oauth2 && !("authUri" in oauth2);
  oauth2[snake ? "auth_response_uri" : "authResponseUri"] = callbackUrl;
  oauth2[snake ? "redirect_uri" : "redirectUri"] = redirectUri;

  return completed;
}

/**
 * What a completed card should say, recovered from the serialized tool result.
 *
 * A result carrying an answer URL was a sign-in; the same config echoed without one was a decline.
 * Anything unreadable gets no badge rather than a wrong one.
 */
export function readConnectionOutcome(
  result: string | undefined,
): "connected" | "declined" | undefined {
  if (!result) return undefined;
  try {
    const parsed = asObject(JSON.parse(result));
    if (!parsed) return undefined;
    const answer = pick(
      oauth2Of(parsed),
      "authResponseUri",
      "auth_response_uri",
    );
    return typeof answer === "string" && answer ? "connected" : "declined";
  } catch {
    return undefined;
  }
}
