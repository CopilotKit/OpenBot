import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { createEnterpriseStore } from "../admin/settings-store";
import {
  type AuthConfig,
  type MicrosoftAuthConfig,
  namesNoDirectory,
} from "../config";
import type { Database } from "../db/client";
import { OAUTH_REQUEST_TIMEOUT_MS } from "../timeouts";
import { emailDomainAllowed } from "./email-domain";
import { type EntraRefusal, EntraTokenRefusedError } from "./entra-refusal";
import type { AuthService } from "./guards";
import { type createAuth, decideSignInMethod } from "./index";

/**
 * Microsoft Entra on both sides of OpenBot: a person's own app calling OpenBot with their Entra
 * token, and OpenBot calling a company's Entra-protected system as that person.
 *
 * INBOUND. An app that signed somebody in with Entra asks for a token to OpenBot's own API
 * (`MICROSOFT_OAUTH_API_SCOPE`) and sends it as `Authorization: Bearer`. It is checked against the
 * directory's published keys, its issuer, its audience and its expiry, and the request then runs as
 * that person exactly as a signed-in browser does. Somebody OpenBot has not seen before is signed in
 * the way the sign-in screen signs them in, through Better Auth's own Microsoft provider, so the
 * admission, domain and deny rules and the user it creates are the ones every sign-in gets.
 *
 * DOWNSTREAM. A server an admin marked as reached as the signed-in person is called with a token
 * Entra issues for that person through the on-behalf-of exchange (`requested_token_use=on_behalf_of`)
 * with the system's own scope. The assertion is a token to OpenBot's API for the same person: the one
 * their app sent, while it lasts, or one minted from their stored Microsoft sign-in, which is what
 * lets a routine or a check-in nobody is watching reach the system as them. Either way the system
 * sees the real person, with only their access.
 *
 * WHY THE TOKEN ENDPOINT DIRECTLY AND NOT MSAL. MSAL Node keeps its own token cache and never hands
 * a refresh token back, so a rotated one could not be stored back into Better Auth's encrypted row,
 * where the sign-in that minted it keeps it. The two grants are each one form post, written below as
 * Microsoft documents them.
 */

/** Microsoft's global cloud, where every directory's keys and token endpoint live. */
const AUTHORITY = "https://login.microsoftonline.com";

/** A token this close to expiring is not reused, so no call goes out on one that lapses on the way. */
const REUSE_MARGIN_MS = 5 * 60_000;

/** A token from a person's app is used as the assertion only while it has at least this long left. */
const ASSERTION_MARGIN_MS = 60_000;

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

type Session = {
  user: {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
  };
};

type Minted = { token: string; expiresAt: number; refreshToken?: string };

/** `api://hr-api/.default` gives `api://hr-api`: the resource a scope names, and its tokens' audience. */
function resourceOf(scope: string): string {
  const slash = scope.lastIndexOf("/");
  return slash > "api://".length ? scope.slice(0, slash) : scope;
}

/** A bearer token shaped like a JWT, or nothing. Other bearer tokens here are not Entra's to read. */
function bearerJwt(headers: Headers): string | null {
  const match = headers
    .get("authorization")
    ?.match(/^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i);
  return match?.[1] ?? null;
}

export function createEntra(options: {
  microsoft: MicrosoftAuthConfig;
  authConfig: AuthConfig;
  auth: ReturnType<typeof createAuth>;
  database: Database;
  isRevoked?: (email: string) => Promise<boolean>;
}) {
  const { microsoft, authConfig, auth } = options;
  const enterprise = createEnterpriseStore(options.database);
  const tenant = microsoft.tenantId;

  /*
   * Only a deployment that names its directory takes tokens from apps.
   *
   * The issuer is how a token says which directory vouches for the person, and `common`,
   * `organizations` and `consumers` name none, so there would be nothing to check it against. The
   * downstream exchange still works on such a deployment, from each person's stored sign-in.
   */
  const acceptsInbound = !namesNoDirectory(tenant);
  const issuer = `${AUTHORITY}/${tenant}/v2.0`;
  const audiences = [microsoft.clientId, resourceOf(microsoft.apiScope)];
  const keys = createRemoteJWKSet(
    new URL(`${AUTHORITY}/${tenant}/discovery/v2.0/keys`),
  );

  /** The tokens people's apps sent, by person, kept so their run's calls can be exchanged on them. */
  const inbound = new Map<string, { token: string; expiresAt: number }>();
  /** Tokens Entra issued, by person and scope, until shortly before they expire. */
  const issued = new Map<string, { token: string; expiresAt: number }>();
  /** One request to Entra at a time per person and scope, so a burst of calls shares one token. */
  const pending = new Map<string, Promise<string>>();
  /** Tokens verified here and being signed in with right now; see `vouchesForMicrosoftToken`. */
  const vouched = new Set<string>();

  /*
   * Better Auth's own context, as its token helpers take it. Typed by the helper rather than by this
   * instance: the instance's options are narrower than the general shape the helpers accept, and
   * TypeScript cannot see that one is the other.
   */
  async function context() {
    return (await auth.$context) as unknown as Parameters<
      typeof decryptOAuthToken
    >[1];
  }

  /**
   * The rules every sign-in is held to, asked again on every request a token arrives with.
   *
   * A browser's session is checked once, when it is created, and ended when the person is removed.
   * A token has no session for a removal to end, so the same three questions are asked of each
   * request instead: whether SSO is required, whether the address's domain is admitted, and whether
   * an admin removed the person.
   */
  async function admits(email: string): Promise<boolean> {
    const verdict = await decideSignInMethod({
      method: "oauth",
      email,
      ssoRequired: async () => (await enterprise.settings()).ssoRequired,
      initialAdminEmails: authConfig.initialAdminEmails,
    });
    if (verdict === "refuse") return false;
    if (!emailDomainAllowed(email, authConfig.allowedEmailDomains))
      return false;
    return !(await options.isRevoked?.(email));
  }

  /** The person a Microsoft account belongs to, looked up by the key Better Auth signs them in by. */
  async function owner(claims: { iss: string; oid: string }) {
    const found = await (await context()).internalAdapter.findAccountOwnerByKey(
      {
        issuer: claims.iss,
        accountId: claims.oid,
      },
    );
    return found?.kind === "owned" ? found.user : null;
  }

  async function sessionFrom(headers: Headers): Promise<Session | null> {
    const token = acceptsInbound ? bearerJwt(headers) : null;
    if (!token) return null;
    /*
     * Read unverified first, only to see whose it claims to be. A bearer token of some other kind
     * that happens to be a JWT is not Entra's, and never sends this to fetch Microsoft's keys.
     */
    try {
      if (decodeJwt(token).iss !== issuer) return null;
    } catch {
      return null;
    }

    let claims: { iss: string; oid: string; exp: number };
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience: audiences,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "oid", "scp"],
      });
      /*
       * `scp` is what makes it a person's token: the scopes they consented to. An app's own token,
       * from the client credentials grant, carries roles instead and has no person to run as.
       */
      if (typeof payload.oid !== "string" || typeof payload.scp !== "string")
        return null;
      claims = { iss: issuer, oid: payload.oid, exp: payload.exp as number };
    } catch {
      return null;
    }

    let user = await owner(claims);
    if (user) {
      if (!(await admits(user.email))) return null;
    } else {
      /*
       * Somebody OpenBot has not seen before, signed in by Better Auth's own Microsoft provider from
       * this token, as the sign-in screen does with the one Entra hands a browser. Everything a
       * sign-in decides is decided there, by the same hooks: SSO, the domain list, the deny list,
       * the user row and its role. A refusal is a request with nobody signed in.
       */
      vouched.add(token);
      try {
        await auth.api.signInSocial({
          body: { provider: "microsoft", idToken: { token } },
        });
      } catch (error) {
        console.warn(
          JSON.stringify({
            type: "entra-token-sign-in-refused",
            note: "A valid Entra token arrived for somebody OpenBot has not seen, and signing them in was refused.",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return null;
      } finally {
        vouched.delete(token);
      }
      user = await owner(claims);
      if (!user) return null;
    }

    inbound.set(user.id, { token, expiresAt: claims.exp * 1_000 });
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image ?? null,
      },
    };
  }

  /** One token from the directory's token endpoint, or the refusal that says why not. */
  async function requestToken(
    directory: string,
    params: Record<string, string>,
    step: "sign-in" | "on-behalf-of",
  ): Promise<Minted> {
    const response = await fetch(
      `${AUTHORITY}/${encodeURIComponent(directory)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: microsoft.clientId,
          client_secret: microsoft.clientSecret,
          ...params,
        }),
        // The body carries the client secret and somebody's token; a redirect is a refusal.
        redirect: "manual",
        signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
      error_codes?: unknown;
      suberror?: unknown;
    } | null;

    if (!response.ok) {
      const error = typeof body?.error === "string" ? body.error : null;
      const codes = Array.isArray(body?.error_codes) ? body.error_codes : [];
      // The codes reach the operator; the description and its trace ids stay with Microsoft.
      console.warn(
        JSON.stringify({
          type: "entra-token-refused",
          step,
          status: response.status,
          error,
          errorCodes: codes,
          suberror: typeof body?.suberror === "string" ? body.suberror : null,
        }),
      );
      const reason: EntraRefusal =
        codes.includes(65001) || body?.suberror === "consent_required"
          ? "no-consent"
          : step === "sign-in" &&
              (codes.includes(500011) || error === "invalid_resource")
            ? "no-api"
            : error === "invalid_grant" || error === "interaction_required"
              ? "sign-in-expired"
              : "refused";
      throw new EntraTokenRefusedError(
        reason,
        `Microsoft would not issue the token (${response.status}${error ? `, ${error}` : ""}).`,
      );
    }
    if (typeof body?.access_token !== "string" || !body.access_token) {
      throw new EntraTokenRefusedError(
        "refused",
        "Microsoft answered with no token.",
      );
    }
    return {
      token: body.access_token,
      expiresAt:
        Date.now() +
        (typeof body.expires_in === "number" ? body.expires_in : 3_600) * 1_000,
      ...(typeof body.refresh_token === "string" && body.refresh_token
        ? { refreshToken: body.refresh_token }
        : {}),
    };
  }

  /** A token from `issued`, or a new one from `mint`, shared by every call that asks meanwhile. */
  async function reused(
    key: string,
    mint: () => Promise<Minted>,
  ): Promise<string> {
    const held = issued.get(key);
    if (held && held.expiresAt - REUSE_MARGIN_MS > Date.now())
      return held.token;
    const waiting = pending.get(key);
    if (waiting) return await waiting;
    const minting = mint().then(({ token, expiresAt }) => {
      issued.set(key, { token, expiresAt });
      return token;
    });
    pending.set(key, minting);
    try {
      return await minting;
    } finally {
      pending.delete(key);
    }
  }

  /**
   * A token to OpenBot's own API for this person: what the on-behalf-of exchange takes as its
   * assertion.
   *
   * The token their app sent comes first, because that is the token this request arrived on. With
   * none, or one about to lapse, it is minted from their stored Microsoft sign-in with the refresh
   * grant, read and written through Better Auth so the row stays encrypted the way Better Auth wrote
   * it. Entra rotates the refresh token as it goes, and the new one is stored back.
   */
  async function assertionFor(userId: string): Promise<string> {
    const sent = inbound.get(userId);
    if (sent && sent.expiresAt - ASSERTION_MARGIN_MS > Date.now())
      return sent.token;

    return await reused(`${userId}\n${microsoft.apiScope}`, async () => {
      const ctx = await context();
      const account = (await ctx.internalAdapter.findAccounts(userId))
        .filter((row) => row.providerId === "microsoft" && row.refreshToken)
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
      if (!account?.refreshToken) {
        throw new EntraTokenRefusedError(
          "no-sign-in",
          "This person has no Microsoft sign-in stored.",
        );
      }
      const refreshToken = await decryptOAuthToken(account.refreshToken, ctx);
      const minted = await requestToken(
        tenant,
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: microsoft.apiScope,
        },
        "sign-in",
      );
      if (minted.refreshToken && minted.refreshToken !== refreshToken) {
        await ctx.internalAdapter.updateAccount(account.id, {
          refreshToken: await setTokenUtil(minted.refreshToken, ctx),
        });
      }
      return minted;
    });
  }

  async function tokenFor(userId: string, scope: string): Promise<string> {
    return await reused(`${userId}\n${scope}`, async () => {
      const assertion = await assertionFor(userId);
      /*
       * At the person's own directory, which the assertion names. On a deployment that names its
       * directory that is the same one; on a multi-tenant one it is the person's, where the system's
       * consent was granted.
       */
      const { tid } = decodeJwt(assertion);
      return await requestToken(
        typeof tid === "string" && tid ? tid : tenant,
        {
          grant_type: JWT_BEARER,
          assertion,
          scope,
          requested_token_use: "on_behalf_of",
        },
        "on-behalf-of",
      );
    });
  }

  return {
    sessionFrom,
    tokenFor,
    vouches: (token: string) => vouched.has(token),
  };
}

/**
 * The deployment's sign-in, answering a request that carries a person's Entra token as that person.
 *
 * Only `getSession` changes, and only when the token checks out: every other request, and every
 * other route Better Auth serves, is exactly what it was.
 */
export function withEntraBearer(
  auth: AuthService,
  entra: Pick<ReturnType<typeof createEntra>, "sessionFrom">,
): AuthService {
  return {
    handler: (request) => auth.handler(request),
    api: {
      getSession: async (input) =>
        (await entra.sessionFrom(input.headers)) ??
        (await auth.api.getSession(input)),
    },
  };
}
