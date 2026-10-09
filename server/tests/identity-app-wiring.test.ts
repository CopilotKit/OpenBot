import { expect, mock, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { githubCallbackRoutes } from "../src/identity/github-callback";
import { sealGithubState } from "../src/identity/github-oauth";
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
  options: {
    session?: typeof SESSION | null;
    coworker?: unknown;
    githubCallback?: unknown;
  } = {},
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
    options.githubCallback as never,
  );
}

/** A real GitHub callback router whose every dependency is a fake; the fetch stub records any call. */
function callbackFor(environment: Record<string, string | undefined>) {
  const fetchImpl = mock(async () => new Response("{}", { status: 500 }));
  const encryptionKey = loadConfig(
    testEnvironment(environment),
  ).keyEncryptionKey;
  const router = githubCallbackRoutes({
    clientId: "Iv1.x",
    clientSecret: "s",
    publicUrl: "https://api.test",
    appUrl: "https://app.test",
    encryptionKey,
    personIsActive: async () => true,
    credentials: {
      create: async () => {
        throw new Error("unexpected");
      },
      rotate: async () => {
        throw new Error("unexpected");
      },
      revoke: async () => undefined,
      findLiveByKey: async () => undefined,
    } as never,
    identity: {
      linkVerified: async () => {
        throw new Error("unexpected");
      },
    } as never,
    fetchImpl: fetchImpl as never,
  });
  return { router, fetchImpl, encryptionKey };
}

test("identity routes require a session", async () => {
  const response = await appFor(GITHUB_ENVIRONMENT, {
    session: null,
  }).request("http://openbot.test/api/identity/providers");
  expect(response.status).toBe(401);
});

test("GitHub is offered when the app and a public URL are configured", async () => {
  const response = await appFor(GITHUB_ENVIRONMENT, {
    githubCallback: callbackFor(GITHUB_ENVIRONMENT).router,
  }).request("http://openbot.test/api/identity/providers");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    providers: { slack: false, github: true },
  });
});

test("connecting GitHub redirects back to this deployment's callback", async () => {
  const response = await appFor(GITHUB_ENVIRONMENT, {
    githubCallback: callbackFor(GITHUB_ENVIRONMENT).router,
  }).request("http://openbot.test/api/identity/github/connect", {
    method: "POST",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    connect: { authorizationUrl: string };
  };
  const url = new URL(body.connect.authorizationUrl);
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://api.test/api/identity/github/callback",
  );
});

test("configured GitHub is not offered while its callback is not mounted", async () => {
  const app = appFor(GITHUB_ENVIRONMENT);
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

async function slackOffered(webhooks: Record<string, unknown>) {
  const response = await appFor(
    {},
    { coworker: { delivery: { webhooks } } },
  ).request("http://openbot.test/api/identity/providers");
  const body = (await response.json()) as { providers: { slack: boolean } };
  return body.providers.slack;
}

test("Slack linking needs both the Slack webhook and the identity redeemer", async () => {
  const handler = async () => new Response(null, { status: 204 });
  expect(await slackOffered({ slack: handler })).toBe(false);
  expect(await slackOffered({ identity: handler })).toBe(false);
  expect(await slackOffered({ slack: handler, identity: handler })).toBe(true);
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

test("the GitHub callback without a session answers 401 and never reaches GitHub", async () => {
  const { router, fetchImpl, encryptionKey } = callbackFor(GITHUB_ENVIRONMENT);
  const state = await sealGithubState("person", encryptionKey);
  const response = await appFor(GITHUB_ENVIRONMENT, {
    session: null,
    githubCallback: router,
  }).request(
    `http://openbot.test/api/identity/github/callback?code=c&state=${encodeURIComponent(state)}`,
  );
  expect(response.status).toBe(401);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("the GitHub callback is reachable with a session and redirects to the app", async () => {
  const { router, fetchImpl, encryptionKey } = callbackFor(GITHUB_ENVIRONMENT);
  const state = await sealGithubState("person", encryptionKey);
  const response = await appFor(GITHUB_ENVIRONMENT, {
    githubCallback: router,
  }).request(
    `http://openbot.test/api/identity/github/callback?error=access_denied&state=${encodeURIComponent(state)}`,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "https://app.test/settings/connected-accounts?linked=failed",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});

/** A real callback router whose GitHub is a stub that answers the token exchange and GET /user. */
function workingCallbackFor(environment: Record<string, string | undefined>) {
  const fetchImpl = mock(async (url: string | URL | Request) =>
    String(url).includes("access_token")
      ? Response.json({
          access_token: "gho_wired",
          refresh_token: "gho_wired-refresh",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        })
      : Response.json({ id: 4242, login: "octo" }),
  );
  const linkVerified = mock(async () => ({ id: "link-1" }));
  const audited: unknown[] = [];
  const encryptionKey = loadConfig(
    testEnvironment(environment),
  ).keyEncryptionKey;
  const router = githubCallbackRoutes({
    clientId: "Iv1.x",
    clientSecret: "s",
    publicUrl: "https://api.test",
    appUrl: "https://app.test",
    encryptionKey,
    personIsActive: async () => true,
    credentials: {
      create: async () => ({ id: "credential-1" }),
      revoke: async () => undefined,
    } as never,
    identity: { linkVerified } as never,
    auditStore: { insert: async (event: unknown) => void audited.push(event) },
    fetchImpl: fetchImpl as never,
  });
  return { router, fetchImpl, linkVerified, audited, encryptionKey };
}

test("the signed-in person's session reaches the callback and completes the link", async () => {
  const { router, fetchImpl, linkVerified, audited, encryptionKey } =
    workingCallbackFor(GITHUB_ENVIRONMENT);
  const state = await sealGithubState("person", encryptionKey);
  const response = await appFor(GITHUB_ENVIRONMENT, {
    githubCallback: router,
  }).request(
    `http://openbot.test/api/identity/github/callback?code=c&state=${encodeURIComponent(state)}`,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "https://app.test/settings/connected-accounts?linked=github",
  );
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(linkVerified).toHaveBeenCalledTimes(1);
  expect((linkVerified.mock.calls[0] as unknown[])[1]).toBe("person");
  expect(audited).toHaveLength(1);
});

test("a session for a different person than the state's fails and never reaches GitHub", async () => {
  const { router, fetchImpl, linkVerified, encryptionKey } =
    workingCallbackFor(GITHUB_ENVIRONMENT);
  const state = await sealGithubState("someone-else", encryptionKey);
  const response = await appFor(GITHUB_ENVIRONMENT, {
    githubCallback: router,
  }).request(
    `http://openbot.test/api/identity/github/callback?code=c&state=${encodeURIComponent(state)}`,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "https://app.test/settings/connected-accounts?linked=failed",
  );
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(linkVerified).not.toHaveBeenCalled();
});
