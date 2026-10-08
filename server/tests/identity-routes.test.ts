import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { openGithubState } from "../src/identity/github-oauth";
import {
  type IdentityRouteOptions,
  identityRoutes,
} from "../src/identity/routes";
import type { IdentityLink } from "../src/identity/types";

const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "person",
    email: "p@example.com",
    role: "user",
  } as never);
  await next();
};
const link: IdentityLink = {
  id: "link-1",
  provider: "github",
  realm: "github.com",
  subject: "42",
  userId: "person",
  handle: "dana",
  verifiedBy: "oauth",
  credentialId: "secret-credential-id",
  status: "active",
  createdAt: new Date("2026-10-08T00:00:00Z"),
  updatedAt: new Date("2026-10-08T00:00:00Z"),
};

function fixture(removedProvider = "github", options?: IdentityRouteOptions) {
  const calls: string[] = [];
  const events: AuditEventInput[] = [];
  const issued: [string, string][] = [];
  const app = identityRoutes(
    signedIn,
    {
      identitiesFor: async (userId) => (userId === "person" ? [link] : []),
      unlink: async (userId, id) => {
        calls.push(`unlink:${userId}:${id}`);
        return userId === "person" && id === "link-1"
          ? { provider: removedProvider }
          : null;
      },
      issueChallenge: async (userId, provider) => {
        issued.push([userId, provider]);
        return {
          code: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          expiresAt: new Date("2026-10-08T00:10:00Z"),
        };
      },
    },
    { insert: async (event) => void events.push(event) },
    options,
  );
  return { app, calls, events, issued };
}

test("links lists the asker's links without subject, realm or credential", async () => {
  const response = await fixture().app.request("/links");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { links: Record<string, unknown>[] };
  expect(body.links).toEqual([
    {
      id: "link-1",
      provider: "github",
      title: "GitHub",
      handle: "dana",
      status: "active",
      createdAt: "2026-10-08T00:00:00.000Z",
    },
  ]);
  expect(JSON.stringify(body)).not.toContain("secret-credential-id");
});

test("DELETE of the asker's own link is 204", async () => {
  const f = fixture();
  expect(
    (await f.app.request("/links/link-1", { method: "DELETE" })).status,
  ).toBe(204);
  expect(f.calls).toEqual(["unlink:person:link-1"]);
});

test("DELETE of another person's link is a tagged 404", async () => {
  const response = await fixture().app.request("/links/someone-elses", {
    method: "DELETE",
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: "Linked account not found.",
    code: "identity_link_not_found",
  });
});

test("the chat-started confirmation routes are gone", async () => {
  const f = fixture();
  for (const path of ["/challenges/peek", "/challenges/confirm"]) {
    const response = await f.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "a".repeat(43) }),
    });
    expect(response.status).toBe(404);
  }
});

test("responses are not cached", async () => {
  const response = await fixture().app.request("/links");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("without a store every route is 503", async () => {
  const app = identityRoutes(signedIn);
  const response = await app.request("/links");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "Linked accounts are not available.",
    code: "identity_unavailable",
  });
  const removal = await app.request("/links/x", { method: "DELETE" });
  expect(removal.status).toBe(503);
  expect((await removal.json()).code).toBe("identity_unavailable");
});

test("auth runs before the missing-store 503 and responses are never cached", async () => {
  const app = identityRoutes(async (context) =>
    context.json({ error: "Sign in." }, 401),
  );
  const response = await app.request("/links");
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("a successful DELETE records one event naming actor, link and provider only", async () => {
  const f = fixture();
  await f.app.request("/links/link-1", { method: "DELETE" });
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({
    eventType: "identity.unlinked",
    targetId: "link-1",
    actorUserId: "person",
    payload: { actor: "person", provider: "github" },
  });
  const text = JSON.stringify(f.events[0]);
  for (const secret of ["secret-credential-id", "github.com", "42"])
    expect(text).not.toContain(`"${secret}"`);
});

test("a 404 DELETE records nothing", async () => {
  const f = fixture();
  await f.app.request("/links/someone-elses", { method: "DELETE" });
  expect(f.events).toEqual([]);
});

test("the audit names the provider the store removed, even one outside the registry", async () => {
  const f = fixture("retired-provider");
  expect(
    (await f.app.request("/links/link-1", { method: "DELETE" })).status,
  ).toBe(204);
  expect(f.events).toHaveLength(1);
  expect(f.events[0]?.payload).toEqual({
    actor: "person",
    provider: "retired-provider",
  });
});

const github = {
  clientId: "Iv1.x",
  publicUrl: "https://o.test",
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

test("GET /providers reports which account types can be linked", async () => {
  const cases: [IdentityRouteOptions, { slack: boolean; github: boolean }][] = [
    [{}, { slack: false, github: false }],
    [{ slackLinking: true }, { slack: true, github: false }],
    [{ github }, { slack: false, github: true }],
  ];
  for (const [options, providers] of cases) {
    const response = await fixture("github", options).app.request("/providers");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ providers });
  }
});

test("GET /providers without a store is 503", async () => {
  const response = await identityRoutes(signedIn).request("/providers");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "Linked accounts are not available.",
    code: "identity_unavailable",
  });
});

function postChallenge(app: ReturnType<typeof fixture>["app"], body: string) {
  return app.request("/challenges", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("POST /challenges issues a Slack link code", async () => {
  const f = fixture("github", { slackLinking: true });
  const response = await postChallenge(f.app, '{"provider":"slack"}');
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    challenge: { code: string; expiresAt: string; instruction: string };
  };
  expect(body.challenge.code).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  expect(body.challenge.expiresAt).toBe("2026-10-08T00:10:00.000Z");
  expect(body.challenge.instruction).toContain(
    "link aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  expect(f.issued).toEqual([["person", "slack"]]);
});

test("POST /challenges is 404 unless Slack linking is on", async () => {
  for (const options of [undefined, {}, { slackLinking: false }]) {
    const f = fixture("github", options);
    const response = await postChallenge(f.app, '{"provider":"slack"}');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: expect.any(String),
      code: "identity_provider_unavailable",
    });
    expect(f.issued).toEqual([]);
  }
});

test("POST /challenges rejects any other body", async () => {
  for (const raw of [
    '{"provider":"github"}',
    '{"provider":"slack","x":1}',
    "not json",
  ]) {
    const f = fixture("github", { slackLinking: true });
    const response = await postChallenge(f.app, raw);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Choose an account type to link.",
      code: "identity_invalid_request",
    });
    expect(f.issued).toEqual([]);
  }
});

test("POST /challenges without a store is 503", async () => {
  const response = await postChallenge(
    identityRoutes(signedIn, undefined, undefined, { slackLinking: true }),
    '{"provider":"slack"}',
  );
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe("identity_unavailable");
});

const githubKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const githubOptions = {
  github: {
    clientId: "Iv1.x",
    publicUrl: "https://o.test",
    encryptionKey: githubKey,
  },
};

test("POST /github/connect returns the GitHub authorization URL for the asker", async () => {
  const response = await fixture("github", githubOptions).app.request(
    "/github/connect",
    { method: "POST" },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    connect: { authorizationUrl: string };
  };
  const url = new URL(body.connect.authorizationUrl);
  expect(url.origin + url.pathname).toBe(
    "https://github.com/login/oauth/authorize",
  );
  expect(url.searchParams.get("client_id")).toBe("Iv1.x");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://o.test/api/identity/github/callback",
  );
  expect(
    await openGithubState(url.searchParams.get("state") ?? "", githubKey),
  ).toEqual({ userId: "person" });
});

test("POST /github/connect is 404 unless GitHub is configured", async () => {
  const f = fixture("github");
  const response = await f.app.request("/github/connect", { method: "POST" });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: expect.any(String),
    code: "identity_provider_unavailable",
  });
});

test("POST /github/connect without a store is 503", async () => {
  const response = await identityRoutes(
    signedIn,
    undefined,
    undefined,
    githubOptions,
  ).request("/github/connect", { method: "POST" });
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe("identity_unavailable");
});
