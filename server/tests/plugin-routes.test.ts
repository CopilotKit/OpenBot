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

/**
 * Granting one Bot to another, through the API an administrator actually has.
 *
 * The grant table gained a `bot` kind and the store learned it, but these two endpoints did not.
 * Revoke rejected it outright, so enabling the capability meant writing a row by hand and revoking
 * it was not possible at all — while the design says a revoked grant applies to the very next hop.
 *
 * `kind` also arrives in a JSON body, so a type annotation on it is a comment. It is checked here.
 */
function grantsApp(
  role: "admin" | "user" = "admin",
  runsHere: (agentId: string) => boolean | undefined = (agentId) => {
    // Undefined is "no such Bot", which is what the store answers for one nobody registered.
    if (agentId === "never-registered") return undefined;
    return agentId !== "at-an-endpoint";
  },
) {
  const calls: Array<{ verb: string; kind: string; ref: string }> = [];
  const store = {
    listServers: async () => [],
    listSkills: async () => [],
    listGrants: async () => [],
    grant: async (kind: string, ref: string) => {
      calls.push({ verb: "grant", kind, ref });
    },
    revoke: async (kind: string, ref: string) => {
      calls.push({ verb: "revoke", kind, ref });
    },
    skillOwner: async () => null,
    agentOwner: async () => null,
    agentRunsHere: async (agentId: string) => runsHere(agentId),
    agentIsRegistered: async (agentId: string) =>
      agentId !== "never-registered",
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );

  return { calls, app };
}

describe("granting one Bot to another", () => {
  test("an administrator can grant it", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "assistant",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ verb: "grant", kind: "bot", ref: "knowledge" }]);
  });

  /*
   * The half that was missing entirely. "Nothing about who may address whom is cached in a process"
   * is only true if there is a way to stop it.
   */
  test("and revoke it again", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants?kind=bot&ref=knowledge&agentId=assistant",
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ verb: "revoke", kind: "bot", ref: "knowledge" }]);
  });

  /*
   * It lets one Bot spend another's model calls, wake its computer and reach whatever that Bot may
   * reach. That is not an instruction somebody attaches to a coworker they own.
   */
  test("somebody who is not an administrator cannot", async () => {
    const { calls, app } = grantsApp("user");

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "assistant",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error:
        "An administrator decides which Bots may hand work to another Bot.",
    });
    expect(calls).toEqual([]);
  });

  test("a kind nobody defined is refused rather than written", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "anything",
          ref: "x",
          agentId: "assistant",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

/**
 * A grant that could never do anything.
 *
 * Handing work to another Bot is a tool this deployment executes, so it can only be offered to a run
 * this deployment builds. A Bot at its own endpoint runs its own loop and is handed descriptions of
 * what it may call back for; there is no callback path that would execute a hop. Stored anyway, the
 * grant reads as configured and nothing ever happens.
 */
describe("granting a hop to a Bot that runs somewhere else", () => {
  test("is refused, and says why", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "at-an-endpoint",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("its own endpoint");
    expect(calls).toEqual([]);
  });

  test("a Bot nobody has heard of is refused too", async () => {
    // Undefined is "no such Bot", which must not read as "runs somewhere else" or as permission.
    const { calls, app } = grantsApp("admin", () => undefined);

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "never-registered",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("There is no such Bot.");
    expect(calls).toEqual([]);
  });

  test("a Bot that does run here is granted as before", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "knowledge",
          agentId: "general-assistant",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ verb: "grant", kind: "bot", ref: "knowledge" }]);
  });
});

/**
 * What a refusal tells somebody who is not an administrator.
 *
 * This route only requires a signed-in user. Checking whether a Bot exists, and whether it runs
 * here, before checking the role handed out three distinguishable 403s and turned the refusal into
 * an oracle for other people's private Bots — the exact property `handoff.ts` collapses on purpose.
 */
describe("what a bot grant refusal reveals", () => {
  const refusalFor = async (
    agentId: string,
    role: "admin" | "user",
    ref = "knowledge",
  ) => {
    const { calls, app } = grantsApp(role);
    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "bot", ref, agentId }),
      },
    );
    return { status: response.status, body: await response.json(), calls };
  };

  test("a non-administrator gets one answer, whatever the Bot is", async () => {
    const said = new Set<string>();
    for (const agentId of [
      "general-assistant",
      "at-an-endpoint",
      "never-registered",
    ]) {
      const { status, body, calls } = await refusalFor(agentId, "user");
      expect(status).toBe(403);
      expect(calls).toEqual([]);
      said.add(body.error);
    }
    // One sentence for all three, so nothing distinguishes "exists" from "does not".
    expect(said.size).toBe(1);
    expect([...said][0]).toBe(
      "An administrator decides which Bots may hand work to another Bot.",
    );
  });

  test("an administrator still gets the reason", async () => {
    expect((await refusalFor("at-an-endpoint", "admin")).body.error).toContain(
      "its own endpoint",
    );
    expect((await refusalFor("never-registered", "admin")).body.error).toBe(
      "There is no such Bot.",
    );
  });

  /*
   * The target is bare text with no foreign key. A typo stored happily, `message_bot` was offered,
   * and every hop then refused as not-granted.
   */
  test("a target nobody has heard of is refused", async () => {
    const { status, body, calls } = await refusalFor(
      "general-assistant",
      "admin",
      "never-registered",
    );
    expect(status).toBe(403);
    expect(body.error).toContain("no Bot called never-registered");
    expect(calls).toEqual([]);
  });
});

/*
 * The desk refuses a self-hop outright — "a Bot cannot hand work to itself" — so a grant of a Bot to
 * itself is dead the moment it is written, and reads as configured.
 */
describe("granting a Bot itself", () => {
  test("is refused rather than stored", async () => {
    const { calls, app } = grantsApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/grants",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "bot",
          ref: "general-assistant",
          agentId: "general-assistant",
        }),
      },
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain("cannot be granted itself");
    expect(calls).toEqual([]);
  });
});
