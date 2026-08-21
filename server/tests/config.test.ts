import { describe, expect, test } from "bun:test";
import { configuredAuthProviders, loadConfig } from "../src/config";

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
  INITIAL_ADMIN_EMAILS: "admin@openbot.test",
  INTELLIGENCE_API_URL: "http://localhost:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
  INTELLIGENCE_API_KEY: "tenant-api-key",
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
  MANAGED_AGENT_TOKEN: "managed-agent-token",
};

/**
 * The same deployment with nothing signing anybody in.
 *
 * `baseEnvironment` ships Google and a session secret because most tests want authentication on.
 * The provider tests need the opposite starting point, or "Microsoft is configured" cannot be told
 * apart from "Microsoft and the Google that was already there".
 */
const {
  GOOGLE_OAUTH_CLIENT_ID: _googleId,
  GOOGLE_OAUTH_CLIENT_SECRET: _googleSecret,
  BETTER_AUTH_SECRET: _authSecret,
  BETTER_AUTH_URL: _authUrl,
  INITIAL_ADMIN_EMAILS: _adminEmails,
  ...withoutSignIn
} = baseEnvironment;

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

  test("allows deployment without an authentication provider, when asked to", () => {
    const config = loadConfig({
      DATABASE_URL: baseEnvironment.DATABASE_URL,
      KEY_ENCRYPTION_KEY: baseEnvironment.KEY_ENCRYPTION_KEY,
      INTELLIGENCE_API_URL: baseEnvironment.INTELLIGENCE_API_URL,
      INTELLIGENCE_GATEWAY_WS_URL: baseEnvironment.INTELLIGENCE_GATEWAY_WS_URL,
      INTELLIGENCE_API_KEY: baseEnvironment.INTELLIGENCE_API_KEY,
      COPILOTKIT_LICENSE_TOKEN: baseEnvironment.COPILOTKIT_LICENSE_TOKEN,
      MANAGED_AGENT_AG_UI_URL: baseEnvironment.MANAGED_AGENT_AG_UI_URL,
      MANAGED_AGENT_TOKEN: baseEnvironment.MANAGED_AGENT_TOKEN,
      // Explicit, because no provider means every visitor is the administrator and a deployment has
      // to say it meant that. See single-user.test.ts.
      OPENBOT_SINGLE_USER: "true",
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
        MANAGED_AGENT_TOKEN: baseEnvironment.MANAGED_AGENT_TOKEN,
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
      "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set together",
    );
  });

  test("refuses to start when MANAGED_AGENT_AG_UI_URL is missing", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_AG_UI_URL;

    expect(() => loadConfig(environment)).toThrow("MANAGED_AGENT_AG_UI_URL");
  });

  test("refuses to start when MANAGED_AGENT_TOKEN is missing", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_TOKEN;

    expect(() => loadConfig(environment)).toThrow("MANAGED_AGENT_TOKEN");
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
      trustedOrigins: ["http://localhost:3000"],
      initialAdminEmails: ["admin@openbot.test", "owner@openbot.test"],
    });
  });

  /**
   * Sign-in with more than one identity provider.
   *
   * A company mid-migration has some people on Entra and some still on Okta, so more than one at a
   * time is the normal shape rather than a corner. These assert the shape the sign-in screen reads
   * and every arrangement that cannot work refusing at start-up, which is the only moment a
   * misconfiguration is cheap to find.
   */
  const SESSION = {
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3001",
    INITIAL_ADMIN_EMAILS: "admin@openbot.test",
  };

  /** What a deployment with no provider has to say before it is allowed to come up. */
  const OPEN = { OPENBOT_SINGLE_USER: "true" };

  test("enables Microsoft, and admits any account until told a directory", () => {
    const config = loadConfig({
      ...withoutSignIn,
      ...SESSION,
      MICROSOFT_OAUTH_CLIENT_ID: "entra-client-id",
      MICROSOFT_OAUTH_CLIENT_SECRET: "entra-client-secret",
    });

    // `common` is Microsoft's own default and admits personal accounts as well as work ones. A
    // deployment that means "our staff" has to say so with a directory GUID.
    expect(config.auth?.microsoft).toEqual({
      clientId: "entra-client-id",
      clientSecret: "entra-client-secret",
      tenantId: "common",
    });
    expect(configuredAuthProviders(config.auth)).toEqual(["microsoft"]);
  });

  test("narrows Microsoft to one directory when given a tenant", () => {
    const config = loadConfig({
      ...withoutSignIn,
      ...SESSION,
      MICROSOFT_OAUTH_CLIENT_ID: "entra-client-id",
      MICROSOFT_OAUTH_CLIENT_SECRET: "entra-client-secret",
      MICROSOFT_OAUTH_TENANT_ID: "8f2c1e40-0000-0000-0000-000000000000",
    });

    expect(config.auth?.microsoft?.tenantId).toBe(
      "8f2c1e40-0000-0000-0000-000000000000",
    );
  });

  test("enables Okta against its issuer", () => {
    const config = loadConfig({
      ...withoutSignIn,
      ...SESSION,
      OKTA_OAUTH_CLIENT_ID: "okta-client-id",
      OKTA_OAUTH_CLIENT_SECRET: "okta-client-secret",
      OKTA_OAUTH_ISSUER: "https://example.okta.com/oauth2/default",
    });

    expect(config.auth?.okta).toEqual({
      clientId: "okta-client-id",
      clientSecret: "okta-client-secret",
      issuer: "https://example.okta.com/oauth2/default",
    });
  });

  test("refuses Okta without an issuer, which names no particular Okta", () => {
    expect(() =>
      loadConfig({
        ...withoutSignIn,
        ...SESSION,
        OKTA_OAUTH_CLIENT_ID: "okta-client-id",
        OKTA_OAUTH_CLIENT_SECRET: "okta-client-secret",
      }),
    ).toThrow("OKTA_OAUTH_ISSUER");
  });

  test("refuses an Okta issuer with no credentials behind it", () => {
    expect(() =>
      loadConfig({
        ...withoutSignIn,
        ...SESSION,
        OKTA_OAUTH_ISSUER: "https://example.okta.com/oauth2/default",
      }),
    ).toThrow("OKTA_OAUTH_CLIENT_ID");
  });

  test("carries all three at once, in a fixed order", () => {
    const config = loadConfig({
      ...withoutSignIn,
      ...SESSION,
      GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      MICROSOFT_OAUTH_CLIENT_ID: "entra-client-id",
      MICROSOFT_OAUTH_CLIENT_SECRET: "entra-client-secret",
      OKTA_OAUTH_CLIENT_ID: "okta-client-id",
      OKTA_OAUTH_CLIENT_SECRET: "okta-client-secret",
      OKTA_OAUTH_ISSUER: "https://example.okta.com/oauth2/default",
    });

    // The order the buttons appear in, fixed here so it cannot change with how a .env was written.
    expect(configuredAuthProviders(config.auth)).toEqual([
      "google",
      "microsoft",
      "okta",
    ]);
  });

  /**
   * Somebody has to be an administrator.
   *
   * The role is written from this list and no route anywhere changes one, so a deployment that
   * configures sign-in without it admits everybody as a plain user and can never promote anyone.
   * Start-up is the only cheap moment to notice.
   */
  test("refuses sign-in with nobody named as an administrator", () => {
    const { INITIAL_ADMIN_EMAILS: _none, ...withoutAdmins } = baseEnvironment;

    expect(() => loadConfig(withoutAdmins)).toThrow("INITIAL_ADMIN_EMAILS");
  });

  test("asks for no administrator when nothing signs anybody in", () => {
    // One administrator either way, and no list to write. Requiring one here as well would mean a
    // deployment had to name an administrator for a mode that has exactly one.
    expect(() => loadConfig({ ...withoutSignIn, ...OPEN })).not.toThrow();
  });

  test("refuses to start with no provider and nothing saying that was meant", () => {
    // The whole of the sign-in story in one line. This used to come up open, and `NODE_ENV` was the
    // only thing standing between a bare-VM deployment and serving every visitor as an
    // administrator, which is unset by default on exactly that deployment.
    expect(() => loadConfig(withoutSignIn)).toThrow(
      "No identity provider is configured",
    );
  });

  test("is off, and lists nothing, when no provider is configured", () => {
    const config = loadConfig({ ...withoutSignIn, ...OPEN });

    expect(config.auth).toBeUndefined();
    expect(configuredAuthProviders(config.auth)).toEqual([]);
  });

  test("refuses a session secret with no provider to use it", () => {
    expect(() => loadConfig({ ...withoutSignIn, ...SESSION })).toThrow(
      "no identity provider",
    );
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
    ).toThrow("Sign-in requires BETTER_AUTH_SECRET");
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

  test("configures Docker as the per-Bot computer provider", () => {
    const config = loadConfig({
      ...baseEnvironment,
      COMPUTER_SUPERVISOR_URL: "http://localhost:4000",
      SUPERVISOR_TOKEN: "supervisor-token",
      COMPUTER_TOKEN: "computer-token",
    });

    expect(config.computer?.provider).toBe("docker");
    expect(config.computer).toEqual({
      provider: "docker",
      baseUrl: "http://localhost:4000",
      supervisorToken: "supervisor-token",
      token: "computer-token",
      allowPrivateHosts: false,
    });
  });

  test("configures one shared computer", () => {
    const config = loadConfig({
      ...baseEnvironment,
      AGENT_COMPUTER_URL: "http://localhost:4100",
      COMPUTER_TOKEN: "computer-token",
    });

    expect(config.computer?.provider).toBe("shared");
    expect(config.computer).toEqual({
      provider: "shared",
      baseUrl: "http://localhost:4100",
      token: "computer-token",
      allowPrivateHosts: false,
    });
  });

  test("leaves computers off when no provider address is configured", () => {
    expect(loadConfig(baseEnvironment).computer).toBeUndefined();
  });

  test.each([
    ["Docker", "COMPUTER_SUPERVISOR_URL"],
    ["shared", "AGENT_COMPUTER_URL"],
  ] as const)("refuses an invalid %s computer provider URL", (_, urlName) => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        [urlName]: "not a URL",
      }),
    ).toThrow(`${urlName} must be a valid URL`);
  });
});

describe("accessibility", () => {
  test("is on when nothing is set", () => {
    expect(loadConfig(baseEnvironment).accessibility).toBe(true);
  });

  test.each(["true", "1"])(
    "is off on OPENBOT_ACCESSIBILITY_DISABLED=%p",
    (value) => {
      expect(
        loadConfig({
          ...baseEnvironment,
          OPENBOT_ACCESSIBILITY_DISABLED: value,
        }).accessibility,
      ).toBe(false);
    },
  );

  // Anything else is not a way of saying off. A deployment that typed something
  // else has not opted out, and silently treating it as opt-out would be a
  // setting that appears to work and does not.
  test.each(["false", "no", "", "yes"])(
    "stays on for OPENBOT_ACCESSIBILITY_DISABLED=%p",
    (value) => {
      expect(
        loadConfig({
          ...baseEnvironment,
          OPENBOT_ACCESSIBILITY_DISABLED: value,
        }).accessibility,
      ).toBe(true);
    },
  );
});
