/**
 * Signing the phone in with OAuth (src/oauth.ts): what it asks OpenBot, and how it reads the answers. The metadata is
 * the shape OpenBot Cloud serves at api.open.bot, trimmed to what the app reads.
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  authorizationUrl,
  base64ToBase64Url,
  base64Url,
  CLIENT_ID,
  codeExchange,
  REDIRECT_URI,
  readCallback,
  readGrant,
  readMetadata,
  refreshExchange,
  SERVER_TOO_OLD,
  SignInError,
  signInEnded,
} from "../src/oauth";

const CLOUD = {
  issuer: "https://my.open.bot/api/auth",
  authorization_endpoint: "https://my.open.bot/api/auth/oauth2/authorize",
  token_endpoint: "https://api.open.bot/api/auth/oauth2/token",
  revocation_endpoint: "https://api.open.bot/api/auth/oauth2/revoke",
  end_session_endpoint: "https://my.open.bot/api/auth/hosted/sign-out",
  scopes_supported: ["bots:read", "conversations:write", "offline_access"],
  code_challenge_methods_supported: ["S256"],
};

test("OpenBot Cloud's metadata is read with every scope it lists, its sign-out and its issuer", () => {
  expect(readMetadata(CLOUD)).toEqual({
    authorizationEndpoint: CLOUD.authorization_endpoint,
    tokenEndpoint: CLOUD.token_endpoint,
    revocationEndpoint: CLOUD.revocation_endpoint,
    endSessionEndpoint: CLOUD.end_session_endpoint,
    issuer: CLOUD.issuer,
    scopes: CLOUD.scopes_supported,
  });
});

test("an OpenBot that can't give a refresh token, or PKCE with S256, is too old to sign the app in", () => {
  for (const body of [
    null,
    "<!doctype html>",
    { ...CLOUD, scopes_supported: ["bots:read"] },
    { ...CLOUD, code_challenge_methods_supported: ["plain"] },
    { ...CLOUD, authorization_endpoint: undefined },
  ])
    expect(() => readMetadata(body)).toThrow(SERVER_TOO_OLD);
});

test("an endpoint over plain http is refused, except in a development build", () => {
  const local = {
    ...CLOUD,
    authorization_endpoint:
      "http://192.168.1.20:3000/api/auth/oauth2/authorize",
    token_endpoint: "http://192.168.1.20:3000/api/auth/oauth2/token",
  };
  expect(() => readMetadata(local)).toThrow(SignInError);
  expect(readMetadata(local, true).tokenEndpoint).toBe(local.token_endpoint);
  // A revocation endpoint it can't use is left out, and sign-in still works.
  expect(
    readMetadata({ ...CLOUD, revocation_endpoint: "ftp://x" })
      .revocationEndpoint,
  ).toBeUndefined();
});

test("the PKCE challenge is RFC 7636's: SHA-256 of the verifier in base64url, no padding", () => {
  // RFC 7636, appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const digest = createHash("sha256").update(verifier).digest("base64");
  expect(base64ToBase64Url(digest)).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  expect(
    base64Url(
      new Uint8Array([
        116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187,
        186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141,
        121,
      ]),
    ),
  ).toBe(verifier);
});

test("the browser is sent to authorize as openbot-mobile, back to the app's own address, asking for every scope", () => {
  const url = new URL(
    authorizationUrl(readMetadata(CLOUD), {
      state: "the-state",
      challenge: "the-challenge",
    }),
  );
  expect(`${url.origin}${url.pathname}`).toBe(CLOUD.authorization_endpoint);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: "openbotmobile://oauth/callback",
    scope: "bots:read conversations:write offline_access",
    state: "the-state",
    code_challenge: "the-challenge",
    code_challenge_method: "S256",
  });
});

test("the code is read only from this sign-in's answer: its address, its state and its issuer", () => {
  const sent = { state: "s1", issuer: CLOUD.issuer };
  const back = (query: string) => `${REDIRECT_URI}?${query}`;
  expect(
    readCallback(
      back(`code=c1&state=s1&iss=${encodeURIComponent(CLOUD.issuer)}`),
      sent,
    ),
  ).toBe("c1");
  expect(readCallback(back("code=c1&state=s1"), sent)).toBe("c1");
  for (const returned of [
    back("code=c1&state=another"),
    back("code=c1"),
    back(
      `code=c1&state=s1&iss=${encodeURIComponent("https://elsewhere.example/api/auth")}`,
    ),
    back("state=s1"),
    "openbotmobile://renewed?code=c1&state=s1",
    "https://my.open.bot/oauth/callback?code=c1&state=s1",
    "not an address",
  ])
    expect(() => readCallback(returned, sent)).toThrow(SignInError);
});

test("a refused sign-in says so in the person's words", () => {
  const refused = (error: string) => {
    try {
      readCallback(`${REDIRECT_URI}?error=${error}&state=s1`, { state: "s1" });
    } catch (failure) {
      return failure as SignInError;
    }
    throw new Error("not refused");
  };
  expect(refused("access_denied").message).toBe("Sign-in was cancelled.");
  expect(refused("access_denied").code).toBe("access_denied");
  expect(refused("server_error").message).toBe(
    "Sign-in didn't finish. Try again.",
  );
});

test("the code and a refresh token are exchanged as a public client with no secret", () => {
  expect(Object.fromEntries(codeExchange("c1", "v1"))).toEqual({
    grant_type: "authorization_code",
    code: "c1",
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: "v1",
  });
  expect(Object.fromEntries(refreshExchange("obr_1"))).toEqual({
    grant_type: "refresh_token",
    refresh_token: "obr_1",
    client_id: CLIENT_ID,
  });
});

test("a token answer gives the access token, the new refresh token and how long it lasts", () => {
  expect(
    readGrant({
      access_token: "oba_1",
      refresh_token: "obr_2",
      expires_in: 3600,
      token_type: "Bearer",
    }),
  ).toEqual({ accessToken: "oba_1", refreshToken: "obr_2", expiresIn: 3600 });
  // No new refresh token: the one in hand stays. No lifetime: an hour.
  expect(readGrant({ access_token: "oba_1" })).toEqual({
    accessToken: "oba_1",
    expiresIn: 3600,
  });
  expect(() => readGrant({ refresh_token: "obr_2" })).toThrow(SignInError);
});

test("a refused refresh ends the sign-in; a server that is down does not", () => {
  expect(signInEnded(400)).toBe(true);
  expect(signInEnded(401)).toBe(true);
  expect(signInEnded(500)).toBe(false);
  expect(signInEnded(503)).toBe(false);
});
