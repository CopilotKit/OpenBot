import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

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

describe("GitHub App sign-in configuration", () => {
  test("is absent when no GITHUB_APP_* is set", () => {
    expect(loadConfig(baseEnvironment).githubApp).toBeUndefined();
  });

  test("reads the client id and secret", () => {
    const config = loadConfig({
      ...baseEnvironment,
      GITHUB_APP_CLIENT_ID: "gh-id",
      GITHUB_APP_CLIENT_SECRET: "gh-secret",
    });
    expect(config.githubApp).toEqual({
      clientId: "gh-id",
      clientSecret: "gh-secret",
    });
  });

  test("includes the slug when set", () => {
    const config = loadConfig({
      ...baseEnvironment,
      GITHUB_APP_CLIENT_ID: "gh-id",
      GITHUB_APP_CLIENT_SECRET: "gh-secret",
      GITHUB_APP_SLUG: "openbot",
    });
    expect(config.githubApp).toEqual({
      clientId: "gh-id",
      clientSecret: "gh-secret",
      slug: "openbot",
    });
  });

  test.each([
    { GITHUB_APP_CLIENT_ID: "gh-id", GITHUB_APP_CLIENT_SECRET: "" },
    { GITHUB_APP_CLIENT_ID: "", GITHUB_APP_CLIENT_SECRET: "gh-secret" },
  ])("refuses only one half of the pair", (half) => {
    expect(() => loadConfig({ ...baseEnvironment, ...half })).toThrow(
      "GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set together",
    );
  });
});
