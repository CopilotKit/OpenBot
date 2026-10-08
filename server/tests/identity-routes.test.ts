import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { identityRoutes } from "../src/identity/routes";
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

function fixture() {
  const calls: string[] = [];
  const app = identityRoutes(signedIn, {
    identitiesFor: async (userId) => (userId === "person" ? [link] : []),
    unlink: async (userId, id) => {
      calls.push(`unlink:${userId}:${id}`);
      return userId === "person" && id === "link-1";
    },
  });
  return { app, calls };
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

test("DELETE of another person's link is 404", async () => {
  expect(
    (await fixture().app.request("/links/someone-elses", { method: "DELETE" }))
      .status,
  ).toBe(404);
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
  expect((await app.request("/links")).status).toBe(503);
});

test("auth runs before the missing-store 503 and responses are never cached", async () => {
  const app = identityRoutes(async (context) =>
    context.json({ error: "Sign in." }, 401),
  );
  const response = await app.request("/links");
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
