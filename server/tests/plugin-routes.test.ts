import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
} from "../src/plugins/store";
import { testEnvironment } from "./support/environment";

/**
 * What a refused add looks like to the administrator who made it.
 *
 * The store's refusals are tested where they are decided. What is worth pinning here is the mapping,
 * because an unmapped throw leaves the route on its default path: the refusal becomes a 500, the
 * screen says something went wrong, and a correctable mistake reads as a broken deployment. The
 * curated route mapped one refusal and not the other, which is exactly the shape that is invisible
 * until somebody hits it.
 */

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

function appWith(
  addServer: () => Promise<never>,
  role: "admin" | "user" = "admin",
) {
  const store = {
    addServer,
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => [],
    listSkills: async () => [],
    listGrants: async () => [],
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );

  return (body: unknown) =>
    app.request("http://openbot.test/api/plugins/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

describe("adding a curated server", () => {
  test("a refused credential comes back as a refusal with its reason", async () => {
    const request = appWith(async () => {
      throw new CustomServerRefusedError(
        "That is not a credential this server can use. Add the server's own token instead.",
      );
    });

    const response = await request({
      key: "google-drive",
      credentialId: "11111111-1111-1111-1111-111111111111",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "That is not a credential this server can use. Add the server's own token instead.",
    });
  });

  test("an unknown catalogue key still comes back the same way", async () => {
    const request = appWith(async () => {
      throw new CatalogueEntryUnknownError("nope");
    });

    expect((await request({ key: "nope" })).status).toBe(400);
  });

  test("a failure that is not a refusal is not dressed up as one", async () => {
    // The must-not case. Mapping every throw to 400 would tell an administrator to correct their
    // input when the database is down, and would hide a real fault behind a message about
    // credentials.
    const request = appWith(async () => {
      throw new Error("the database is unreachable");
    });

    expect((await request({ key: "google-drive" })).status).toBe(500);
  });

  test("somebody who is not an administrator cannot add one at all", async () => {
    const request = appWith(async () => {
      throw new Error("the store must not be reached");
    }, "user");

    expect((await request({ key: "google-drive" })).status).toBe(403);
  });
});
