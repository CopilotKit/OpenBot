import { describe, expect, test } from "bun:test";
import {
  callbackMatches,
  completedAuthConfig,
  consentUrl,
  readConnectionOutcome,
  readCredentialRequest,
} from "../src/lib/copilot/adk-credential";

/**
 * The contract with ADK, exercised in both of its spellings.
 *
 * ADK serializes its models with camelCase aliases, but the same models dumped without aliases
 * arrive in snake_case, and the card must answer in whichever spelling the agent will recognize as
 * its own. The fixtures mirror what `ag-ui-adk` actually streams: `{functionCallId, authConfig}`
 * with the consent URL inside the exchanged credential.
 */

const AUTH_URI =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&state=xyz-123";

function camelArgs() {
  return {
    functionCallId: "call-1",
    authConfig: {
      authScheme: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            scopes: {
              "https://www.googleapis.com/auth/spreadsheets": "Sheets",
              openid: "OpenID",
            },
          },
        },
      },
      exchangedAuthCredential: {
        authType: "oauth2",
        oauth2: { authUri: AUTH_URI, clientId: "abc", clientSecret: "shh" },
      },
      credentialKey: "adk_key",
    },
  };
}

function snakeArgs() {
  return {
    function_call_id: "call-1",
    auth_config: {
      auth_scheme: { type: "openIdConnect", scopes: ["openid", "email"] },
      exchanged_auth_credential: {
        auth_type: "oauth2",
        oauth2: { auth_uri: AUTH_URI, client_id: "abc" },
      },
    },
  };
}

describe("reading the request", () => {
  test("camelCase, as ADK serializes it", () => {
    const request = readCredentialRequest(camelArgs());
    expect(request).toBeDefined();
    expect(request?.authorizationUrl).toBe(AUTH_URI);
    expect(request?.provider).toBe("accounts.google.com");
    expect(request?.state).toBe("xyz-123");
    expect(request?.scopes).toEqual([
      "https://www.googleapis.com/auth/spreadsheets",
      "openid",
    ]);
  });

  test("snake_case, as the same models dump without aliases", () => {
    const request = readCredentialRequest(snakeArgs());
    expect(request?.authorizationUrl).toBe(AUTH_URI);
    expect(request?.scopes).toEqual(["openid", "email"]);
  });

  test("arguments still streaming in are not yet a request", () => {
    expect(readCredentialRequest(undefined)).toBeUndefined();
    expect(readCredentialRequest({})).toBeUndefined();
    expect(readCredentialRequest({ authConfig: {} })).toBeUndefined();
    expect(
      readCredentialRequest({ authConfig: { exchangedAuthCredential: {} } }),
    ).toBeUndefined();
  });

  test("a consent 'URL' that is not somewhere to sign in is refused", () => {
    const args = camelArgs();
    args.authConfig.exchangedAuthCredential.oauth2.authUri =
      "javascript:alert(1)";
    expect(readCredentialRequest(args)).toBeUndefined();
  });
});

describe("building the consent URL", () => {
  test("our callback becomes the redirect and the rest survives", () => {
    const request = readCredentialRequest(camelArgs());
    if (!request) throw new Error("fixture did not parse");
    const url = new URL(
      consentUrl(request, "https://openbot.example/api/agents/oauth/callback"),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://openbot.example/api/agents/oauth/callback",
    );
    expect(url.searchParams.get("state")).toBe("xyz-123");
    expect(url.searchParams.get("client_id")).toBe("abc");
  });

  test("a redirect the agent guessed at is replaced, not joined", () => {
    const args = camelArgs();
    args.authConfig.exchangedAuthCredential.oauth2.authUri = `${AUTH_URI}&redirect_uri=https%3A%2F%2Felsewhere.example%2Fcb`;
    const request = readCredentialRequest(args);
    if (!request) throw new Error("fixture did not parse");
    const url = new URL(consentUrl(request, "https://openbot.example/cb"));
    expect(url.searchParams.getAll("redirect_uri")).toEqual([
      "https://openbot.example/cb",
    ]);
  });
});

describe("matching the callback to its request", () => {
  test("the state the agent minted is the correlation", () => {
    expect(
      callbackMatches(
        "https://openbot.example/cb?code=c&state=xyz-123",
        "xyz-123",
      ),
    ).toBe(true);
    expect(
      callbackMatches(
        "https://openbot.example/cb?code=c&state=other",
        "xyz-123",
      ),
    ).toBe(false);
  });

  test("a request without state accepts the answer it gets", () => {
    expect(
      callbackMatches("https://openbot.example/cb?code=c", undefined),
    ).toBe(true);
  });

  test("an unparseable callback matches nothing", () => {
    expect(callbackMatches("not a url", "xyz-123")).toBe(false);
  });
});

describe("completing the config", () => {
  test("answer fields land beside the credential, in its own spelling", () => {
    const { authConfig } = camelArgs();
    const completed = completedAuthConfig(
      authConfig,
      "https://openbot.example/cb?code=c&state=xyz-123",
      "https://openbot.example/cb",
    ) as typeof authConfig & {
      exchangedAuthCredential: {
        oauth2: Record<string, unknown>;
      };
    };
    expect(completed.exchangedAuthCredential.oauth2.authResponseUri).toBe(
      "https://openbot.example/cb?code=c&state=xyz-123",
    );
    expect(completed.exchangedAuthCredential.oauth2.redirectUri).toBe(
      "https://openbot.example/cb",
    );
    // Everything the agent needs to redeem the code rides along untouched.
    expect(completed.exchangedAuthCredential.oauth2.clientId).toBe("abc");
    expect(completed.credentialKey).toBe("adk_key");
  });

  test("a snake_case config is answered in snake_case", () => {
    const authConfig = snakeArgs().auth_config;
    const completed = completedAuthConfig(
      authConfig,
      "https://openbot.example/cb?code=c",
      "https://openbot.example/cb",
    ) as Record<string, { oauth2: Record<string, unknown> }>;
    expect(completed.exchanged_auth_credential.oauth2.auth_response_uri).toBe(
      "https://openbot.example/cb?code=c",
    );
    expect(completed.exchanged_auth_credential.oauth2.redirect_uri).toBe(
      "https://openbot.example/cb",
    );
  });

  test("the original is render state and is left alone", () => {
    const { authConfig } = camelArgs();
    completedAuthConfig(
      authConfig,
      "https://cb.example/?code=c",
      "https://cb.example/",
    );
    expect(
      (authConfig.exchangedAuthCredential.oauth2 as Record<string, unknown>)
        .authResponseUri,
    ).toBeUndefined();
  });
});

describe("reading a completed card's outcome", () => {
  test("an answer URL inside means signed in", () => {
    const completed = completedAuthConfig(
      camelArgs().authConfig,
      "https://cb.example/?code=c",
      "https://cb.example/",
    );
    expect(readConnectionOutcome(JSON.stringify(completed))).toBe("connected");
  });

  test("the config echoed back untouched means declined", () => {
    expect(readConnectionOutcome(JSON.stringify(camelArgs().authConfig))).toBe(
      "declined",
    );
  });

  test("anything unreadable gets no badge rather than a wrong one", () => {
    expect(readConnectionOutcome(undefined)).toBeUndefined();
    expect(readConnectionOutcome("not json")).toBeUndefined();
    expect(readConnectionOutcome('"a string"')).toBeUndefined();
  });
});
