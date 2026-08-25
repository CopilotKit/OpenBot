import { createHash, randomBytes } from "node:crypto";
import { seal, unseal } from "../auth/signed-value";
import type { CatalogueAuth } from "./catalogue";

/**
 * The connect flow: sending a person to a vendor to consent, and believing what comes back.
 *
 * The browser is in the middle of this, which is the whole difficulty. An authorization code arrives
 * on a request that somebody else's server sent the person to, so nothing on it can be believed on
 * its own — not who is connecting, not which server they meant, not that they ever asked. Two things
 * carry the truth across: a sealed state, which is this deployment's own statement about the request
 * it started, and a PKCE verifier, which proves the code being redeemed belongs to that request.
 *
 * SEALED, not signed, and that distinction is the reason this comment exists. The state carries the
 * PKCE verifier, and the callback URL carries the verifier's state and the authorization code
 * TOGETHER. A dynamically registered client is public — it proves itself with PKCE and no secret —
 * so the verifier is the only thing binding that code to this deployment. A signed state is readable
 * by anybody holding it, and a callback URL is held by every CDN log, proxy log, browser history and
 * vendor log it passes through: any one of those readers could redeem the code. Encrypted, the state
 * says nothing to anybody but this deployment.
 *
 * Everything here fails closed. A state that was tampered with, replayed after it expired, or minted
 * for some other purpose reads back as nothing, because the alternative is attaching one person's
 * Google account to another person's row.
 */

/**
 * The label this deployment's connect states are sealed under.
 *
 * Its own, so a state cannot be opened as a run assertion and vice versa. Every value the deployment
 * hands out under this key would otherwise be a candidate state.
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

/**
 * Which screen started this, so somebody is returned to the one they left.
 *
 * A closed set of two names, never a URL, and that is the security point rather than a style choice.
 * Carrying a destination through an OAuth flow is how open redirects get built: a
 * `returnTo=https://evil.test` the callback honours turns this deployment into a redirector that
 * arrives with a fresh consent behind it. A name cannot express another origin, and an unrecognised
 * one falls back instead of being followed, so the worst a tampered state achieves is the wrong page
 * of this app.
 *
 * It lives in the SEALED state rather than on the callback URL because the callback is a request
 * somebody else's server sent the browser on. Nothing on it is believable by itself.
 */
export type ConnectOrigin = "settings" | "admin";

export type ConnectState = {
  /** Who is connecting. Taken from their session when the flow starts, never from the callback. */
  userId: string;
  /** Which server they are connecting. Prevents a code for one vendor landing on another's row. */
  serverId: string;
  /**
   * The PKCE verifier, held here rather than in a table because it is single-use and short-lived.
   *
   * It is also why the state is sealed rather than signed: this is a secret travelling beside the
   * code it unlocks, so a state anybody could read would be a code anybody could redeem.
   */
  verifier: string;
  /** Where to go back to. Absent reads as `settings`, which is where every flow used to end. */
  returnTo?: ConnectOrigin;
};

/**
 * What is actually sealed: the state, plus when it stops being one.
 *
 * The expiry travels inside the sealed value because sealing says nothing about freshness. Nobody
 * can move it without the key, and this deployment checks it on the way out.
 */
type SealedState = ConnectState & { exp: number };

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
export function connectedAccountsUrlFor(
  appUrl: string | undefined,
  where: { serverId: string } | { failed: true },
  /**
   * Which screen to go back to.
   *
   * An administrator can start this from the connector's own setup page, and sending them to their
   * personal settings afterwards would be the same round trip this was meant to remove — they left a
   * page mid-task and should come back to it. The page they return to shows the same fact either way.
   */
  returnTo: ConnectOrigin = "settings",
): string {
  const origin = appUrl?.replace(/\/+$/, "") ?? "";

  if (returnTo === "admin") {
    /*
     * The admin route takes the server key as its path parameter, so a failure has nowhere generic
     * to land — and a failed state has no key to build one from. Those cases fall through to the
     * settings list below, which is the one screen that draws a failure notice.
     */
    if ("serverId" in where) {
      return `${origin}/admin/plugins/${encodeURIComponent(where.serverId)}`;
    }
  }

  const base = `${origin}/settings/connected-accounts`;

  /*
   * Success returns to the account, not the list.
   *
   * That page is where the flow started and it is the page that can now say something new: the
   * account reads Connected, with the scope the vendor granted beside it. The list would only report
   * the same fact one level further away, leaving somebody to find their way back to check.
   *
   * No query parameter either. "It worked" is already told by the thing it is news about, and a
   * banner saying so next to a row that says so is the same sentence twice.
   */
  if ("serverId" in where) {
    return `${base}/${encodeURIComponent(where.serverId)}`;
  }

  /*
   * Failure goes to the list, which is the one screen that draws the notice.
   *
   * It is also the only honest destination when the state could not be read: with no state there is
   * no server id, so there is no account page to return to — and picking one would be a guess about
   * what somebody had been doing.
   */
  return `${base}?connected=failed`;
}

/** A fresh PKCE verifier: unreserved characters only, comfortably over the 43-character floor. */
export function createVerifier(): string {
  return randomBytes(48).toString("base64url");
}

/** The S256 challenge for a verifier. Never `plain`, which would make the challenge worthless. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * The state to send a person to the vendor with.
 *
 * Async because sealing is: the encryption goes through WebCrypto, like every other secret this
 * deployment writes down. It is one call on a path that already makes a network request or two.
 */
export async function sealConnectState(
  state: ConnectState,
  encryptionKey: string,
  now: number = Date.now(),
): Promise<string> {
  const payload: SealedState = { ...state, exp: now + STATE_TTL_MS };
  return seal(JSON.stringify(payload), encryptionKey, CONNECT_LABEL);
}

/**
 * What a state says, or nothing at all.
 *
 * One return for every way of being unacceptable — altered, sealed by another key, sealed for
 * another purpose, expired, malformed, missing a field — because a caller that has to tell those
 * apart is a caller that can get one of them wrong. There is exactly one thing to do with an
 * unusable state, so there is one answer.
 */
export async function readConnectState(
  sealed: string,
  encryptionKey: string,
  now: number = Date.now(),
): Promise<ConnectState | null> {
  const value = await unseal(sealed, encryptionKey, CONNECT_LABEL);
  if (!value) return null;

  try {
    const payload = JSON.parse(value) as Partial<SealedState>;

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
      // Only the one name is recognised; anything else becomes the default rather than being carried.
      returnTo: payload.returnTo === "admin" ? "admin" : "settings",
    };
  } catch {
    return null;
  }
}

/**
 * The six keys that carry this flow's own security: who is asking (`client_id`), where the vendor
 * answers (`redirect_uri`), the grant shape (`response_type`), the sealed state (`state`), and the
 * PKCE proof (`code_challenge`, `code_challenge_method`). A catalogue entry's `authorizationParams`
 * must never rewrite one of these — an entry setting `code_challenge_method: "plain"` would defeat
 * PKCE with nothing here to catch it. The catalogue is frozen, reviewed code today, so nothing can
 * reach this, but a future entry that tried would fail at first connect rather than quietly winning.
 */
const RESERVED_AUTHORIZATION_PARAMS: ReadonlySet<string> = new Set([
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
]);

/**
 * The vendor's consent screen, as a URL to send somebody to.
 *
 * Vendor-specific parameters — Google's `offline`/`consent` pair, or nothing at all for a vendor
 * like Notion whose consent screen is itself the scoping — come from the catalogue entry's own
 * `authorizationParams`, never hardcoded here. The rationale for any one vendor's requirements lives
 * on that vendor's entry, because a parameter this function adds for everybody is a parameter an
 * unrelated vendor never asked for and may refuse the whole request over.
 */
export function authorizationUrlFor(input: {
  auth: Extract<CatalogueAuth, { kind: "user-oauth" }>;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.auth.authorizationUrl);
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  // Empty means the consent screen itself is the scoping; an empty scope= is not "no scope".
  if (input.auth.scopes.length > 0) {
    params.set("scope", input.auth.scopes.join(" "));
  }
  // The vendor's own requirements, from its reviewed entry — never another vendor's.
  for (const [name, value] of Object.entries(
    input.auth.authorizationParams ?? {},
  )) {
    // Applied last, so a reserved name here would quietly rewrite the flow's own security instead
    // of the vendor's. That is a bad entry, and it must fail at first connect, not win silently.
    if (RESERVED_AUTHORIZATION_PARAMS.has(name)) {
      throw new Error(
        `authorizationParams may not set "${name}": it is one of the flow's own security ` +
          "parameters (client_id, redirect_uri, response_type, state, code_challenge, " +
          "code_challenge_method) and must never be rewritten by a catalogue entry.",
      );
    }
    params.set(name, value);
  }
  url.search = params.toString();
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
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  // A public (DCR) client proves itself with PKCE, and some vendors refuse an unexpected empty field.
  if (input.clientSecret) params.set("client_secret", input.clientSecret);

  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    /*
     * A redirect is a refusal, not a detour to be followed.
     *
     * `tokenUrl` is pinned in the catalogue because this request carries a client secret and an
     * authorization code, and following a 302 would hand both to whatever address the answer named.
     * Manual leaves the 3xx as the response, which is not `ok`, so it falls into the refusal below.
     */
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return null;

  /*
   * Read defensively, because a 200 is not a promise of JSON.
   *
   * A CDN interstitial, a captive portal or a maintenance page answers 200 with HTML, and an
   * unguarded parse would throw a SyntaxError out of a function whose whole contract is to refuse
   * quietly — escaping the callback as a 500 instead of the redirect-with-a-notice a person who has
   * just consented should get, and quoting the vendor's body into whatever logged the throw.
   */
  const body = (await response.json().catch(() => null)) as {
    refresh_token?: unknown;
    scope?: unknown;
  } | null;
  /*
   * No refresh token is a failure, not a partial success.
   *
   * It is what a vendor returns when it believes this person already consented, and storing the
   * access token instead would produce a connection that works for an hour and then cannot be
   * renewed — the worst of the three outcomes, because it looks like success. A body that was not
   * JSON at all arrives here as nothing, which is the same answer: the vendor said something other
   * than a token.
   */
  if (typeof body?.refresh_token !== "string" || !body.refresh_token) {
    return null;
  }

  return {
    refreshToken: body.refresh_token,
    /*
     * Capped where it is read. It is a short string in the protocol and vendor-controlled in fact,
     * and everything downstream shows it to somebody — the connected-accounts page, the
     * `mcp.account_connected` payload, the `scope` column — none of which is a promise about length.
     */
    scope: typeof body.scope === "string" ? body.scope.slice(0, 512) : "",
  };
}

/**
 * Register this deployment as an OAuth client, at the vendor's own registration endpoint.
 *
 * RFC 7591, the shape Notion's hosted MCP expects: a public client (`token_endpoint_auth_method:
 * "none"`) whose proof is PKCE rather than a secret. Null on refusal rather than a throw, for the
 * same reason `redeemAuthorizationCode` refuses quietly: the vendor's error body is written for a
 * developer console and can be surfaced by the caller that knows who is listening.
 */
export async function registerDynamicClient(input: {
  registrationUrl: string;
  redirectUri: string;
}): Promise<{ clientId: string; clientSecret: string } | null> {
  const response = await fetch(input.registrationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: "OpenBot",
    }),
    // The registration endpoint is pinned in the catalogue, so a redirect is somebody else deciding
    // where this deployment introduces itself. Left as the response, which is not `ok`.
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  // A 200 is not a promise of JSON — see `redeemAuthorizationCode`. A body that will not parse is
  // the vendor answering with something other than a client, which is this function's null.
  const body = (await response.json().catch(() => null)) as {
    client_id?: unknown;
    client_secret?: unknown;
  } | null;
  if (typeof body?.client_id !== "string" || !body.client_id) return null;
  return {
    clientId: body.client_id,
    // A public client has none; a vendor that issues one anyway gets it stored and sent back.
    clientSecret:
      typeof body.client_secret === "string" ? body.client_secret : "",
  };
}
