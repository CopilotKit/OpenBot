import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const SESSION = {
  user: {
    id: "person",
    email: "person@openbot.test",
    name: "Person",
    image: null,
  },
};

const GITHUB_ENVIRONMENT = {
  GITHUB_APP_CLIENT_ID: "Iv1.x",
  GITHUB_APP_CLIENT_SECRET: "s",
  OPENBOT_PUBLIC_URL: "https://api.test",
  OPENBOT_APP_URL: "https://app.test",
};

/** Builds the app with only what the identity routes need; later tests can extend the options. */
function appFor(
  environment: Record<string, string | undefined>,
  options: { session?: typeof SESSION | null; coworker?: unknown } = {},
) {
  const session = options.session === undefined ? SESSION : options.session;
  const identity = {
    identitiesFor: async () => [],
    unlink: async () => false,
    issueChallenge: async () => ({ code: "code", expiresAt: new Date() }),
  };
  return createApp(
    loadConfig(testEnvironment(environment)),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => session },
    } as never,
    { rolesForUser: async () => ["user"] },
    ...(Array.from({ length: 9 }) as never[]),
    undefined as never,
    ...(Array.from({ length: 21 }) as never[]),
    options.coworker as never,
    undefined as never,
    identity as never,
  );
}

test("identity routes require a session", async () => {
  const response = await appFor(GITHUB_ENVIRONMENT, {
    session: null,
  }).request("http://openbot.test/api/identity/providers");
  expect(response.status).toBe(401);
});

test("GitHub is offered when the app and a public URL are configured", async () => {
  const response = await appFor(GITHUB_ENVIRONMENT).request(
    "http://openbot.test/api/identity/providers",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    providers: { slack: false, github: true },
  });
});

test("connecting GitHub redirects back to this deployment's callback", async () => {
  const response = await appFor(GITHUB_ENVIRONMENT).request(
    "http://openbot.test/api/identity/github/connect",
    { method: "POST" },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    connect: { authorizationUrl: string };
  };
  const url = new URL(body.connect.authorizationUrl);
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://api.test/api/identity/github/callback",
  );
});

test("without a GitHub app, GitHub is not offered and cannot be connected", async () => {
  const app = appFor({});
  const providers = await app.request(
    "http://openbot.test/api/identity/providers",
  );
  expect(await providers.json()).toEqual({
    providers: { slack: false, github: false },
  });
  const connect = await app.request(
    "http://openbot.test/api/identity/github/connect",
    { method: "POST" },
  );
  expect(connect.status).toBe(404);
});
