import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

// Intelligence is part of the MINIMUM contract, so it belongs in the base environment every other
// case builds on. Leaving it out of the base would make most of this file assert the behaviour of a
// deployment that is not allowed to exist.
const baseEnvironment = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3001",
  INTELLIGENCE_API_URL: "http://localhost:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
  INTELLIGENCE_API_KEY: "tenant-api-key",
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
};

describe("deployment configuration", () => {
  test("resolves the Intelligence runtime, which is the only runtime", () => {
    const config = loadConfig(baseEnvironment);

    expect(config.runtime).toEqual({
      mode: "intelligence",
      durableHistory: true,
      intelligence: {
        apiUrl: "http://localhost:7100",
        gatewayWsUrl: "ws://localhost:7103",
        apiKey: "tenant-api-key",
        licenseToken: "license-token",
      },
    });
    expect(config.managedAgentAgUiUrl).toEqual(
      new URL("http://localhost:4200/ag-ui"),
    );
    expect(config.tenantPackageDirectory).toBe("../examples/fintech");
  });

  test("allows deployment without an authentication provider", () => {
    const config = loadConfig({
      DATABASE_URL: baseEnvironment.DATABASE_URL,
      KEY_ENCRYPTION_KEY: baseEnvironment.KEY_ENCRYPTION_KEY,
      INTELLIGENCE_API_URL: baseEnvironment.INTELLIGENCE_API_URL,
      INTELLIGENCE_GATEWAY_WS_URL: baseEnvironment.INTELLIGENCE_GATEWAY_WS_URL,
      INTELLIGENCE_API_KEY: baseEnvironment.INTELLIGENCE_API_KEY,
      COPILOTKIT_LICENSE_TOKEN: baseEnvironment.COPILOTKIT_LICENSE_TOKEN,
      MANAGED_AGENT_AG_UI_URL: baseEnvironment.MANAGED_AGENT_AG_UI_URL,
    });

    expect(config.auth).toBeUndefined();
  });

  // The product does not have a mode without Intelligence, so each of these is a refusal to boot
  // rather than a degraded capability. Named individually because a deployment that sets three of
  // four is the likeliest real mistake, and the message has to say which one is missing.
  test.each([
    "INTELLIGENCE_API_URL",
    "INTELLIGENCE_GATEWAY_WS_URL",
    "INTELLIGENCE_API_KEY",
    "COPILOTKIT_LICENSE_TOKEN",
  ])("refuses to start when %s is missing", (name) => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment[name];

    expect(() => loadConfig(environment)).toThrow(
      `CopilotKit Intelligence is required and is not configured. Missing: ${name}`,
    );
  });

  test("refuses to start when Intelligence is absent entirely, rather than degrading", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: baseEnvironment.DATABASE_URL,
        KEY_ENCRYPTION_KEY: baseEnvironment.KEY_ENCRYPTION_KEY,
        MANAGED_AGENT_AG_UI_URL: baseEnvironment.MANAGED_AGENT_AG_UI_URL,
      }),
    ).toThrow("CopilotKit Intelligence is required and is not configured");
  });

  test("rejects incomplete OAuth client configuration", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "",
      }),
    ).toThrow(
      "Google OAuth configuration requires both client ID and client secret",
    );
  });

  test("refuses to start when MANAGED_AGENT_AG_UI_URL is missing", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_AG_UI_URL;

    expect(() => loadConfig(environment)).toThrow("MANAGED_AGENT_AG_UI_URL");
  });

  test("refuses a non-HTTP MANAGED_AGENT_AG_UI_URL", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        MANAGED_AGENT_AG_UI_URL: "ftp://localhost:4200/ag-ui",
      }),
    ).toThrow("MANAGED_AGENT_AG_UI_URL");
  });

  test("requires a base64-encoded 32-byte key-encryption key", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        KEY_ENCRYPTION_KEY: "local-development-key",
      }),
    ).toThrow("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  });

  test("enables Google authentication when its complete deployment contract is present", () => {
    const config = loadConfig({
      ...baseEnvironment,
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
      BETTER_AUTH_URL: "http://localhost:3001",
      INITIAL_ADMIN_EMAILS: "admin@openbot.test, owner@openbot.test",
    });

    expect(config.auth).toEqual({
      baseUrl: "http://localhost:3001",
      secret: "a-long-enough-local-development-auth-secret",
      google: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      },
      trustedOrigins: ["http://localhost:3010"],
      initialAdminEmails: ["admin@openbot.test", "owner@openbot.test"],
    });
  });

  test("rejects incomplete Google authentication deployment settings", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
        BETTER_AUTH_SECRET: "",
        BETTER_AUTH_URL: "http://localhost:3001",
      }),
    ).toThrow("Google authentication requires BETTER_AUTH_SECRET");
  });

  // A turn that is ended is a turn somebody loses, so an unset variable leaves every stream alone
  // rather than acquiring a timeout the deployment never asked for. `.env.example` ships a value.
  test("leaves the stall watchdog off when nothing is configured", () => {
    expect(loadConfig(baseEnvironment).agentStallTimeoutMs).toBe(0);
  });

  test("takes a timeout in milliseconds, and zero as switching it off", () => {
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "120000" })
        .agentStallTimeoutMs,
    ).toBe(120_000);
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "0" })
        .agentStallTimeoutMs,
    ).toBe(0);
  });

  // Refused rather than defaulted, for the same reason a malformed policy is: an operator who meant
  // to write a boundary and mistyped it would otherwise get a deployment enforcing something else.
  test.each(["two minutes", "-1", "1.5", ""])(
    "refuses to start on AGENT_STALL_TIMEOUT_MS=%p",
    (value) => {
      const attempt = () =>
        loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: value });
      if (value === "") {
        // An empty value is an absent one, which is the off case rather than a malformed one.
        expect(attempt().agentStallTimeoutMs).toBe(0);
        return;
      }
      expect(attempt).toThrow("AGENT_STALL_TIMEOUT_MS");
    },
  );
});
