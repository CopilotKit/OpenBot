import { afterEach, describe, expect, test } from "bun:test";
import { createReleaseStatusRoutes } from "../src/release-status";

const keys = [
  "VERSION",
  "COMMIT",
  "DISTRIBUTION_ID",
  "REPOSITORY",
  "CHANNEL",
] as const;
const previous = new Map(
  keys.map((key) => [key, process.env[`OPENBOT_BUILD_${key}`]]),
);
afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[`OPENBOT_BUILD_${key}`];
    else process.env[`OPENBOT_BUILD_${key}`] = value;
  }
});
const identity = {
  version: "v0.3.0",
  commit: "3".repeat(40),
  distributionId: "acme.openbot",
  repository: "acme/openbot",
  channel: "stable",
};
function appWithBuild(env: Partial<Record<(typeof keys)[number], string>>) {
  for (const key of keys) {
    const value = env[key];
    if (value === undefined) delete process.env[`OPENBOT_BUILD_${key}`];
    else process.env[`OPENBOT_BUILD_${key}`] = value;
  }
  return createReleaseStatusRoutes();
}
function completeBuild() {
  return {
    VERSION: identity.version,
    COMMIT: identity.commit,
    DISTRIBUTION_ID: identity.distributionId,
    REPOSITORY: identity.repository,
    CHANNEL: identity.channel,
  };
}

describe("running release identity", () => {
  test("serves only the exact startup build identity without credentials", async () => {
    const app = appWithBuild(completeBuild());
    const response = await app.request("/release");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(identity);
  });
  test.each([
    {},
    { ...completeBuild(), COMMIT: "invalid" },
    { ...completeBuild(), REPOSITORY: "bad repo" },
    { ...completeBuild(), CHANNEL: "" },
  ])("unknown or incomplete metadata returns 503", async (build) => {
    const app = appWithBuild(build);
    const response = await app.request("/release");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Build release identity is unavailable",
    });
  });
  test("request headers and query parameters cannot supply release identity", async () => {
    const app = appWithBuild({});
    expect(
      (
        await app.request("/release?version=v0.3.0", {
          headers: { "x-openbot-build-version": "v0.3.0" },
        })
      ).status,
    ).toBe(503);
  });
});
