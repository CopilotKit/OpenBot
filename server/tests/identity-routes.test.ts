import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { identityRoutes } from "../src/identity/routes";
import { type IdentityLink, IdentityLinkError } from "../src/identity/types";

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
const token = "a".repeat(43);
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

function fixture() {
  const calls: string[] = [];
  const app = identityRoutes(signedIn, {
    identitiesFor: async (userId) => (userId === "person" ? [link] : []),
    unlink: async (userId, id) => {
      calls.push(`unlink:${userId}:${id}`);
      return userId === "person" && id === "link-1";
    },
    peekChallenge: async (t) =>
      t === token ? { provider: "slack", handle: "dana" } : null,
    confirmChallenge: async (t, userId) => {
      calls.push(`confirm:${userId}`);
      if (t !== token) throw new IdentityLinkError();
    },
  });
  return { app, calls };
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

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

test("DELETE of another person's link is 404", async () => {
  expect(
    (await fixture().app.request("/links/someone-elses", { method: "DELETE" }))
      .status,
  ).toBe(404);
});

test("peek names the provider of a live challenge", async () => {
  const response = await fixture().app.request(
    "/challenges/peek",
    post({ token }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    challenge: { provider: "slack", title: "Slack", handle: "dana" },
  });
});

test("peek of an expired token is 404", async () => {
  const response = await fixture().app.request(
    "/challenges/peek",
    post({ token: "b".repeat(43) }),
  );
  expect(response.status).toBe(404);
});

test("confirm records the signed-in user and returns the provider's hint", async () => {
  const f = fixture();
  const response = await f.app.request("/challenges/confirm", post({ token }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { confirmation: { hint: string } };
  expect(body.confirmation.hint).toContain(`/link ${token}`);
  expect(f.calls).toEqual(["confirm:person"]);
});

test("confirm of a bad token is 409 with a sentence, and a malformed body is 400", async () => {
  const f = fixture();
  const bad = await f.app.request(
    "/challenges/confirm",
    post({ token: "c".repeat(43) }),
  );
  expect(bad.status).toBe(409);
  expect(((await bad.json()) as { error: string }).error).toContain("expired");
  expect((await f.app.request("/challenges/confirm", post({}))).status).toBe(
    400,
  );
});

test("confirm surfaces an unexpected failure instead of answering 409", async () => {
  const app = identityRoutes(signedIn, {
    identitiesFor: async () => [],
    unlink: async () => false,
    peekChallenge: async () => ({ provider: "slack", handle: "dana" }),
    confirmChallenge: async () => {
      throw new Error("db down");
    },
  });
  const response = await app.request("/challenges/confirm", post({ token }));
  expect(response.status).not.toBe(409);
  expect(response.status).toBe(500);
});

test("responses are not cached", async () => {
  const response = await fixture().app.request("/links");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("without a store every route is 503", async () => {
  const app = identityRoutes(signedIn);
  expect((await app.request("/links")).status).toBe(503);
});
