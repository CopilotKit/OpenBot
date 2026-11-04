import { describe, expect, test } from "bun:test";
import { createDevRequireUser, DEV_ACTOR } from "../src/auth/dev-actor";
import { createProfileRoutes, type ProfileStore } from "../src/people/profile";

function setup() {
  const writes: { userId: string; name: string }[] = [];
  const store: ProfileStore = {
    read: async () => ({ name: "", needsName: true }),
    save: async (userId, name) => {
      writes.push({ userId, name });
      return { name, needsName: false };
    },
  };
  const app = createProfileRoutes(createDevRequireUser(), store);
  const patch = (body: unknown) =>
    app.request("/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { patch, writes };
}

describe("profile updates", () => {
  test("saves the trimmed name for the authenticated identity", async () => {
    const { patch, writes } = setup();
    const response = await patch({ name: "  Sam Julien  " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profile: { name: "Sam Julien", needsName: false },
    });
    expect(writes).toEqual([{ userId: DEV_ACTOR.id, name: "Sam Julien" }]);
  });
  test.each([
    { name: "   " },
    { name: "x".repeat(101) },
    { name: 7 },
    { name: "Sam", id: "another-user" },
    { name: "Sam", email: "new@example.test" },
  ])("rejects invalid names and identity changes: %j", async (body) => {
    const { patch, writes } = setup();
    expect((await patch(body)).status).toBe(400);
    expect(writes).toEqual([]);
  });
  test("reports unavailable storage without pretending to save", async () => {
    const app = createProfileRoutes(createDevRequireUser());
    expect(
      (
        await app.request("/", {
          method: "PATCH",
          body: JSON.stringify({ name: "Sam" }),
        })
      ).status,
    ).toBe(503);
  });
});
