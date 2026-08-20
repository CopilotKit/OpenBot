/**
 * The minimum environment a deployment is allowed to boot with, for tests that need a config but are
 * not testing configuration itself.
 *
 * It lives in one place because the minimum is a moving target: Intelligence became mandatory and
 * five test files each carried their own copy of the environment, so every one of them started
 * failing for a reason that had nothing to do with what it was testing. Tests that assert on
 * configuration should keep building their environment inline; everything else should spread this.
 */
export function testEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3001",
    // Required. See server/src/config.ts: there is no runtime without Intelligence.
    INTELLIGENCE_API_URL: "http://localhost:7100",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
    INTELLIGENCE_API_KEY: "tenant-api-key",
    COPILOTKIT_LICENSE_TOKEN: "license-token",
    MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    MANAGED_AGENT_TOKEN: "managed-agent-token",
    ...overrides,
  };
}
