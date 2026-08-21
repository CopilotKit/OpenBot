import { describe, expect, test } from "bun:test";
import { catalogueEntry } from "../src/plugins/catalogue";
import {
  authorizationUrlFor,
  challengeFor,
  createVerifier,
  readConnectState,
  redirectUriFor,
  settingsUrlFor,
  signConnectState,
} from "../src/plugins/oauth";

/**
 * The half of the connect flow that leaves this deployment and comes back.
 *
 * Everything here exists because the browser is in the middle of it. An authorization code arrives
 * on a URL somebody else's server sent the person to, so nothing on that request can be believed on
 * its own: not who is connecting, not which server they meant, and not that they ever asked. The
 * signed state is what carries those facts across, and the PKCE verifier is what proves the code
 * being redeemed belongs to the request that started it.
 *
 * So these tests are almost entirely about refusal. A state that was tampered with, replayed after
 * expiry, or minted for another purpose has to come back as nothing, because the alternative is
 * attaching somebody else's Google account to this person's row.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const drive = catalogueEntry("google-drive");
if (drive?.auth.kind !== "user-oauth") {
  throw new Error("google-drive must be a user-oauth entry for these tests");
}
const driveAuth = drive.auth;

const NOW = 1_770_000_000_000;

describe("the state that travels through the vendor", () => {
  test("carries who, which server, and the verifier, and reads back exactly", () => {
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
      NOW,
    );
    expect(readConnectState(signed, KEY, NOW)).toEqual({
      userId: "user-1",
      serverId: "google-drive",
      verifier: "v-1",
    });
  });

  test("is refused once a character of it changes", () => {
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
      NOW,
    );
    // The payload is base64url, so flipping a character inside it is the realistic tamper: somebody
    // trying to have the callback attach their Google account to another person's row.
    const tampered = `${signed.slice(0, 4)}${signed[4] === "A" ? "B" : "A"}${signed.slice(5)}`;
    expect(readConnectState(tampered, KEY, NOW)).toBeNull();
  });

  test("is refused when signed with a different key", () => {
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      NOW,
    );
    expect(readConnectState(signed, KEY, NOW)).toBeNull();
  });

  test("expires, so a stale consent screen cannot be redeemed later", () => {
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
      NOW,
    );
    expect(readConnectState(signed, KEY, NOW + 60_000)).not.toBeNull();
    expect(readConnectState(signed, KEY, NOW + 60 * 60_000)).toBeNull();
  });

  test("cannot be a run assertion wearing a different hat", () => {
    // Signed under its own label, so a signature valid for one kind of statement is not valid as
    // another. Without that, any signed value this deployment ever hands out is a candidate state.
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
      NOW,
    );
    const [payload] = signed.split(".");
    expect(readConnectState(payload ?? "", KEY, NOW)).toBeNull();
  });

  test("is refused when it is not a state at all", () => {
    expect(readConnectState("", KEY, NOW)).toBeNull();
    expect(readConnectState("nonsense", KEY, NOW)).toBeNull();
    expect(readConnectState("a.b", KEY, NOW)).toBeNull();
  });
});

describe("PKCE", () => {
  test("a verifier is long enough and URL-safe", () => {
    const verifier = createVerifier();
    // RFC 7636 puts the floor at 43 characters, and the alphabet is unreserved characters only.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("two verifiers are not the same", () => {
    expect(createVerifier()).not.toBe(createVerifier());
  });

  test("a challenge is the S256 of the verifier, not the verifier", () => {
    // `plain` would make the challenge worthless: anybody who intercepted the authorization request
    // would hold the value needed to redeem the code.
    const verifier = "a".repeat(43);
    const challenge = challengeFor(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challengeFor(verifier)).toBe(challenge);
  });
});

describe("the address the person is sent to", () => {
  const url = new URL(
    authorizationUrlFor({
      auth: driveAuth,
      clientId: "client-id",
      redirectUri: "https://openbot.example/api/plugins/oauth/callback",
      state: "signed-state",
      codeChallenge: "challenge",
    }),
  );

  test("is the vendor's own, from the catalogue", () => {
    expect(`${url.origin}${url.pathname}`).toBe(driveAuth.authorizationUrl);
  });

  test("asks for a refresh token that consent is granted for once", () => {
    // Without `offline`, Google returns an access token and no refresh token, and the connection
    // would silently stop working an hour later. `consent` is what makes it re-issue a refresh token
    // rather than returning nothing on a second connect.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  test("asks only for the scopes the entry pins", () => {
    expect(url.searchParams.get("scope")).toBe(driveAuth.scopes.join(" "));
  });

  test("carries the state and the challenge, and names the method", () => {
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("the address the vendor sends them back to", () => {
  test("is one path, built from the deployment's own public URL", () => {
    expect(redirectUriFor("https://openbot.example")).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
  });

  test("does not double a slash when the public URL has a trailing one", () => {
    // A redirect URI has to match what was registered with the vendor character for character, so a
    // stray slash is not cosmetic: it fails at the vendor, with a message that does not name us.
    expect(redirectUriFor("https://openbot.example/")).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
  });
});

describe("where the callback sends somebody afterwards", () => {
  /*
   * The bug this exists to prevent, found by trying to run the thing rather than by reading it.
   *
   * The app and the API are two processes on two ports: Vite on 3010, this server on 3001. The
   * callback lands on the API, so `redirect("/settings")` resolved against the API's origin and ended
   * on a 404 — after the consent had succeeded and the grant was already stored. Nothing about that
   * looks like a failure of the connect flow, which is why it needs a test and not a comment.
   */
  test("is the app's origin, not the API's", () => {
    expect(settingsUrlFor("http://localhost:3010")).toBe(
      "http://localhost:3010/settings/connected-accounts",
    );
  });

  test("says that it failed, without saying which way", () => {
    // One outcome for a forged state and for an expired one. Telling them apart tells anybody
    // probing the endpoint how far they got.
    expect(settingsUrlFor("http://localhost:3010", "failed")).toBe(
      "http://localhost:3010/settings/connected-accounts?connected=failed",
    );
  });

  test("names the server it connected, so the page can confirm which", () => {
    expect(settingsUrlFor("http://localhost:3010", "google-drive")).toBe(
      "http://localhost:3010/settings/connected-accounts?connected=google-drive",
    );
  });

  test("still points somewhere when no app URL is configured", () => {
    // Relative is wrong on a split-port deployment and right on a single-origin one, which is the
    // only case where `appUrl` can be absent and the deployment still works.
    expect(settingsUrlFor(undefined)).toBe("/settings/connected-accounts");
  });
});
