import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
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
/**
 * A deployment that is actually deployed.
 *
 * `baseEnvironment` carries the example encryption key, which is refused under
 * `NODE_ENV=production` — so a production case built on it fails on the key before it reaches
 * whatever it meant to test. A real key here keeps each production test about its own subject.
 */
const productionEnvironment = {
  ...baseEnvironment,
  NODE_ENV: "production",
  KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
};

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
    expect(config.managedAgent).toEqual({
      endpoint: new URL("http://localhost:4200/ag-ui"),
      token: "managed-agent-token",
    });
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

  test("starts without a managed Bot when neither half is set", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_AG_UI_URL;
    delete environment.MANAGED_AGENT_TOKEN;

    expect(loadConfig(environment).managedAgent).toBeUndefined();
  });

  test("refuses a URL with no token", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_TOKEN;

    expect(() => loadConfig(environment)).toThrow(
      "MANAGED_AGENT_TOKEN must be set when MANAGED_AGENT_AG_UI_URL is set",
    );
  });

  test("ignores a leftover token when no URL is set", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_AG_UI_URL;

    expect(loadConfig(environment).managedAgent).toBeUndefined();
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

  // `.env.example` used to ship AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true, and copying that file is the
  // ordinary way a deployment gets its environment. So the way a hosted deployment ends up reaching
  // its own network is not forgetting to set something, it is inheriting something. Refused in
  // production for the same reason the example encryption key is: convenient locally, and an opening
  // anywhere else.
  test("refuses to start when a production deployment allows private hosts", () => {
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        AGENT_COMPUTER_URL: "http://localhost:4100",
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
      }),
    ).toThrow("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS");
  });

  // Both sides of the comparison come out of the same env file, and the switch is read through
  // `optional`, which trims. Comparing NODE_ENV raw would mean a trailing space typed into that file
  // slipped past the refusal while the switch beside it still counted as set.
  test("refuses a production deployment whose NODE_ENV carries whitespace", () => {
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        NODE_ENV: "production ",
        AGENT_COMPUTER_URL: "http://localhost:4100",
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
      }),
    ).toThrow("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS");
  });

  // The refusal has to name the way out, because the person reading it at boot is looking at a file
  // they copied and does not necessarily know which line is the problem.
  test("says to remove the line, and that it is local only", () => {
    const attempt = () =>
      loadConfig({
        ...productionEnvironment,
        AGENT_COMPUTER_URL: "http://localhost:4100",
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
      });

    expect(attempt).toThrow("local development only");
    expect(attempt).toThrow("Remove it");
  });

  // The half of the matrix that was always right and has to stay right: absent means off, including
  // in the environment where the new refusal lives.
  test("starts in production when nothing asked for private hosts", () => {
    const config = loadConfig({
      ...productionEnvironment,
      AGENT_COMPUTER_URL: "http://localhost:4100",
      COMPUTER_TOKEN: "computer-token",
    });

    expect(config.computer?.allowPrivateHosts).toBe(false);
  });

  // The local workflow is the reason the flag exists, so outside production it still does exactly
  // what it did. Warned about, because a laptop is where a deployment is configured and the warning
  // is the only chance to say this line does not travel.
  test.each(["development", undefined])(
    "warns and still allows private hosts under NODE_ENV=%p",
    (nodeEnv) => {
      const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const config = loadConfig({
          ...baseEnvironment,
          ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
          AGENT_COMPUTER_URL: "http://localhost:4100",
          AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
        });

        expect(config.computer?.allowPrivateHosts).toBe(true);
        // Searched rather than indexed: `baseEnvironment` carries the example encryption key, which
        // warns on its own account first.
        const warning = consoleWarn.mock.calls
          .map(([first]) => String(first))
          .find((line) => line.includes("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS"));

        expect(warning).toBeDefined();
        expect(warning).toContain("local development only");
        expect(warning).toContain("Remove it before deploying");
      } finally {
        consoleWarn.mockRestore();
      }
    },
  );

  // The refusal above only helps a deployment that reads it. The reason there was anything to refuse
  // is that the file everybody copies arrived with the switch on, so the file is worth asserting
  // about directly: a live line here is the regression, whatever the code does afterwards.
  test("the shipped example does not turn private hosts on", () => {
    const example = readFileSync(
      new URL("../../.env.example", import.meta.url),
      "utf8",
    );

    // Commented-out mentions are wanted — that is how the switch stays discoverable for a laptop.
    const live = example
      .split("\n")
      .filter((line) =>
        /^\s*AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS\s*=/.test(line),
      );

    expect(live).toEqual([]);
  });

  // Anything that is not the exact opt-in is not an opt-in, so it is not the thing being refused
  // either. A deployment that wrote something else has private hosts off and starts.
  test.each(["false", "1", "yes", ""])(
    "starts in production on AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=%p",
    (value) => {
      const config = loadConfig({
        ...productionEnvironment,
        AGENT_COMPUTER_URL: "http://localhost:4100",
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: value,
      });

      expect(config.computer?.allowPrivateHosts).toBe(false);
    },
  );

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

/**
 * Whether a Bot may answer with an interface it wrote itself.
 *
 * Same shape as accessibility above, and tested to the same bar for the same reason: the off switch
 * has a second reader. It is projected on /api/capabilities so the browser stops offering the tool
 * too, so a value that silently failed to mean "off" would leave Bots generating interfaces nothing
 * renders rather than merely leaving a capability on.
 */
describe("generated interfaces", () => {
  /*
   * The default is the whole point of this block. Written as a disable switch, an upgrade would hand
   * every existing deployment the ability to run code a model wrote, and a deployment that builds
   * its default branch automatically would acquire it without anybody deciding to.
   */
  test("are off when nothing is set", () => {
    expect(loadConfig(baseEnvironment).generativeUi).toBe(false);
  });

  test.each(["true", "1"])("are on for OPENBOT_GENERATIVE_UI=%p", (value) => {
    expect(
      loadConfig({ ...baseEnvironment, OPENBOT_GENERATIVE_UI: value })
        .generativeUi,
    ).toBe(true);
  });

  /*
   * Anything else is not a way of saying yes. A value nobody intended — a stray "false", an empty
   * variable left behind by a template — should leave the capability off, which is the direction
   * that cannot surprise anybody.
   */
  test.each(["false", "no", "", "yes", "TRUE", "on"])(
    "stay off for OPENBOT_GENERATIVE_UI=%p",
    (value) => {
      expect(
        loadConfig({ ...baseEnvironment, OPENBOT_GENERATIVE_UI: value })
          .generativeUi,
      ).toBe(false);
    },
  );

  // The old spelling was a disable switch. It must not still work, or a deployment that set it
  // would read as having made a choice it has not made under the new name.
  test("ignore the disable switch this replaced", () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        OPENBOT_GENERATIVE_UI_DISABLED: "false",
      }).generativeUi,
    ).toBe(false);
  });
});

/**
 * Naming the private addresses an agent may live at.
 *
 * The refusal cases matter as much as the parse: a list written as URLs or with a wildcard is a
 * list somebody believed was working, and finding out at the first registration that silently never
 * matches is worse than being told at boot.
 */
describe("AGENT_ENDPOINT_ALLOWED_HOSTS", () => {
  // The suite's own base, so this describes only its subject rather than re-deriving a whole
  // deployment and failing on whichever requirement it forgot.
  const base = () => ({ ...baseEnvironment });

  test("unset means none, which is the posture that shipped", () => {
    expect(loadConfig(base()).agentEndpointAllowedHosts.size).toBe(0);
  });

  test("a comma-separated list is parsed, lower-cased and trimmed", () => {
    const hosts = loadConfig({
      ...base(),
      AGENT_ENDPOINT_ALLOWED_HOSTS: " Agents.Internal , 10.0.0.42:9000 ",
    }).agentEndpointAllowedHosts;
    expect([...hosts].sort()).toEqual(["10.0.0.42:9000", "agents.internal"]);
  });

  test("a URL is refused, naming the entry", () => {
    expect(() =>
      loadConfig({
        ...base(),
        AGENT_ENDPOINT_ALLOWED_HOSTS: "http://agents.internal/ag-ui",
      }),
    ).toThrow(/must be a host/);
  });

  test("a wildcard is refused, naming the entry", () => {
    // A pattern that widens by accident is the usual way a host check fails, so there are no
    // patterns to get wrong.
    expect(() =>
      loadConfig({ ...base(), AGENT_ENDPOINT_ALLOWED_HOSTS: "*.internal" }),
    ).toThrow(/Patterns are not accepted/);
  });
});

/**
 * A cap is a safety number, so a value that is not one has to stop the deployment rather than be
 * quietly replaced by the default. Somebody who typed `two` would otherwise believe they had set a
 * cap, and find out at the first loop.
 */
describe("how far a Bot may hand work on", () => {
  test("defaults to one level and three per run", () => {
    const config = loadConfig({ ...baseEnvironment });
    expect(config.handoff).toEqual({ maxDepth: 1, maxPerRun: 3 });
  });

  test("a deployment can widen or switch it off", () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        BOT_HANDOFF_MAX_DEPTH: "0",
        BOT_HANDOFF_MAX_PER_RUN: "10",
      }).handoff,
    ).toEqual({ maxDepth: 0, maxPerRun: 10 });
  });

  test("refuses a cap that is not a whole number", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, BOT_HANDOFF_MAX_DEPTH: "two" }),
    ).toThrow("BOT_HANDOFF_MAX_DEPTH");
    expect(() =>
      loadConfig({ ...baseEnvironment, BOT_HANDOFF_MAX_PER_RUN: "-1" }),
    ).toThrow("BOT_HANDOFF_MAX_PER_RUN");
    expect(() =>
      loadConfig({ ...baseEnvironment, BOT_HANDOFF_MAX_PER_RUN: "1.5" }),
    ).toThrow("BOT_HANDOFF_MAX_PER_RUN");
  });
});

/**
 * The mailbox, which is three variables that mean nothing apart and secrets that are not here.
 *
 * The absent case is the one worth pinning: it is the ordinary state of every deployment that does
 * not want this, and it must not be a start-up failure: the catalogue entry stays admissible and
 * grantable either way, and a tool call is where a deployment finds out.
 */
describe("the deployment's mailbox", () => {
  const MAILBOX = {
    MAILBOX_IMAP_HOST: "imap.example.test",
    MAILBOX_SMTP_HOST: "smtp.example.test",
    MAILBOX_USERS: "bot@example.test",
  };

  test("is absent when none of it is set, without refusing to start", () => {
    expect(loadConfig(baseEnvironment).mailbox).toBeUndefined();
  });

  test("defaults both ports to the implicit-TLS ones", () => {
    // 993 and 465 rather than the STARTTLS ports, so the connection is encrypted before the
    // password is sent rather than negotiating for it in the clear.
    expect(loadConfig({ ...baseEnvironment, ...MAILBOX }).mailbox).toEqual({
      imapHost: "imap.example.test",
      imapPort: 993,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      users: ["bot@example.test"],
      // Unset means anywhere, which is the behaviour every deployment had before the list existed.
      allowedRecipientDomains: new Set(),
    });
  });

  test("reads several accounts, in order, with the first as the default", () => {
    // One pair of hosts, an account each: the shared-hosting shape. The order is a decision, since
    // the first is what a tool call that named no account works in.
    expect(
      loadConfig({
        ...baseEnvironment,
        ...MAILBOX,
        MAILBOX_USERS:
          "Support@Example.test, sales@example.test ,billing@example.test",
      }).mailbox?.users,
    ).toEqual([
      "support@example.test",
      "sales@example.test",
      "billing@example.test",
    ]);
  });

  test("deduplicates accounts that differ only in case", () => {
    // The address is also the key of the vault credential holding that account's password, so two
    // spellings of one mailbox would be a second account nothing can ever unlock.
    expect(
      loadConfig({
        ...baseEnvironment,
        ...MAILBOX,
        MAILBOX_USERS: "bot@example.test,BOT@example.test",
      }).mailbox?.users,
    ).toEqual(["bot@example.test"]);
  });

  test("still reads the singular MAILBOX_USER, as a list of one", () => {
    // The variable this feature shipped with. A deployment that already has one should not have to
    // be edited to keep working.
    expect(
      loadConfig({
        ...baseEnvironment,
        MAILBOX_IMAP_HOST: "imap.example.test",
        MAILBOX_SMTP_HOST: "smtp.example.test",
        MAILBOX_USER: "Bot@Example.test",
      }).mailbox?.users,
    ).toEqual(["bot@example.test"]);
  });

  test("refuses both spellings at once, naming the conflict", () => {
    // Two answers to the same question. Merging them or preferring one silently would be guessing
    // at an intention nothing here can read.
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...MAILBOX,
        MAILBOX_USER: "other@example.test",
      }),
    ).toThrow("MAILBOX_USERS and MAILBOX_USER are both set");
  });

  test("refuses an account that is not an address, naming it", () => {
    // It would otherwise become an account a model can select, a credential key an administrator
    // cannot guess, and a login failure at run time in front of somebody.
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ...MAILBOX,
        MAILBOX_USERS: "bot@example.test,not-an-address",
      }),
    ).toThrow('MAILBOX_USERS entry "not-an-address"');
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        MAILBOX_IMAP_HOST: "imap.example.test",
        MAILBOX_SMTP_HOST: "smtp.example.test",
        MAILBOX_USER: "bot at example.test",
      }),
    ).toThrow('MAILBOX_USER entry "bot at example.test"');
  });

  test("reads the recipient allowlist, lower-cased and without the @ people write", () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        ...MAILBOX,
        MAILBOX_ALLOWED_RECIPIENT_DOMAINS: "Example.com, @partner.example",
      }).mailbox?.allowedRecipientDomains,
    ).toEqual(new Set(["example.com", "partner.example"]));
  });

  test("an emptied allowlist means anywhere, not nowhere", () => {
    // A blanked line in a .env has switched the restriction off. The opposite reading would be a
    // mailbox that silently refuses everybody.
    expect(
      loadConfig({
        ...baseEnvironment,
        ...MAILBOX,
        MAILBOX_ALLOWED_RECIPIENT_DOMAINS: "  ",
      }).mailbox?.allowedRecipientDomains.size,
    ).toBe(0);
  });

  test("refuses an allowlist entry that is not a domain", () => {
    // A safety list written as an address would match nothing while looking like a restriction.
    for (const entry of ["sales@example.com", "https://example.com", "a b"]) {
      expect(() =>
        loadConfig({
          ...baseEnvironment,
          ...MAILBOX,
          MAILBOX_ALLOWED_RECIPIENT_DOMAINS: entry,
        }),
      ).toThrow("MAILBOX_ALLOWED_RECIPIENT_DOMAINS");
    }
  });

  test("takes ports a deployment names", () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        ...MAILBOX,
        MAILBOX_IMAP_PORT: "1993",
        MAILBOX_SMTP_PORT: "2465",
      }).mailbox,
    ).toMatchObject({ imapPort: 1993, smtpPort: 2465 });
  });

  test("refuses half a mailbox, naming what is missing", () => {
    // Booting with a host and no user is a deployment where every mail tool fails at the first
    // login, at run time, in front of somebody, with nothing but an auth error to go on.
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        MAILBOX_IMAP_HOST: "imap.example.test",
      }),
    ).toThrow("MAILBOX_SMTP_HOST, MAILBOX_USERS");
    expect(() =>
      loadConfig({ ...baseEnvironment, MAILBOX_USERS: "bot@example.test" }),
    ).toThrow("MAILBOX_IMAP_HOST, MAILBOX_SMTP_HOST");
  });

  test("refuses a port that is not a port, rather than falling back to the default", () => {
    for (const port of ["nine-nine-three", "0", "70000", "993.5"]) {
      expect(() =>
        loadConfig({ ...baseEnvironment, ...MAILBOX, MAILBOX_IMAP_PORT: port }),
      ).toThrow("MAILBOX_IMAP_PORT must be a port number between 1 and 65535");
    }
  });
});
