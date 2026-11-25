/**
 * Signing the phone in to OpenBot: OAuth 2.1 authorization code with PKCE (S256), as the public client `openbot-mobile`
 * the server keeps for this app (the back end's auth/oauth.ts). It is the one way in that works on every OpenBot: on
 * OpenBot Cloud the authorization page sends the person through OpenBot by CopilotKit, and a self-hosted OpenBot shows
 * its own sign-in. A cookie session can't come back to the app from a hosted sign-in, so the app holds tokens instead.
 *
 * The phone opens the authorization endpoint in the system browser's sign-in session, and the browser returns to
 * {@link REDIRECT_URI} with a code. The app exchanges the code and its verifier for an access token that lasts an hour
 * and a refresh token that rotates on every use. The server accepts the custom scheme only where it runs the app
 * (EXPO_PROJECT_ID); PKCE is what makes a code caught by another app worthless.
 *
 * This file is only the protocol: what to ask, and how to read the answers. It imports nothing that needs a phone, so
 * it can be tested. ./auth.ts drives it with the phone's browser, crypto and secure store.
 */

/** The client the server keeps for this app. */
export const CLIENT_ID = "openbot-mobile";

/** Where the browser comes back to. The server names exactly this address for {@link CLIENT_ID}. */
export const REDIRECT_URI = "openbotmobile://oauth/callback";

/** Where the authorization server's metadata is, under the server's address (RFC 8414, Better Auth's base). */
export const METADATA_PATH = "/.well-known/oauth-authorization-server/api/auth";

/** The scope that gives a refresh token. Without it the person would sign in again every hour. */
export const OFFLINE_ACCESS = "offline_access";

/** What the app needs from the metadata. */
export type Metadata = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  /** A hosted OpenBot's sign-out page, which signs the browser out of OpenBot by CopilotKit too. */
  endSessionEndpoint?: string;
  issuer?: string;
  /** Every scope the server lists: the app's screens use the whole API, so all of them are asked for. */
  scopes: string[];
};

/** What a token answer gives. `refreshToken` is absent when the server kept the one it was given. */
export type Grant = {
  accessToken: string;
  refreshToken?: string;
  /** Seconds. */
  expiresIn: number;
};

/** A sign-in that did not finish, in the words the person is shown. */
export class SignInError extends Error {
  constructor(
    message: string,
    /** The OAuth error code, when the server gave one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

/** The sentence for a server too old to sign the app in this way. */
export const SERVER_TOO_OLD =
  "You can't sign in to this OpenBot from OpenBot Mobile yet. Ask an admin to update OpenBot.";

/** An address the app may send the person or a token to: https, or http only in a development build. */
function usable(value: unknown, development: boolean): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    return (
      url.protocol === "https:" || (development && url.protocol === "http:")
    );
  } catch {
    return false;
  }
}

/** The metadata as the server answered it, or why it can't be used. */
export function readMetadata(body: unknown, development = false): Metadata {
  if (!body || typeof body !== "object") throw new SignInError(SERVER_TOO_OLD);
  const document = body as Record<string, unknown>;
  const {
    authorization_endpoint: authorization,
    token_endpoint: token,
    revocation_endpoint: revocation,
    end_session_endpoint: endSession,
    issuer,
    scopes_supported: scopes,
    code_challenge_methods_supported: methods,
  } = document;
  if (!usable(authorization, development) || !usable(token, development))
    throw new SignInError(SERVER_TOO_OLD);
  const listed = Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  if (!listed.includes(OFFLINE_ACCESS)) throw new SignInError(SERVER_TOO_OLD);
  if (!Array.isArray(methods) || !methods.includes("S256"))
    throw new SignInError(SERVER_TOO_OLD);
  return {
    authorizationEndpoint: authorization,
    tokenEndpoint: token,
    ...(usable(revocation, development)
      ? { revocationEndpoint: revocation }
      : {}),
    ...(usable(endSession, development)
      ? { endSessionEndpoint: endSession }
      : {}),
    ...(typeof issuer === "string" ? { issuer } : {}),
    scopes: listed,
  };
}

/** Bytes as base64url without padding (RFC 7636's encoding of the verifier and the challenge). */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Standard base64 (what expo-crypto's digest answers) as base64url without padding. */
export function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The address the browser opens to sign in. */
export function authorizationUrl(
  metadata: Metadata,
  { state, challenge }: { state: string; challenge: string },
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", metadata.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

/** The sentence for an OAuth error the authorization endpoint sent back. */
function refusedSentence(code: string): string {
  if (code === "access_denied") return "Sign-in was cancelled.";
  if (code === "invalid_redirect" || code === "invalid_client")
    return "OpenBot Mobile isn't turned on for this OpenBot yet. Ask an admin to turn it on.";
  return "Sign-in didn't finish. Try again.";
}

/**
 * The code in the address the browser came back to. Anything that is not this sign-in's answer is refused: another
 * address, another `state`, or another issuer where the server names one (RFC 9207).
 */
export function readCallback(
  returned: string,
  { state, issuer }: { state: string; issuer?: string },
): string {
  let url: URL;
  try {
    url = new URL(returned);
  } catch {
    throw new SignInError("Sign-in didn't finish. Try again.");
  }
  const expected = new URL(REDIRECT_URI);
  if (
    url.protocol !== expected.protocol ||
    url.host !== expected.host ||
    url.pathname !== expected.pathname
  )
    throw new SignInError("Sign-in didn't finish. Try again.");
  const params = url.searchParams;
  if (params.get("state") !== state)
    throw new SignInError("Sign-in didn't finish. Try again.");
  const iss = params.get("iss");
  if (issuer && iss && iss !== issuer)
    throw new SignInError("Sign-in didn't finish. Try again.");
  const error = params.get("error");
  if (error) throw new SignInError(refusedSentence(error), error);
  const code = params.get("code");
  if (!code) throw new SignInError("Sign-in didn't finish. Try again.");
  return code;
}

/** The form a token request sends to exchange the code. */
export function codeExchange(code: string, verifier: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
}

/** The form a token request sends to replace the access token. */
export function refreshExchange(refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
}

/** A token answer, or why it can't be used. */
export function readGrant(body: unknown): Grant {
  if (!body || typeof body !== "object")
    throw new SignInError("Sign-in didn't finish. Try again.");
  const answer = body as Record<string, unknown>;
  const {
    access_token: access,
    refresh_token: refresh,
    expires_in: expires,
  } = answer;
  if (typeof access !== "string" || !access)
    throw new SignInError("Sign-in didn't finish. Try again.");
  return {
    accessToken: access,
    ...(typeof refresh === "string" && refresh
      ? { refreshToken: refresh }
      : {}),
    expiresIn:
      typeof expires === "number" && Number.isFinite(expires) && expires > 0
        ? expires
        : 3600,
  };
}

/**
 * Whether a refused token request means the sign-in is over (the refresh token was revoked, used twice, or its owner
 * removed), as opposed to the server being unreachable or failing for a while, when the sign-in may still be good.
 */
export function signInEnded(status: number): boolean {
  return status >= 400 && status < 500;
}
