import { z } from "zod";
import { seal, unseal } from "../auth/signed-value";

/**
 * Signing a person in with the deployment's GitHub App.
 *
 * Four steps: build the authorize URL, remember who started it in a sealed state, trade the code
 * for tokens, and ask GitHub who the token belongs to. Every failure is a `GithubOAuthError` with a
 * fixed message: the vendor's body, the code, the tokens and the client secret never appear in one.
 */

export const GITHUB_CALLBACK_PATH = "/api/identity/github/callback";

const STATE_LABEL = "identity-github-connect";
const STATE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

export class GithubOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubOAuthError";
  }
}

export function githubRedirectUri(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${GITHUB_CALLBACK_PATH}`;
}

const stateSchema = z.object({
  userId: z.string().min(1),
  issuedAt: z.iso.datetime(),
});

export async function sealGithubState(
  userId: string,
  encryptionKey: string,
  now = new Date(),
): Promise<string> {
  return seal(
    JSON.stringify({ userId, issuedAt: now.toISOString() }),
    encryptionKey,
    STATE_LABEL,
  );
}

/** The person a state was issued to, or nothing for every way of being unusable. */
export async function openGithubState(
  sealed: string | undefined,
  encryptionKey: string,
  now = new Date(),
): Promise<{ userId: string } | null> {
  const value = await unseal(sealed, encryptionKey, STATE_LABEL);
  if (!value) return null;

  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return null;
  }

  const parsed = stateSchema.safeParse(json);
  if (!parsed.success) return null;

  const age = now.getTime() - new Date(parsed.data.issuedAt).getTime();
  if (age < 0 || age > STATE_TTL_MS) return null;

  return { userId: parsed.data.userId };
}

/** No scope: a GitHub App's permissions come from its installation, not from the request. */
export function githubAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export type GithubTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  refreshTokenExpiresAt: string | null;
};

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  refresh_token_expires_in: z.number().positive().optional(),
});

function secondsFrom(now: Date, seconds: number | undefined): string | null {
  return seconds === undefined
    ? null
    : new Date(now.getTime() + seconds * 1000).toISOString();
}

export async function exchangeGithubCode(
  input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<GithubTokens> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
      // The request carries a client secret and a code; a redirect is a refusal, not a detour.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GithubOAuthError("GitHub could not be reached");
  }

  if (!response.ok) {
    throw new GithubOAuthError("GitHub refused the authorization code");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GithubOAuthError("GitHub returned an unreadable response");
  }

  // GitHub reports a bad code as a 200 with an `error` field, so no access_token is the refusal.
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new GithubOAuthError("GitHub did not return an access token");
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: secondsFrom(now, parsed.data.expires_in),
    refreshTokenExpiresAt: secondsFrom(
      now,
      parsed.data.refresh_token_expires_in,
    ),
  };
}

const userSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(39),
});

export async function fetchGithubUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; login: string }> {
  let response: Response;
  try {
    response = await fetchImpl(USER_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GithubOAuthError("GitHub could not be reached");
  }

  if (!response.ok) {
    throw new GithubOAuthError("GitHub refused to identify the account");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GithubOAuthError("GitHub returned an unreadable response");
  }

  const parsed = userSchema.safeParse(body);
  if (!parsed.success) {
    throw new GithubOAuthError("GitHub returned an unexpected account");
  }
  return { id: parsed.data.id, login: parsed.data.login };
}
