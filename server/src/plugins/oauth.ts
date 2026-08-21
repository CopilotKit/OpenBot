import { createHash, randomBytes } from "node:crypto";
import { sign, verify } from "../auth/signed-value";
import type { CatalogueAuth } from "./catalogue";

/**
 * The connect flow: sending a person to a vendor to consent, and believing what comes back.
 *
 * The browser is in the middle of this, which is the whole difficulty. An authorization code arrives
 * on a request that somebody else's server sent the person to, so nothing on it can be believed on
 * its own — not who is connecting, not which server they meant, not that they ever asked. Two things
 * carry the truth across: a signed state, which is this deployment's own statement about the request
 * it started, and a PKCE verifier, which proves the code being redeemed belongs to that request.
 *
 * Everything here fails closed. A state that was tampered with, replayed after it expired, or minted
 * for some other purpose reads back as nothing, because the alternative is attaching one person's
 * Google account to another person's row.
 */

/**
 * The label this deployment's connect states are signed under.
 *
 * Its own, so a signature valid here can never be replayed as a run assertion and vice versa. Every
 * signed value the deployment hands out would otherwise be a candidate state.
 */
const CONNECT_LABEL = "mcp-oauth-connect";

/**
 * How long somebody has to finish consenting.
 *
 * Long enough to read a consent screen and pick an account, short enough that a link left in a tab
 * overnight is not still redeemable. The state carries no permission by itself, but it does say who
 * the resulting grant gets attached to, which is worth keeping fresh.
 */
const STATE_TTL_MS = 10 * 60_000;

/** The one path a vendor is ever told to send somebody back to. */
const CALLBACK_PATH = "/api/plugins/oauth/callback";

export type ConnectState = {
  /** Who is connecting. Taken from their session when the flow starts, never from the callback. */
  userId: string;
  /** Which server they are connecting. Prevents a code for one vendor landing on another's row. */
  serverId: string;
  /** The PKCE verifier, held here rather than in a table because it is single-use and short-lived. */
  verifier: string;
};

type SignedState = ConnectState & { exp: number };

/**
 * Where the vendor sends somebody back to.
 *
 * Built from the deployment's own public URL rather than from the incoming request, because this
 * value has to match what an administrator registered with the vendor character for character. A
 * redirect URI assembled from a request header is a redirect URI an attacker has a say in.
 */
export function redirectUriFor(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

/**
 * Where the callback sends somebody when it is done, succeeded or failed.
 *
 * Absolute, on the app's origin, because the callback lands on the API and those are two different
 * addresses: locally the app is Vite on one port and this server is another. A relative redirect
 * resolves against this server, which serves no pages, so the flow would complete correctly — grant
 * stored, everything right — and drop the person on a 404. Nothing about that reads as a connect
 * failure, which is what makes it worth naming.
 *
 * Relative is still correct for a deployment that serves both from one origin, which is the only
 * case where `appUrl` is absent and the deployment works.
 */
export function settingsUrlFor(
  appUrl: string | undefined,
  outcome?: string,
): string {
  /*
   * The screen that started the flow, which is a person's own connected accounts rather than their
   * preferences. It moved there when a connector became more than one switch's worth of decision, and
   * this had to move with it: landing somebody back on a page that no longer mentions what they just
   * did is its own kind of failure, and a silent one.
   */
  const base = `${appUrl?.replace(/\/+$/, "") ?? ""}/settings/connected-accounts`;
  return outcome ? `${base}?connected=${outcome}` : base;
}

/** A fresh PKCE verifier: unreserved characters only, comfortably over the 43-character floor. */
export function createVerifier(): string {
  return randomBytes(48).toString("base64url");
}

/** The S256 challenge for a verifier. Never `plain`, which would make the challenge worthless. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function signConnectState(
  state: ConnectState,
  encryptionKey: string,
  now: number = Date.now(),
): string {
  const payload: SignedState = { ...state, exp: now + STATE_TTL_MS };
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return sign(value, encryptionKey, CONNECT_LABEL);
}

/**
 * What a state says, or nothing at all.
 *
 * One return for every way of being unacceptable — bad signature, wrong label, expired, malformed,
 * missing a field — because a caller that has to tell those apart is a caller that can get one of
 * them wrong. There is exactly one thing to do with an unusable state, so there is one answer.
 */
export function readConnectState(
  signed: string,
  encryptionKey: string,
  now: number = Date.now(),
): ConnectState | null {
  const value = verify(signed, encryptionKey, CONNECT_LABEL);
  if (!value) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<SignedState>;

    if (
      typeof payload.userId !== "string" ||
      !payload.userId ||
      typeof payload.serverId !== "string" ||
      !payload.serverId ||
      typeof payload.verifier !== "string" ||
      !payload.verifier ||
      typeof payload.exp !== "number" ||
      payload.exp <= now
    ) {
      return null;
    }

    return {
      userId: payload.userId,
      serverId: payload.serverId,
      verifier: payload.verifier,
    };
  } catch {
    return null;
  }
}

/**
 * The vendor's consent screen, as a URL to send somebody to.
 *
 * `offline` and `consent` are both load bearing. Without `access_type=offline` Google returns an
 * access token and no refresh token, so the connection would appear to work and then stop about an
 * hour later with nothing to renew it. Without `prompt=consent` a second connect returns no refresh
 * token at all, because the person already agreed once — which turns reconnecting after a disconnect
 * into a silent no-op.
 */
export function authorizationUrlFor(input: {
  auth: Extract<CatalogueAuth, { kind: "user-oauth" }>;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.auth.authorizationUrl);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.auth.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export type RedeemedGrant = {
  refreshToken: string;
  /** What the vendor actually granted, which is not always what was asked for. */
  scope: string;
};

/**
 * Trade an authorization code for the refresh token that stands in for somebody's access.
 *
 * A refusal rather than an exception when the vendor declines, because the most likely causes are
 * ordinary: a redirect URI that does not match what was registered, or somebody taking too long. The
 * vendor's own error body is not passed through — it is written for whoever registered the client and
 * can name the client id.
 */
export async function redeemAuthorizationCode(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<RedeemedGrant | null> {
  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return null;

  const body = (await response.json()) as {
    refresh_token?: unknown;
    scope?: unknown;
  };
  /*
   * No refresh token is a failure, not a partial success.
   *
   * It is what a vendor returns when it believes this person already consented, and storing the
   * access token instead would produce a connection that works for an hour and then cannot be
   * renewed — the worst of the three outcomes, because it looks like success.
   */
  if (typeof body.refresh_token !== "string" || !body.refresh_token) {
    return null;
  }

  return {
    refreshToken: body.refresh_token,
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}
