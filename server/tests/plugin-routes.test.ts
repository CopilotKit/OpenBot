import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import { loadConfig } from "../src/config";
import { ServerRowAmbiguousError } from "../src/plugins/access";
import {
  type BrokerApp,
  type BrokerConnection,
  type BrokerField,
  BrokerRefusalError,
} from "../src/plugins/broker";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  PluginInvariantError,
  PluginRefusedError,
  type PluginStore,
  type ServerRecord,
} from "../src/plugins/store";
import { testEnvironment } from "./support/environment";

/**
 * The handful of reads one route makes, typed against the store that really answers them.
 *
 * ONE CAST, IN ONE PLACE, WITH ITS INPUT CHECKED. A route test supplies four or five methods where
 * the real store has ninety, so something has to widen the handful into the parameter's type. Every
 * call site here used to spell that as `store as never`, and `never` widens the METHODS along with
 * the object: a stub whose `brokeredConnectionsFor` answered three fields where the real one
 * answers seven typechecked in silence, and every assertion above it then passed whether or not the
 * route carried the other four. `Partial<PluginStore>` is the same widening with the signatures
 * kept, so a stub that answers a shape the real store cannot is a compile error here rather than a
 * green test.
 *
 * AND THE FILLERS BELOW HAD TO GO WITH IT, which is the half that looks unrelated and is not.
 * `createApp` takes thirty positional stores, and the spread that skipped to the fifteenth was
 * an array of unknown LENGTH — so TypeScript had no idea which parameter the store landed on and
 * checked it against the next one in the signature. Typing the store without fixing that only moves
 * the silence: see {@link UP_TO_PLUGIN_STORE}.
 */
function pluginStore(reads: Partial<PluginStore>): PluginStore {
  return reads as PluginStore;
}

/**
 * `createApp`'s positions 4-14, which no test on this surface supplies.
 *
 * A FIXED-LENGTH TUPLE RATHER THAN `Array.from({ length: 11 }) as never[]`, which is what every
 * call site here spread before. An array whose length TypeScript does not know tells it nothing
 * about which parameter the argument AFTER it lands on, so the plugin store was being checked
 * against position 5 — `credentialService` — and the `as never` on it is the only reason that was
 * quiet. With the length written down, the store is checked against `pluginStore`, which is the
 * whole point of typing it at all.
 */
const UP_TO_PLUGIN_STORE = [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
] as const;

/** `createApp`'s positions 16-29, between the plugin store and the broker. See {@link UP_TO_PLUGIN_STORE}. */
const UP_TO_BROKER = [
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
] as const;

/** One row of what {@link PluginStore.connectionsFor} answers: this deployment's own vault. */
type HeldConnection = Awaited<
  ReturnType<PluginStore["connectionsFor"]>
>[number];

/**
 * One row of what {@link PluginStore.brokeredConnectionsFor} answers.
 *
 * Spelled as the store's own return type rather than re-typed here, because the four fields this
 * read adds over {@link HeldConnection} — `verified`, `verifiedAt`, `probe`, `checkable` — are the
 * whole of the verification surface, and a fixture free to omit them is a fixture that cannot tell
 * whether the route carries them.
 */
type BrokeredConnection = Awaited<
  ReturnType<PluginStore["brokeredConnectionsFor"]>
>[number];

/**
 * A server row as the store really answers one, from the two columns a test cares about.
 *
 * FIFTEEN FIELDS BECAUSE THE STORE ANSWERS FIFTEEN. The stubs here used to hand back `{ id, url }`,
 * which is not a row any deployment can produce — and a route reaching for `authScheme` or `tools`
 * on it would find `undefined` and behave in a way no real store could reproduce. The values are
 * the empty ones on purpose: nothing on these routes reads them, and a fixture that invented
 * interesting ones would be inviting an assertion about a fact it made up.
 */
function serverRecord(row: { id: string; url: string }): ServerRecord {
  return {
    id: row.id,
    title: row.id,
    vendor: "composio",
    url: row.url,
    summary: "",
    docsUrl: "",
    provenance: "custom",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    authScheme: null,
    tools: [],
    withdrawn: [],
  };
}

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
  const store = pluginStore({
    addServer,
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => [],
    listSkills: async () => [],
  });

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...UP_TO_PLUGIN_STORE,
    store,
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

  test("a row the deployment cannot resolve comes back with its sentence", async () => {
    /*
     * ADDING REFRESHES, which is what puts this fault on this route.
     *
     * `addServer` asks the vendor what it offers before it answers — deliberately, so a bad
     * credential is reported now rather than the first time a Bot uses one — so everything
     * `refreshTools` raises arrives here as well: a vendor listing one action twice, a query of
     * ours failing, a row whose two columns contradict each other. Unmapped, all of it left the
     * route on the default path and the admin page said "That did not work", while the SAME fault
     * on the refresh button said which row and what to do about it.
     */
    const sentence =
      "notion: the actions this app listed were not stored, so what it already had is unchanged.";
    const request = appWith(async () => {
      throw new PluginInvariantError(sentence);
    });

    const response = await request({ key: "notion" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: sentence });
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
 * What a refresh that cannot be resolved at all looks like to the administrator who pressed it.
 *
 * CRITERION. A contradiction between two of this deployment's own columns comes back with a body
 * that names the row and says what to correct, on this route and only on this route.
 *
 * REASON. `ServerRowAmbiguousError` was mapped nowhere, so it left the route on the framework's
 * default path: a 500 whose body is not JSON, which the admin client turns into its fallback
 * sentence — "That did not work" — having found no `error` field to read. The one refusal that
 * names exactly which row is wrong was the one an operator could not see, while the same sentence
 * was reaching a model on the tool-call path. This route is admin-gated, which is what makes
 * showing it here the right answer and showing it anywhere else the wrong one.
 */
function refreshApp(
  refreshTools: () => Promise<never>,
  role: "admin" | "user" = "admin",
) {
  const store = pluginStore({
    refreshTools,
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => [],
    listSkills: async () => [],
  });

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...UP_TO_PLUGIN_STORE,
    store,
  );

  return () =>
    app.request("http://openbot.test/api/plugins/servers/notion/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
}

describe("refreshing a server that cannot be resolved", () => {
  test("the administrator is told which row and what to do about it", async () => {
    const sentence =
      "notion is a server this deployment ships an entry for, and a row with that id says its " +
      "provenance is composio. Rename it, or correct its provenance.";
    const request = refreshApp(async () => {
      throw new ServerRowAmbiguousError(sentence);
    });

    const response = await request();

    // 409 rather than 500: nothing broke and nothing about the request was malformed. Two rows
    // disagree, and the request cannot be answered until one of them changes.
    expect(response.status).toBe(409);
    // A body at all is the fix. Unmapped, this was a 500 carrying no JSON, and the page said
    // "That did not work" because that is what it says when it finds no message.
    expect(await response.json()).toEqual({ error: sentence });
  });

  test("a failed query comes back as the reason, never as the statement", async () => {
    /*
     * The shape drizzle throws: `Failed query:` plus the whole statement, then `params:` and every
     * value bound to it, with the driver's own error on `cause`. It is on the same shelf as the
     * refusals above — not a vendor's doing, not the asker's to act on — so this route is where an
     * operator is told about it, and it is the one member of that shelf whose `message` must not be
     * what they are told.
     */
    const request = refreshApp(async () => {
      throw Object.assign(
        new Error(
          'Failed query: select "credential_id" from "mcp_user_credentials" where "user_id" = $1 params: someone',
        ),
        {
          query: 'select "credential_id" from "mcp_user_credentials"',
          params: ["someone"],
          cause: new Error("canceling statement due to statement timeout"),
        },
      );
    });

    const response = await request();
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: string };
    // The reason, which is what an administrator can act on.
    expect(body.error).toContain(
      "canceling statement due to statement timeout",
    );
    // And none of the query. This route answers an administrator, but the browser it answers is
    // still on somebody's laptop and the sentence still ends up in a screenshot and a ticket.
    expect(body.error).not.toContain("Failed query");
    expect(body.error).not.toContain("params:");
    expect(body.error).not.toContain("mcp_user_credentials");
  });

  test("a failure that is not one of ours is still not dressed up as one", async () => {
    // The must-not case, the same one the add route above carries: a database that is down is not
    // a row an administrator can go and correct, and answering 409 would send them to do it.
    const request = refreshApp(async () => {
      throw new Error("the database is unreachable");
    });

    expect((await request()).status).toBe(500);
  });

  test("somebody who is not an administrator cannot press it at all", async () => {
    const request = refreshApp(async () => {
      throw new Error("the store must not be reached");
    }, "user");

    // Which is what makes showing the sentence above safe: nobody else reaches this route.
    expect((await request()).status).toBe(403);
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
  /**
   * Every write that reached the store, in the shape the store really takes.
   *
   * ALL FOUR ARGUMENTS, WHICH IS NOT A TIDINESS. `grant` and `revoke` take `(kind, ref, agentId,
   * by)`, and this stub used to drop the second half: the row is written against the BOT, so a
   * route that passed the wrong `agentId` would put one Bot's capability on another's row — the
   * grant tested here lets one Bot spend another's model calls and reach whatever that Bot may
   * reach — and `by` is the only name the audit trail has for who did it. Neither was asserted
   * anywhere, so a route that granted the right thing to the wrong Bot under nobody's name passed
   * every test in this file.
   *
   * `by` IS THE SESSION'S AND NEVER THE REQUEST'S, which is the point of asserting it at all: the
   * body below carries a Bot and a ref and no actor, and the trail has to name the administrator
   * whose session made the call.
   */
  const calls: Array<{
    verb: string;
    kind: string;
    ref: string;
    agentId: string;
    by: string;
  }> = [];
  const store = pluginStore({
    listServers: async () => [],
    listSkills: async () => [],
    grant: async (kind: string, ref: string, agentId: string, by: string) => {
      calls.push({ verb: "grant", kind, ref, agentId, by });
    },
    revoke: async (kind: string, ref: string, agentId: string, by: string) => {
      calls.push({ verb: "revoke", kind, ref, agentId, by });
    },
    skillOwner: async () => null,
    agentOwner: async () => null,
    agentRunsHere: async (agentId: string) => runsHere(agentId),
    agentIsRegistered: async (agentId: string) =>
      agentId !== "never-registered",
  });

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    ...UP_TO_PLUGIN_STORE,
    store,
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
    // The Bot named in the body got it, and the trail names the session's administrator: the row is
    // written against the Bot, and `by` is all anybody reading the trail later has. See
    // {@link calls}.
    expect(calls).toEqual([
      {
        verb: "grant",
        kind: "bot",
        ref: "knowledge",
        agentId: "assistant",
        by: ADMIN.email,
      },
    ]);
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
    // Off the Bot the query names, under the session's administrator — the same two facts the grant
    // above asserts, and here they arrive in a query string rather than a body.
    expect(calls).toEqual([
      {
        verb: "revoke",
        kind: "bot",
        ref: "knowledge",
        agentId: "assistant",
        by: ADMIN.email,
      },
    ]);
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
    // A DIFFERENT BOT FROM THE TEST ABOVE, and the assertion says so: this case is about which Bot
    // the route acted on, so a stub that recorded only the kind and the ref would make its two
    // expectations identical and neither of them about the name that differs.
    expect(calls).toEqual([
      {
        verb: "grant",
        kind: "bot",
        ref: "knowledge",
        agentId: "general-assistant",
        by: ADMIN.email,
      },
    ]);
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

/**
 * The app directory an administrator picks a brokered app out of.
 *
 * TWO THINGS ARE BEING PINNED, and they are the two a reader would assume the vendor does for us.
 * The search is ours, because `@composio/core` forwards only category, managed_by, sort_by, cursor
 * and limit and drops a search term without saying so — a forwarded term comes back as an
 * unfiltered first page, which looks exactly like a result. And the slug on a POST is checked
 * against the directory that was just read, because that slug becomes the url every future call
 * for the app runs against.
 *
 * The no-broker answer is a 503 naming the setting rather than an empty list: an empty directory
 * and an absent one are different facts, and only one of them has a remedy.
 */
const DIRECTORY: BrokerApp[] = [
  {
    slug: "slack",
    name: "Slack",
    description: "Post messages and read channels.",
    logo: null,
    categories: ["communication"],
    actionCount: 63,
    connection: { kind: "consent" },
  },
  {
    slug: "gmail",
    name: "Gmail",
    description: "Read and send mail.",
    logo: null,
    categories: ["communication"],
    actionCount: 24,
    connection: { kind: "consent" },
  },
  {
    slug: "linear",
    name: "Linear",
    description: "Track issues.",
    logo: null,
    categories: ["project-management"],
    actionCount: 18,
    connection: { kind: "consent" },
  },
  {
    /*
     * The fourth app is one Composio publishes and this deployment cannot drive: connecting it
     * wants an OAuth application registered by whoever runs the deployment, and there is nowhere
     * here to keep one. Fifty-six of the catalogue's apps are this, which is why the fixture
     * carries one rather than pretending the catalogue is uniform.
     */
    slug: "docusign",
    name: "DocuSign",
    description: "Send documents for signature.",
    logo: null,
    categories: ["documents"],
    actionCount: 31,
    connection: {
      kind: "unsupported",
      reason:
        "DocuSign needs an OAuth application registered by whoever runs this deployment, and this deployment holds no place to put its own OAuth client for a brokered app.",
    },
  },
];

function directoryApp(
  /** Null is a deployment with no COMPOSIO_API_KEY, which is the shipped default. */
  listApps: (() => Promise<typeof DIRECTORY>) | null = async () => DIRECTORY,
  role: "admin" | "user" = "admin",
  /** What this deployment has already added, which is where `enabled` comes from. */
  servers: Array<{ id: string; url: string }> = [],
  /**
   * How enabling fails, for the cases that are about the failing half. Null is the store that
   * works: it records the call and answers a row. Enabling is where the second half of this
   * surface's failures are decided, and none of them could be tested while the only store here
   * succeeded.
   */
  enable: (() => Promise<never>) | null = null,
  /**
   * How the read of what is already enabled fails, for the case that is about that read. Null is
   * the store that works. It sits outside the `try` the vendor call is wrapped in, which is what
   * made it the one store call on this route that nothing answered for.
   */
  failServerUrls: (() => Promise<never>) | null = null,
) {
  const added: Array<{
    slug: string;
    title: string;
    by: string;
    connection: BrokerConnection;
  }> = [];
  /**
   * Which of this store's ID-BEARING reads the route made, in order.
   *
   * THE FIXTURE'S IDS WERE UNREACHABLE WITHOUT THIS, AND AN UNREACHABLE ID IS AN ASSERTION THAT
   * CANNOT FAIL. The rows below have always carried an id that names a different app than their
   * url, to say that `enabled` is decided by the url — but the only method this store exposed was
   * `serverUrls`, which drops the id on the way out, so the route had nothing to read wrongly and
   * the "not by the row's id" half of that test was true of any implementation whatsoever.
   * `listServers` is the read that DOES carry ids, so offering it here is what makes the wrong
   * implementation expressible: a route resolving an app off `id` marks the wrong one enabled and
   * leaves its name in this list.
   */
  const idReads: string[] = [];
  const store = pluginStore({
    // Every read the plugins surface makes on its way to the route under test. The directory asks
    // for urls and is handed urls; `listServers` is here to be left alone. See {@link idReads}.
    serverUrls: async () =>
      failServerUrls ? failServerUrls() : servers.map((server) => server.url),
    listServers: async () => {
      idReads.push("listServers");
      return servers.map(serverRecord);
    },
    listSkills: async () => [],
    addBrokeredApp: async (input: {
      slug: string;
      title: string;
      by: string;
      connection: BrokerConnection;
    }) => {
      if (enable) return enable();
      added.push(input);
      return serverRecord({
        id: `composio-${input.slug}`,
        url: `composio://${input.slug}`,
      });
    },
  });

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...UP_TO_PLUGIN_STORE,
    store,
    // Positions 16-29 are the stores after it; the broker is 30, `composio`.
    ...UP_TO_BROKER,
    listApps ? ({ broker: { listApps } } as never) : undefined,
  );

  return { added, app, idReads };
}

describe("the Composio directory", () => {
  test("a deployment with no broker is told which setting to set", async () => {
    const { app } = directoryApp(null);

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
    );

    // 503 rather than `{ apps: [] }`. An empty directory and an absent one are different facts,
    // and a page shown the empty one draws "no apps available" over a deployment that simply has
    // no key.
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("COMPOSIO_API_KEY");
  });

  test("a search term filters the directory here, not at the vendor", async () => {
    /*
     * `@composio/core` forwards only category, managed_by, sort_by, cursor and limit, and silently
     * drops anything else — so a term handed to their client comes back as an unfiltered first
     * page that reads as a result. The filter is ours, over slug, name and description.
     */
    const { app } = directoryApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps?q=sla",
    );

    expect(response.status).toBe(200);
    expect(
      (await response.json()).apps.map((app: { slug: string }) => app.slug),
    ).toEqual(["slack"]);
  });

  test("an app this deployment could not connect is never offered", async () => {
    /*
     * COMPOSIO PUBLISHES 1540 APPS AND FIFTY-SIX OF THEM CANNOT BE CONNECTED FROM HERE: they want
     * an OAuth client registered by whoever runs the deployment, and this deployment holds nowhere
     * to put one. Listed, they are a row an administrator presses Add on and meets the vendor's
     * refusal at — a dead end offered as a choice. Hidden in the route rather than asked of the
     * vendor, because which apps are connectable is a fact about what this deployment can drive,
     * not about what Composio publishes.
     */
    const { app } = directoryApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
    );

    expect(response.status).toBe(200);
    const slugs = (await response.json()).apps.map(
      (entry: { slug: string }) => entry.slug,
    );
    expect(slugs).not.toContain("docusign");
    expect(slugs).toEqual(["slack", "gmail", "linear"]);

    // And the search branch reads the same filtered list, not the raw directory. Searching is what
    // an administrator does to a 1540-app picker, so a term that names the unconnectable app is
    // the request most likely to hand one back.
    const searched = await app.request(
      "http://openbot.test/api/plugins/composio/apps?q=docu",
    );
    expect((await searched.json()).apps).toEqual([]);
  });

  test("an app is enabled by the url of the row, not by the row's id", async () => {
    /*
     * Which app a row is comes off its url and only off its url, because that is where the
     * transport reads it from. An id read as an app name is a different question wearing the same
     * answer's clothes, and it works right up until somebody renames a row.
     *
     * SO THE ROW BELOW DISAGREES WITH ITSELF, AND NAMES A SECOND APP THAT IS REALLY IN THE
     * DIRECTORY. Its id reads as Gmail and its url is Slack's — which is a renamed Slack row, and
     * the only fixture that can tell the two readings apart. The id used to be
     * `an-id-nobody-should-read`, a string no implementation would resolve to any app at all: under
     * it, a route keyed on ids would have marked NOTHING enabled and the assertions below would
     * have read exactly as they do now. The test's own name was the only place the property lived.
     *
     * AND THE ID-BEARING READ IS ASSERTED UNMADE, which is the structural half the route's comment
     * claims: `serverUrls` hands over urls and nothing else, so there is no id here to read by
     * mistake. That is a claim about which call is made, and only a store offering the other call
     * can check it. See `directoryApp`'s `idReads`.
     */
    const { app, idReads } = directoryApp(undefined, "admin", [
      { id: "composio-gmail", url: "composio://slack" },
    ]);

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
    );

    const apps = (await response.json()).apps as Array<{
      slug: string;
      enabled: boolean;
    }>;
    expect(apps.find((entry) => entry.slug === "slack")?.enabled).toBe(true);
    expect(apps.find((entry) => entry.slug === "gmail")?.enabled).toBe(false);
    expect(idReads).toEqual([]);
  });

  test("a slug the directory never answered with is refused", async () => {
    /*
     * THE VALIDATION IS THE WHOLE ROUTE. The slug becomes `composio://<slug>`, which is the url
     * every future call for the app is resolved against, so a slug nobody listed is a row pointing
     * at an app that does not exist — added, grantable, and dead at the first call.
     */
    const { added, app } = directoryApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "not-an-app" }),
      },
    );

    expect(response.status).toBe(400);
    expect(added).toEqual([]);
  });

  test("an app this deployment cannot connect is refused before the store", async () => {
    /*
     * THE ASYMMETRY THIS CLOSES. The GET hides every `unsupported` app, so an administrator
     * cannot press Add on one through the picker; the POST validates against the unfiltered
     * catalogue, so a request naming one by hand walks straight past that. What it would reach is
     * `addBrokeredApp`, whose `schemeFor` records `null` for an unsupported app — and `null` on
     * that column is read everywhere else as "not a brokered row at all". So the row this would
     * write is one that lies about its own kind.
     *
     * The derivation's own `reason` is the answer, because it is the sentence that names what is
     * missing for THIS app, and 503 because it is a refusal this deployment authored — the same
     * status `brokerRefusal` gives one raised a layer down, and not a 400, which would read as a
     * malformed request about an app Composio really does publish.
     */
    const { added, app } = directoryApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "docusign" }),
      },
    );

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain(
      "OAuth application registered by whoever runs this deployment",
    );
    // AND THE STORE WAS NEVER ASKED, which is the whole point of the guard: the misleading row is
    // not written and then answered around, it is never reachable.
    expect(added).toEqual([]);
  });

  test("an app the directory does list is added", async () => {
    const { added, app } = directoryApp();

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "slack" }),
      },
    );

    expect(response.status).toBe(201);
    // The title comes off the directory entry, never off the request: the caller chose an app, not
    // a name for it.
    // And so does the connection: how an app connects is read off the catalogue row that was
    // chosen, not derived a second time on the way to the store.
    expect(added).toEqual([
      {
        slug: "slack",
        title: "Slack",
        by: ADMIN.email,
        connection: { kind: "consent" },
      },
    ]);
  });

  test("somebody who is not an administrator sees none of it", async () => {
    // Enabling an app writes every one of its actions in front of a model, which is the same
    // decision as adding an MCP server and stays an administrator's.
    const { added, app } = directoryApp(undefined, "user");

    expect(
      (await app.request("http://openbot.test/api/plugins/composio/apps"))
        .status,
    ).toBe(403);

    const posted = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "slack" }),
      },
    );
    expect(posted.status).toBe(403);
    expect(added).toEqual([]);
  });

  test("a vendor failure is Composio's own sentence on both doors, not a 500", async () => {
    /*
     * THE WRONG KEY IS WHERE THIS FAILS FIRST, and nothing on either route caught anything: the
     * administrator who had just pasted a key was shown a bare 500 and the vendor's whole response
     * object went to the console, headers and trace id included.
     *
     * Both routes make the same call, so both answer in the same words. The POST is the one that
     * mattered most: it is pressed by somebody who has just set the key and is waiting to hear
     * whether it works.
     */
    const failing = async (): Promise<typeof DIRECTORY> => {
      throw WRONG_KEY;
    };

    const listed = await directoryApp(failing).app.request(
      "http://openbot.test/api/plugins/composio/apps",
    );
    const added = await directoryApp(failing).app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "slack" }),
      },
    );
    const listedBody = await listed.text();
    const addedBody = await added.text();

    expect(listed.status).toBe(502);
    expect(added.status).toBe(502);
    expect(JSON.parse(listedBody).error).toBe("Invalid API key provided.");
    expect(JSON.parse(addedBody).error).toBe("Invalid API key provided.");
    expect(listedBody).not.toContain("req_a_trace_id_nobody_should_read");
    expect(addedBody).not.toContain("req_a_trace_id_nobody_should_read");
  });

  test("a failure the vendor did not explain names the setting to check", async () => {
    // Null from `vendorSentence` leaves the route to say something itself, and what it says is the
    // one thing an operator meeting this can act on: the key. Never the thrown object's own text,
    // which on this path is as likely to be a stack frame as a sentence.
    const { app } = directoryApp(async () => {
      throw new Error("fetch failed");
    });

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
    );

    expect(response.status).toBe(502);
    const refusal = (await response.json()).error as string;
    expect(refusal).toContain("COMPOSIO_API_KEY");
    expect(refusal).not.toContain("fetch failed");
  });

  test("a refusal while enabling reaches the administrator who pressed the button", async () => {
    /*
     * THE DEAD BUTTON. An administrator pressed Add and Composio answered "Default auth config not
     * found for toolkit linear_mcp. Composio does not have managed credentials for this toolkit." —
     * everything needed to explain the failure, and a step somebody here can take. The route mapped
     * that sentence for the directory read and for nothing else, so a refusal out of enabling left
     * as an unhandled throw: a bodyless 500, and the browser's own "That app could not be added."
     * over the top of a reason that existed.
     *
     * 503 with the refusal's own words, because a refusal this deployment authored is not a third
     * party being down and the generic sentence would send an administrator to check a key that is
     * fine.
     *
     * A CONNECTABLE APP IS PRESSED HERE, and it has to be. The fixture's `unsupported` row would
     * be the natural choice — the refusal below is the one DocuSign would really raise — but the
     * route now refuses an unsupported app itself, before the store is called at all, so pressing
     * that row would answer 503 with the catalogue's own sentence and never reach the failing
     * store this case exists to exercise. Linear is connectable, and a refusal can still come back
     * out of enabling it: Composio holding no managed credentials is a fact about the vendor's
     * side, not about what this deployment can drive.
     */
    const { app } = directoryApp(undefined, "admin", [], async () => {
      throw new BrokerRefusalError(
        "Linear was not enabled: Composio holds no managed credentials for this toolkit, so there is no auth config for this deployment to create.",
      );
    });

    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };

    try {
      const response = await app.request(
        "http://openbot.test/api/plugins/composio/apps",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: "linear" }),
        },
      );

      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toContain(
        "no managed credentials for this toolkit",
      );
    } finally {
      console.error = realError;
    }

    // AND NOTHING ON THE CONSOLE. The log below this branch is for the failure whose explanation
    // cannot be read off the response; this refusal's explanation is the response. Widen that
    // guard to fire on every refusal — or add a third sentence source and leave the guard out of
    // step with it — and an operator gets a console line per dead button, about failures they can
    // already read in the browser.
    expect(
      said.find((line) => line.includes("composio-app-not-enabled")),
    ).toBeUndefined();
  });

  test("a deployment fault while enabling is still a 409 in its own words", async () => {
    /*
     * WHAT THE BROKER MAPPING MUST NOT SWALLOW. The catch on this route now ends in
     * `brokerRefusal`, and where that mapping sits decides the answer for three whole classes of
     * failure: the deployment faults — an ambiguous server row, a broken invariant, a query this
     * database refused — are recognised one branch ABOVE it and answered 409 with the sentence
     * they carry. Move the broker mapping up and every one of them turns into a 502 saying
     * "Composio said nothing about why" about a failure Composio had no part in, which would send
     * an administrator to check a key that is fine and hide the row they actually have to fix.
     *
     * Nothing else on this route pins that ordering, so this is the case that stops a later reader
     * tidying the branches into the wrong sequence.
     */
    const { app } = directoryApp(undefined, "admin", [], async () => {
      throw new ServerRowAmbiguousError(
        "Two rows claim the url composio://slack, and this deployment cannot tell which one an enable belongs to.",
      );
    });

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "slack" }),
      },
    );

    expect(response.status).toBe(409);
    const refusal = ((await response.json()) as { error: string }).error;
    expect(refusal).toContain("Two rows claim the url");
    expect(refusal).not.toContain("Composio said nothing about why");
  });

  test("a failure nobody explained is a 502 in the route's own words", async () => {
    /*
     * THE LAST CLASS ON THIS ROUTE, and the only one that gets logged. A refusal this deployment
     * authored carries its own sentence, and a sentence Composio wrote carries Composio's; a bare
     * `Error` carries neither, which is what `brokerSentence` and `vendorSentence` both answering
     * null means. That is most often a programmer error on this side, so the route writes it to the
     * console — the one failure whose explanation cannot be read off the response, because the
     * response is the generic sentence and nothing more.
     *
     * SO THE CONSOLE IS READ HERE, not only the body. The response half alone pins nothing about
     * the guard — `brokerRefusal` produces that same 502 whether the log block exists or not — so
     * the line itself is asserted: it has to carry the sentence the response withholds, and the app
     * it was about. Delete the guard and this case fails; widen its condition to log every refusal
     * and the authored refusal above fails.
     *
     * THE FAKE KEY ON THE THROWN OBJECT pins the restraint the route's comment promises. The error
     * is stringified, never spread, logged as an object or reached into, so a property that rode
     * along on it reaches nobody. `JSON.stringify(error)` in place of `String(error)` is the quiet
     * way to lose that, and it is what these last two assertions catch.
     */
    const { app } = directoryApp(undefined, "admin", [], async () => {
      throw Object.assign(
        new Error("Cannot read properties of undefined (reading 'slug')"),
        { apiKey: "ak_a_key_nobody_should_read" },
      );
    });
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };

    try {
      const response = await app.request(
        "http://openbot.test/api/plugins/composio/apps",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: "slack" }),
        },
      );

      expect(response.status).toBe(502);
      const refusal = ((await response.json()) as { error: string }).error;
      expect(refusal).toContain("Composio said nothing about why");
      // Never the thrown object's own text: on this path it is as likely to be a stack frame as a
      // sentence, and it is the console line that carries it to an operator.
      expect(refusal).not.toContain("Cannot read properties");
    } finally {
      console.error = realError;
    }

    const line = said.find((said) => said.includes("composio-app-not-enabled"));
    expect(line).toBeDefined();
    // Which app an operator is about to be asked about, and the cause the browser was not given —
    // the complement of the assertion above, and the whole point of the guard.
    expect(line).toContain("slack");
    expect(line).toContain("Cannot read properties");
    expect(line).not.toContain("ak_a_key_nobody_should_read");
  });
});

/**
 * What one person's connected accounts are, when some of them are brokered.
 *
 * CRITERION. A brokered connection appears in `GET /connections` for the person who holds it, and
 * for nobody else, in the same list as this deployment's own OAuth connections.
 *
 * REASON. The route answered out of `connectionsFor` alone, which reads the vault's join table, so
 * an app connected through Composio was invisible to the browser however live it was. The settings
 * page could then only lie about it or say nothing, and it said nothing. The two reads are separate
 * because the tables are — one holds a refresh token, the other holds only the fact that Composio
 * said yes — and this pins that the API does not make the reader care which.
 *
 * SCOPING IS THE OTHER HALF, and it is a per-person read with no `requireAdmin` in front of it: a
 * union assembled from the wrong id would put somebody else's connected mailbox on this page.
 *
 * THE TWO ROW TYPES ARE THE STORE'S OWN, and that is what makes the verification half of this route
 * testable at all. The brokered fixture used to be re-typed here as the three fields it shares with
 * a held row, so `verified`, `verifiedAt`, `probe` and `checkable` never entered the harness and
 * nothing above could notice a route that dropped them on the way out.
 */
function connectionsApp(
  person: { id: string; email: string },
  held: HeldConnection[],
  brokered: Array<{ userId: string; row: BrokeredConnection }>,
) {
  const store = pluginStore({
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => [],
    listSkills: async () => [],
    connectionsFor: async (userId: string) =>
      userId === person.id ? held : [],
    brokeredConnectionsFor: async (userId: string) =>
      brokered
        .filter((connection) => connection.userId === userId)
        .map((connection) => connection.row),
  });

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () => ({
          user: { ...person, name: "Somebody", image: null },
        }),
      },
    } as never,
    { rolesForUser: async () => ["user"] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...UP_TO_PLUGIN_STORE,
    store,
  );

  return () => app.request("http://openbot.test/api/plugins/connections");
}

const ASKER = { id: "user_asker", email: "asker@openbot.test" };
const SOMEBODY_ELSE = { id: "user_other", email: "other@openbot.test" };

/** This deployment's own OAuth grant, which is what `connectionsFor` answers and all it answers. */
const HELD_NOTION: HeldConnection = {
  serverId: "notion",
  scope: "read",
  connectedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * One account Composio holds on this deployment's behalf, in the shape the store really answers.
 *
 * EVERY ONE OF THE FOUR EXTRA FIELDS CARRIES A VALUE THAT IS NOT ITS OWN DEFAULT, which is what
 * makes them assertable rather than decorative. `verified` false beside a NAMED probe is the state
 * that only this field can express — the action ran in this person's account and the vendor refused
 * the key — and `checkable` true beside it is the other half: the app still publishes something to
 * spend, so the page may offer Re-check. A row of `false`/`null`/`null`/`false` would be
 * indistinguishable from a route that invented defaults for fields it had dropped.
 */
const BROKERED_SLACK: BrokeredConnection = {
  serverId: "composio-slack",
  scope: "",
  connectedAt: "2026-02-02T00:00:00.000Z",
  verified: false,
  verifiedAt: null,
  probe: "SLACK_LIST_CHANNELS",
  checkable: true,
};

describe("a person's own connections", () => {
  test("a brokered connection is in the list beside the OAuth ones", async () => {
    const request = connectionsApp(
      ASKER,
      [HELD_NOTION],
      [{ userId: ASKER.id, row: BROKERED_SLACK }],
    );

    const response = await request();

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connections: Array<{ serverId: string }>;
    };
    // Sorted, so two requests answer in the same order: concatenating two lists that are each
    // ordered within their own table does not produce an ordered list.
    expect(body.connections.map((row) => row.serverId)).toEqual([
      "composio-slack",
      "notion",
    ]);
  });

  test("and what can be re-checked about it travels with it", async () => {
    /*
     * THE WHOLE VERIFICATION SURFACE, AT THE LEVEL THAT ACTUALLY SHIPS IT.
     *
     * CRITERION. The four fields `brokeredConnectionsFor` adds over a held row leave this route
     * verbatim, and a held row carries none of them.
     *
     * REASON. The route concatenates the two reads without rewriting either, so nothing here looks
     * like code that could drop a field — which is exactly why nothing pinned it. A `.map` added
     * later to normalise the union, or a Zod response schema stripping unknown keys, takes all four
     * out in one line and every other test on this route goes on passing: they assert on
     * `serverId`, and `serverId` survives. What does not survive is the settings page, which then
     * draws "Connected" over a key the vendor has refused, with no Re-check button to find out.
     *
     * THE WHOLE ROW RATHER THAN FIELD BY FIELD, because the failure to catch is a route that keeps
     * the field name and answers something else for it — a `verified: false` defaulted in for a
     * dropped `verified`, or a `probe` flattened to null. Comparing the row the store handed over
     * with the row the browser is given is the one assertion that cannot be satisfied by a
     * plausible-looking substitute.
     *
     * AND THE HELD ROW IS IN THE SAME COMPARISON, which is the other half and not a second thought.
     * A held connection has nothing to re-check — no secret of ours stands behind it to have been
     * spent — so these four fields being ABSENT from its row is what tells the two reads apart on
     * the page, and a route defaulting them onto everything would put a Re-check button over an
     * OAuth grant. `toEqual` on the whole list refuses an extra key as readily as a missing one, so
     * both mistakes land on this line.
     */
    const request = connectionsApp(
      ASKER,
      [HELD_NOTION],
      [{ userId: ASKER.id, row: BROKERED_SLACK }],
    );

    const response = await request();

    expect(response.status).toBe(200);
    const connections = ((await response.json()) as { connections: unknown[] })
      .connections;
    expect(connections).toEqual([BROKERED_SLACK, HELD_NOTION]);
  });

  test("and is nobody else's", async () => {
    // The must-not case. This route is behind `requireUser` and nothing else: a union read for the
    // wrong person would show one person's connected account on another person's settings page.
    const request = connectionsApp(
      SOMEBODY_ELSE,
      [],
      [{ userId: ASKER.id, row: BROKERED_SLACK }],
    );

    const response = await request();

    expect(response.status).toBe(200);
    expect((await response.json()).connections).toEqual([]);
  });
});

/**
 * The url a person is sent to when they connect a brokered app to their own account.
 *
 * A constant rather than a literal at each assertion, because the thing being asserted about it is
 * mostly where it does NOT appear: it is handed to the browser that asked and to nothing else.
 */
const AUTHORIZATION_URL = "https://backend.composio.dev/s/a-bearer-capability";

/**
 * Where this deployment tells Composio to send somebody back to, written out rather than composed.
 *
 * BUILT FROM THE DEPLOYMENT AND FROM NOTHING IN THE REQUEST, which is the property the tests below
 * are about. The origin is `testEnvironment`'s own — no `OPENBOT_APP_URL` is set, so it falls back
 * through to `BETTER_AUTH_URL` — and the path is the account's page, which is where the person
 * pressed Connect and the page that asks Composio whether it worked.
 *
 * Two of them because a caller may name one of two PAGES and nothing else: an administrator who
 * started this from the app's own admin screen comes back to that screen. A literal at each
 * assertion rather than a call to `connectedAccountsUrlFor`, because an assertion that builds the
 * expected value the way the code does cannot fail when the code's answer changes.
 */
const RETURN_URL =
  "http://localhost:3001/settings/connected-accounts/composio-linear";
const ADMIN_RETURN_URL = "http://localhost:3001/admin/plugins/composio-linear";

/**
 * A failure in the shape `vendorSentence` reaches into, with the vendor's sentence at the bottom.
 *
 * The sentence the vendor actually sends for the failure a new operator meets first, nested exactly
 * as `@composio/core` nests it: two levels inside `cause`, beside the whole HTTP response. The
 * `headers` and `requestId` beside it are the point of this fixture — they are what must not come
 * back out.
 */
const WRONG_KEY = Object.assign(new Error("Request failed"), {
  cause: {
    error: {
      error: { message: "Invalid API key provided." },
      headers: { "x-request-id": "req_a_trace_id_nobody_should_read" },
    },
    status: 401,
  },
});

/**
 * What the key app publishes, which is both the form a person is drawn and the list a submission
 * is checked against.
 *
 * TWO FIELDS AND ONE OF THEM OPTIONAL, because the filter has to be shown to be about NAMES rather
 * than about completeness: a submission naming only the required one is a person leaving the
 * optional box alone, and it must connect.
 */
const PUBLISHED: BrokerField[] = [
  {
    name: "api_key",
    label: "API key",
    help: "Your Firecrawl API key, a token starting with fc-",
    required: true,
    secret: true,
  },
  {
    name: "base_url",
    label: "Base URL",
    help: "Leave this alone unless you run Firecrawl yourself.",
    required: false,
    secret: false,
    default: "https://api.firecrawl.dev",
  },
];

/**
 * One brokered app, added, and the person connecting their own account to it.
 *
 * WHICH APP THIS IS COMES OFF THE ROW'S URL. `serverAddress` answers one row whose url is
 * `composio://linear`, and the branch under test reads the app out of it with `toolkitOf` rather
 * than off the id — the id is a row name (`composio-linear`) and reading one as the other works
 * right up until somebody renames a row.
 *
 * `redirectUrl` NULL IS A DEPLOYMENT WITH NO COMPOSIO_API_KEY, the same way `directoryApp`'s null
 * listing is: there is no broker at all, which is the shipped default and a state the surface has
 * to answer honestly rather than by pretending nobody is connected.
 */
function brokeredApp(
  /** What this deployment already holds for this person and this app. Null is nobody connected. */
  connection: { connectedAt: string } | null = null,
  /** Null is a deployment with no COMPOSIO_API_KEY, which is the shipped default. */
  redirectUrl: string | null = AUTHORIZATION_URL,
  /**
   * The deployment as it is when something about it is what is under test.
   *
   * Every field is absent for the flows that work, which is most of this file. A failure needs a
   * deployment that fails in one named way: a broker that throws where the vendor would have, a
   * store whose brokered calls throw for the same reason one layer down, or an environment with no
   * app URL to send anybody back to.
   */
  deployment: {
    authorizeThrows?: unknown;
    storeThrows?: unknown;
    /** A broker that will not say what an app asks for, which is the fields call failing. */
    fieldsThrow?: unknown;
    /**
     * What the app publishes, when the list itself is what is under test.
     *
     * Defaulted to {@link PUBLISHED}, which is the ordinary app with one required box and one
     * optional one. The case this exists for is the empty list: a scheme whose whole meaning is a
     * secret somebody types, published with nothing to type it into.
     */
    published?: BrokerField[];
    environment?: Record<string, string | undefined>;
  } = {},
) {
  const authorized: Array<{
    userId: string;
    toolkit: string;
    returnUrl: string;
  }> = [];
  const queried: Array<{ toolkit: string; userId: string }> = [];
  const confirmed: Array<{ toolkit: string; userId: string }> = [];
  /** Every re-check that reached the store, so who it was made about is an assertion. */
  const rechecked: Array<{ toolkit: string; userId: string }> = [];
  const disconnected: Array<{
    toolkit: string;
    userId: string;
    by: string;
    reason: string;
  }> = [];
  /** Every time the route went and asked Composio what an app wants typed in. */
  const asked: Array<{ toolkit: string; authScheme: string }> = [];
  /**
   * Every submission that reached the store, which is what the filter is asserted through.
   *
   * The values are recorded because the assertion is about WHICH NAMES travel and not about what a
   * person typed: a key the app never published must not be in here, and the published ones must
   * arrive unchanged.
   */
  const submitted: Array<{
    toolkit: string;
    userId: string;
    values: Record<string, string>;
  }> = [];

  const rows = [
    {
      id: "composio-linear",
      // The app's name, which is the one of the two a person has ever seen. The refusal below
      // reads it off the row, and the id beside it is what that refusal used to quote instead.
      title: "Linear",
      url: "composio://linear",
      /*
       * The scheme this app's config was created as, which is what decides which of the two
       * brokered flows the route opens. `OAUTH2` is a consent app: there is no form to draw, and
       * every assertion above about a minted link depends on this row being read as one.
       */
      authScheme: "OAUTH2",
    },
    /*
     * An app whose secret the person holds and types in, which is the other half of the brokered
     * surface and the one with a form rather than a consent screen.
     *
     * A SECOND ROW RATHER THAN A SECOND SCHEME ON THE FIRST, because the two flows have to be
     * shown not to reach each other: the consent tests below press Connect on Linear and must
     * still get a link, and the form tests press it on this row and must never mint one. One row
     * switching scheme between tests would prove one flow at a time and nothing about the fork.
     */
    {
      id: "composio-firecrawl",
      title: "Firecrawl",
      url: "composio://firecrawl",
      authScheme: "API_KEY",
    },
    /*
     * An app that needs no credential at all, which is the third brokered kind and the one the
     * fork above forgets.
     *
     * A SEPARATE ROW FOR THE SAME REASON FIRECRAWL IS ONE: the three flows have to be shown not to
     * reach each other, and a row switching scheme between tests would prove one at a time.
     *
     * `NO_AUTH` is the literal `connectionOf` resolves thirty-four of Composio's toolkits to, and
     * it is what `addBrokeredApp` records for them. Composio refuses to hold an authorization
     * config for one, so there is nothing to consent to, nothing to type, and no row in
     * `composio_connections` that could ever be written — which is exactly what
     * `connectionTokenFor` already acts on when it lets a call through with no connection at all.
     */
    {
      id: "composio-hackernews",
      title: "Hacker News",
      url: "composio://hackernews",
      authScheme: "NO_AUTH",
    },
    /*
     * An ordinary OAuth row, so that "this app is not brokered" is a real row and not a missing
     * one. The two routes below answer the same way for both, and this is the half that would
     * otherwise go untested: an id naming nothing at all is easy to refuse, while a server this
     * deployment really has whose connection simply does not live at Composio is where a
     * confusing answer would come from.
     */
    {
      id: "notion",
      title: "Notion",
      url: "https://notion.test/mcp",
      // Null is not an older brokered row; it is a row that is not brokered at all.
      authScheme: null,
    },
    /*
     * A BROKERED ROW WITH NO SCHEME RECORDED ON IT, which is what every brokered row in a
     * deployment older than migration 0030 looks like.
     *
     * The three rows above each name a scheme, so the connect fork was only ever entered by
     * DECISION — and its consent arm is reached by ELIMINATION: `NO_AUTH` is answered, a field
     * scheme is answered, and everything else falls through to minting a link. "Everything else"
     * is the arm with no fixture behind it, and the row shape that lands there most often is this
     * one: `auth_scheme` was added as a nullable column and backfilled for nobody, so every app
     * connected before that migration carries a null to this day.
     *
     * AND IT IS THE RIGHT ANSWER FOR IT, which is why this is a fixture rather than a bug report.
     * Consent was the only kind this deployment had when those rows were written, so a null means
     * consent — and it means it by elimination, which is exactly the reading nothing checked.
     */
    {
      id: "composio-slack",
      title: "Slack",
      url: "composio://slack",
      authScheme: null,
    },
    /*
     * AND A SCHEME THIS DEPLOYMENT HAS NEVER HEARD OF, which is the same arm entered the other way.
     *
     * `OAUTH1` is a real Composio scheme — `connectionOf` resolves it to `consent` and Composio
     * itself calls it redirectable — and it is neither `NO_AUTH` nor a member of `isFieldScheme`'s
     * list. So the row is recorded with a word this route never names, and reaches the consent arm
     * because nothing above it claimed it. Any scheme the vendor adds tomorrow arrives the same
     * way, and the answer has to be a link rather than a 500 or a form drawn for a flow that has
     * none.
     */
    {
      id: "composio-trello",
      title: "Trello",
      url: "composio://trello",
      authScheme: "OAUTH1",
    },
  ];

  const store = pluginStore({
    /*
     * Every read the plugins surface makes on its way to the route under test.
     *
     * Three columns, looked up by id, because that is all these routes ask for: the url they read
     * the app out of and the title a refusal names. The whole server list is what they used to ask
     * for, and a stub that still answered one would be pretending they need more than they do.
     */
    serverAddress: async (serverId: string) =>
      rows.find((row) => row.id === serverId),
    listSkills: async () => [],
    brokeredConnection: async (input: { toolkit: string; userId: string }) => {
      queried.push(input);
      return connection;
    },
    confirmBrokeredConnection: async (input: {
      toolkit: string;
      userId: string;
    }) => {
      confirmed.push(input);
      // Thrown from where the store asks the broker, because that is where it throws in the
      // product: `confirmBrokeredConnection` calls `isConnected` and catches nothing.
      if (deployment.storeThrows) throw deployment.storeThrows;
      return { connected: connection !== null };
    },
    recheckBrokeredConnection: async (input: {
      toolkit: string;
      userId: string;
    }) => {
      rechecked.push(input);
      // Thrown from where the store raises it in the product: a probe that ran and was refused is a
      // {@link PluginRefusedError}, and a broker that would not answer at all is the vendor's own
      // object one layer down. Both leave this method the same way — by throwing.
      if (deployment.storeThrows) throw deployment.storeThrows;
      /*
       * All three fields, because all three are what the row reads. `verifiedAt` is the date the
       * sentence is drawn from and `probe` is what says a call was really made, which `verified`
       * alone cannot.
       */
      return {
        verified: true,
        verifiedAt: "2026-09-13T10:00:00.000Z",
        probe: "LINEAR_GET_ME",
      };
    },
    connectBrokeredWithFields: async (input: {
      toolkit: string;
      userId: string;
      values: Record<string, string>;
    }) => {
      submitted.push(input);
      if (deployment.storeThrows) throw deployment.storeThrows;
      /*
       * All three fields, because all three are what the browser reads. `probe` named beside
       * `verified: true` is the one state that says a call was really made with the key; the row
       * cannot tell that apart from "there was nothing safe to try" without it.
       */
      return {
        connected: true as const,
        verified: true,
        probe: "FIRECRAWL_SCRAPE",
      };
    },
    disconnectBrokered: async (input: {
      toolkit: string;
      userId: string;
      by: string;
      reason: string;
    }) => {
      disconnected.push(input);
      // The revoke comes before the delete, so a throw here is the product's own ordering: the
      // account is still live at the vendor and the row is still here.
      if (deployment.storeThrows) throw deployment.storeThrows;
      return { vendorRevocationRequested: true };
    },
  });

  const app = createApp(
    loadConfig(testEnvironment(deployment.environment)),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    // Connecting an account is not an administrator's act: an administrator adds the app once, and
    // then everybody connects their own.
    { rolesForUser: async () => ["user"] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...UP_TO_PLUGIN_STORE,
    store,
    // Positions 16-29 are the stores after it; the broker is 30, `composio`.
    ...UP_TO_BROKER,
    redirectUrl
      ? ({
          broker: {
            authorize: async (request: {
              userId: string;
              toolkit: string;
              returnUrl: string;
            }) => {
              // Recorded BEFORE the throw, so a test about a failing broker can still say the
              // address it was asked with was this deployment's own.
              authorized.push(request);
              if (deployment.authorizeThrows) throw deployment.authorizeThrows;
              return { redirectUrl };
            },
            connectionFields: async (request: {
              toolkit: string;
              authScheme: string;
            }) => {
              asked.push(request);
              if (deployment.fieldsThrow) throw deployment.fieldsThrow;
              return deployment.published ?? PUBLISHED;
            },
          },
        } as never)
      : undefined,
  );

  return {
    authorized,
    queried,
    confirmed,
    rechecked,
    disconnected,
    asked,
    submitted,
    /**
     * The same route aimed at the app whose secret a person types.
     *
     * Its own helper rather than a fifth argument to `connect` below, because the two are different
     * requests: that one is a consent app and carries a query and headers the tests about return
     * addresses need, and this one carries a body and nothing else.
     */
    connectFields: (body?: unknown) =>
      app.request(
        "http://openbot.test/api/plugins/servers/composio-firecrawl/connect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
    /**
     * The same route aimed at the app that needs no account at all.
     *
     * Its own helper beside the other two, because the assertion is that this press reaches
     * neither of them: no form is asked for and no consent link is minted.
     */
    connectNoAuth: (body?: unknown) =>
      app.request(
        "http://openbot.test/api/plugins/servers/composio-hackernews/connect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
    /**
     * The same route aimed at whichever row a test names, with nothing else moved.
     *
     * Its own helper beside {@link connect}, which is fixed on the consent app: the two cases below
     * are about a row whose scheme this route never names, and the only thing that can express them
     * is the id. The body is empty because these are first presses and nothing about them is about
     * what a caller sends.
     */
    connectAt: (serverId: string) =>
      app.request(
        `http://openbot.test/api/plugins/servers/${serverId}/connect`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ),
    connect: (
      body: unknown,
      query = "",
      /**
       * Headers a caller controls, for the cases that assert none of them is read.
       *
       * A browser sends `Referer` and `Origin` on an ordinary same-origin POST without being asked,
       * so a route reading either would be taking a return address from the request while looking
       * like it took none. Defaulted empty, because every other case here is about the body.
       */
      headers: Record<string, string> = {},
    ) =>
      app.request(
        `http://openbot.test/api/plugins/servers/composio-linear/connect${query}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
      ),
    /*
     * The two routes a person's own settings page drives, with every input a caller controls left
     * open: which row, what is in the body, and what is in the query. The tests below hand all
     * three a user id that is not the session's, because the assertion is that none of them
     * changed who was acted on.
     */
    confirm: (options: Caller = {}) =>
      app.request(
        `http://openbot.test/api/plugins/servers/${options.serverId ?? "composio-linear"}/connection/confirm${options.query ?? ""}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.body ?? {}),
        },
      ),
    /*
     * The button beside them, and the one that is never pressed by a page.
     *
     * Given the same open inputs as the two below — the row, a body and a query — because it is the
     * same identity question: a re-check spends a call on somebody's own account at the vendor, so a
     * caller who could name a person would be spending a stranger's rate limit and rewriting the
     * verification on their row.
     */
    recheck: (options: Caller = {}) =>
      app.request(
        `http://openbot.test/api/plugins/servers/${options.serverId ?? "composio-linear"}/connection/recheck${options.query ?? ""}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.body ?? {}),
        },
      ),
    disconnect: (options: Caller = {}) =>
      app.request(
        `http://openbot.test/api/plugins/servers/${options.serverId ?? "composio-linear"}/connection${options.query ?? ""}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.body ?? {}),
        },
      ),
  };
}

/** Everything a caller of those two routes gets to choose. */
type Caller = {
  /** Which server row the route is aimed at. Defaults to the brokered one. */
  serverId?: string;
  body?: unknown;
  /** A query string, leading `?` included. */
  query?: string;
};

describe("connecting a brokered app", () => {
  test("the link is minted for the session's own person, whatever the body says", async () => {
    /*
     * THE USER ID COMES FROM THE SESSION AND FROM NOWHERE ELSE.
     *
     * A brokered call opens whichever account the user id names, so a route that would take one
     * out of a request body is one POST away from attaching somebody else's Linear to this
     * person's row — or, the same defect turned around, minting a link that connects this person's
     * account under somebody else's name. It is the defect the prior art this design copies
     * shipped and fixed three separate times, which is why the body here carries a user id at all:
     * the assertion is that it changed nothing.
     */
    const { authorized, queried, connect } = brokeredApp();

    const response = await connect({ userId: "user_somebody_else" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorizationUrl: AUTHORIZATION_URL,
    });
    expect(authorized).toEqual([
      { userId: ADMIN.id, toolkit: "linear", returnUrl: RETURN_URL },
    ]);
    // And the read that decided there was no connection yet asked about the same person.
    expect(queried).toEqual([{ toolkit: "linear", userId: ADMIN.id }]);
  });

  test("a brokered row never reaches the checks that belong to the OAuth flow", async () => {
    /*
     * The ordering, stated as its own case. This deployment has no OPENBOT_PUBLIC_URL and
     * `composio-linear` is in nobody's catalogue, so a brokered row that fell through to either of
     * the two checks below the branch would be answered "no public URL" or "is not connected as an
     * individual person" — the second of which is the opposite of true. Neither check applies: no
     * authorization code comes back to us, no refresh token is stored, and no redirect URI of ours
     * is registered anywhere.
     */
    const { connect } = brokeredApp();

    const body = await (await connect({})).json();

    expect(body.authorizationUrl).toBe(AUTHORIZATION_URL);
  });

  /**
   * THE ARM THAT USED TO BE REACHED BY ELIMINATION, AGAINST THE TWO ROW SHAPES THAT REACH IT.
   *
   * CRITERION. A brokered row recorded with NO scheme, and one recorded with a scheme this route
   * never names, are both REFUSED, and nothing is minted at Composio for either.
   *
   * REASON. The fork used to decide `NO_AUTH` first and a field scheme second, and consent was what
   * was left — so the consent arm was the one arm no row was ever chosen FOR. Both shapes below
   * exist in live databases: `auth_scheme` arrived as a nullable column with no backfill, so every
   * app connected before migration 0030 carries a null, and the catalogue is the vendor's, so a
   * scheme this deployment has never heard of is one Composio release away. What each of them got
   * was a real act performed at the vendor — an authorization link minted for an app this
   * deployment cannot say it holds a consent config for — on the strength of an answer nobody
   * decided.
   *
   * AND THIS TEST USED TO ASSERT THE OPPOSITE, ON AN ARGUMENT WORTH RECORDING RATHER THAN DELETING.
   * It said: neither row can be answered a form, so refusing what the route cannot name leaves every
   * pre-0030 brokered app with a Connect button that says the app is not one this deployment can
   * connect, and the remedy — an administrator removing the app and adding it again — takes every
   * grant on it with it. That is a true cost, and it is the smaller one. A minted link is a
   * capability handed out about an app whose connection kind is unknown, and the three readers of
   * this same column in `plugins/store.ts` all fail closed on that value: the re-check refuses, the
   * disconnect claims no revocation, and the mount-time confirm writes nothing. A route that failed
   * open was the last one that did, and a person told to ask an administrator gets a sentence naming
   * the act that fixes it — which is more than the consent arm's dead end offered them.
   *
   * NOTHING MINTED IS THE HALF THAT MATTERS, which is what `authorized` carries: a link is a
   * capability, and one minted for an app nobody could classify is one nobody chose to hand out.
   */
  test("a brokered row whose scheme this route cannot name is refused rather than sent to consent", async () => {
    const { authorized, connectAt } = brokeredApp();

    // The pre-0030 row: brokered, connected, and carrying no scheme at all.
    const held = await connectAt("composio-slack");
    expect(held.status).toBe(400);
    expect(String((await held.json()).error)).toMatch(/cannot tell how/);

    // And a scheme the vendor names that this deployment does not.
    const drifted = await connectAt("composio-trello");
    expect(drifted.status).toBe(400);
    expect(String((await drifted.json()).error)).toMatch(/cannot tell how/);

    expect(authorized).toEqual([]);
  });

  test("a second connection is refused with the step to take", async () => {
    const { authorized, connect } = brokeredApp({
      connectedAt: "2026-02-02T00:00:00.000Z",
    });

    const response = await connect({});

    expect(response.status).toBe(409);
    const refusal = (await response.json()).error as string;
    // Naming the remedy rather than only refusing: the person has an account attached already, and
    // the only way to a new link is through disconnecting the one they have.
    expect(refusal.toLowerCase()).toContain("disconnect");
    /*
     * THE APP'S TITLE, AND NOT THE ROW'S ID. "Linear" is the name of the thing this person
     * connected; `composio-linear` is how this deployment keys a table, which they have never seen
     * and cannot act on. The second assertion is not the first one twice: a sentence that named the
     * app and then quoted the row id beside it would satisfy one and fail the other.
     */
    expect(refusal).toContain("Linear");
    expect(refusal).not.toContain("composio-linear");
    // And nothing was minted, which is the half that matters: a link handed out here would attach
    // a second account behind a row that already says connected.
    expect(authorized).toEqual([]);
  });

  test("a deployment with no broker is told which setting to set", async () => {
    // The same answer the directory gives, for the same reason: nobody was asked, and the remedy
    // is one environment variable long.
    const { connect } = brokeredApp(null, null);

    const response = await connect({});

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("COMPOSIO_API_KEY");
  });

  test("the address Composio sends somebody back to is built here, never taken from the request", async () => {
    /*
     * THE RETURN ADDRESS IS THIS DEPLOYMENT'S, AND A CALLER HAS NO SAY IN IT.
     *
     * Whoever names it names where a person lands holding a just-completed consent, so a url read
     * off the body, the query or a header would be an open redirect with a consent screen in front
     * of it — the same defect this repository's OAuth `returnTo` is narrowed to two names to
     * avoid. The request below names an address in all three places at once, so a route that read
     * any one of them fails here rather than passing on the two it ignored.
     */
    const { authorized, connect } = brokeredApp();

    const response = await connect(
      { returnUrl: "https://evil.test/harvest", returnTo: "https://evil.test" },
      "?returnUrl=https%3A%2F%2Fevil.test%2Fharvest&callbackUrl=https%3A%2F%2Fevil.test",
      {
        returnUrl: "https://evil.test/harvest",
        referer: "https://evil.test",
        origin: "https://evil.test",
        "x-forwarded-host": "evil.test",
      },
    );

    expect(response.status).toBe(200);
    expect(authorized).toEqual([
      { userId: ADMIN.id, toolkit: "linear", returnUrl: RETURN_URL },
    ]);
  });

  test("an administrator who started on the app's own page is sent back to it", async () => {
    /*
     * The one thing a caller does get to choose, and it is a NAME rather than an address: `admin`
     * or anything else, resolved against this deployment's own origin either way. An administrator
     * connecting their account from the app's setup page left a page mid-task, and sending them to
     * their personal settings afterwards is the round trip this exists to remove.
     */
    const { authorized, connect } = brokeredApp();

    await connect({}, "?returnTo=admin");

    expect(authorized).toEqual([
      { userId: ADMIN.id, toolkit: "linear", returnUrl: ADMIN_RETURN_URL },
    ]);
  });

  test("a returnTo naming somewhere else is the default, not a destination", async () => {
    // Narrowed to one of two names on the way in, so an unrecognised value never reaches the url
    // that gets built. A full address in that parameter is the attack this shape refuses.
    const { authorized, connect } = brokeredApp();

    await connect({}, "?returnTo=https%3A%2F%2Fevil.test");

    expect(authorized).toEqual([
      { userId: ADMIN.id, toolkit: "linear", returnUrl: RETURN_URL },
    ]);
  });

  test("a deployment with no app URL is refused rather than handed a link with no way back", async () => {
    /*
     * A CONSENT WITH NOWHERE TO RETURN TO STRANDS SOMEBODY, so no link is minted at all.
     *
     * The consent screen is on Composio's origin, so the address has to be absolute, and a
     * deployment that cannot say where its own pages are has none to give. Minting the link anyway
     * would leave a person on Composio's hosted page having just granted access to their mailbox,
     * with no route back and nothing here knowing it happened.
     *
     * Single-user with no sign-in is the one deployment shape that genuinely has no app URL:
     * everywhere else `OPENBOT_APP_URL`, `TRUSTED_ORIGINS` or the sign-in address supplies one.
     */
    const { authorized, connect } = brokeredApp(null, AUTHORIZATION_URL, {
      environment: {
        OPENBOT_SINGLE_USER: "true",
        BETTER_AUTH_URL: undefined,
        BETTER_AUTH_SECRET: undefined,
        GOOGLE_OAUTH_CLIENT_ID: undefined,
        GOOGLE_OAUTH_CLIENT_SECRET: undefined,
        INITIAL_ADMIN_EMAILS: undefined,
      },
    });

    const response = await connect({});

    expect(response.status).toBe(503);
    // The setting, because it is the whole remedy and nothing else on the screen names it.
    expect((await response.json()).error).toContain("OPENBOT_APP_URL");
    expect(authorized).toEqual([]);
  });

  test("a broker that throws answers with Composio's own sentence, not a 500", async () => {
    /*
     * A WRONG KEY IS THE FIRST FAILURE A NEW OPERATOR MEETS, and it used to be the least legible:
     * nothing on this path caught anything, so the person pressing Connect got a bare 500 and the
     * vendor's whole thrown object went to the console.
     *
     * What comes back is the one sentence the vendor wrote and nothing else that travelled with
     * it: not the request id, not the response headers, and not the link that was being minted
     * when it failed — which is a bearer capability and belongs in one browser or nowhere.
     */
    const { connect } = brokeredApp(null, AUTHORIZATION_URL, {
      authorizeThrows: WRONG_KEY,
    });

    const response = await connect({});
    const body = await response.text();

    // 502 rather than 500: nothing here broke, and a third party did not answer usefully.
    expect(response.status).toBe(502);
    expect(JSON.parse(body).error).toBe("Invalid API key provided.");
    expect(body).not.toContain("req_a_trace_id_nobody_should_read");
    expect(body).not.toContain(AUTHORIZATION_URL);
  });

  test("a failure the vendor did not explain still says what to do", async () => {
    // Null from `vendorSentence` is a failure this deployment cannot explain — a socket that hung
    // up, an answer in a shape nobody recognises — and the fallback names the app and the step
    // rather than echoing whatever the thrown object happened to stringify as.
    const { connect } = brokeredApp(null, AUTHORIZATION_URL, {
      authorizeThrows: new Error("socket hang up"),
    });

    const response = await connect({});

    expect(response.status).toBe(502);
    const refusal = (await response.json()).error as string;
    expect(refusal).toContain("Linear");
    expect(refusal).not.toContain("socket hang up");
  });
});

/**
 * The other half of the same route: an app whose secret the person holds and types in.
 *
 * CRITERION. A key app answers the form on the first press and the connection on the second, the
 * person it connects is the session's whatever the body says, every three of `connectBrokeredWithFields`'s
 * fields reach the browser, and a name the app did not publish never reaches the store at all.
 *
 * REASON. Most Composio apps are not consent apps, so this branch is the ordinary path rather than
 * the exotic one, and it is the only place in this deployment where a request body is forwarded to
 * a vendor. What is submitted is spread into Composio's own field object, so an unfiltered body is
 * two separate holes at once: a `status` key would sit beside the literal this deployment sets, and
 * anything else a caller invents would travel unexamined. The filter is asserted by what is
 * recorded in `submitted` rather than by the answer, because the answer is the same either way.
 */
describe("connecting an app whose secret a person types", () => {
  test("the first press answers what the app publishes, and connects nobody", async () => {
    /*
     * NO BODY AT ALL, which is what the browser really sends on this press: it is a question about
     * the app rather than about anybody's account. A route that required a body to answer the form
     * would answer this request by trying to connect an empty one.
     */
    const { asked, submitted, authorized, connectFields } = brokeredApp();

    const response = await connectFields();

    expect(response.status).toBe(200);
    // The vendor's own list, passed through rather than restated: `help` is written for the person
    // filling the box in, and nothing here is in a position to improve on it.
    expect(await response.json()).toEqual({ fields: PUBLISHED });
    /*
     * ASKED WITH THE SCHEME RECORDED ON THE ROW, never one derived again here. A form drawn for
     * `BASIC` in front of a config created for `API_KEY` asks for boxes the person's app does not
     * have.
     */
    expect(asked).toEqual([{ toolkit: "firecrawl", authScheme: "API_KEY" }]);
    // And nothing was connected and no consent link minted: this press writes nothing.
    expect(submitted).toEqual([]);
    expect(authorized).toEqual([]);
  });

  test("what the person typed connects them, and all three states come back", async () => {
    /*
     * THE PERSON IS THE SESSION'S HERE TOO, which is why the body carries somebody else's id: the
     * values are a credential being attached to whichever account the user id names, so a route
     * reading one off the body would hang this person's key off another person's row.
     */
    const { submitted, authorized, connectFields } = brokeredApp();

    const response = await connectFields({
      values: { api_key: "fc-live-a-secret" },
      userId: SOMEBODY_ELSE.id,
    });

    expect(response.status).toBe(200);
    /*
     * ALL THREE FIELDS, AND `probe` IS THE ONE THE ROW CANNOT DO WITHOUT. `verified` alone means
     * three different things — nothing safe to try, tried and passed, tried and rejected — and two
     * of them share the flag. A browser given only the boolean would tell somebody whose key the
     * vendor rejected that nothing was ever checked.
     */
    expect(await response.json()).toEqual({
      connected: true,
      verified: true,
      probe: "FIRECRAWL_SCRAPE",
    });
    expect(submitted).toEqual([
      {
        toolkit: "firecrawl",
        userId: ADMIN.id,
        values: { api_key: "fc-live-a-secret" },
      },
    ]);
    // And no consent link was minted for an app that has no consent screen.
    expect(authorized).toEqual([]);
  });

  test("a name the app never published is refused, and nothing is sent", async () => {
    /*
     * `status` IS THE SHARPEST CASE AND THAT IS WHY IT IS THE ONE SUBMITTED. The values are spread
     * into the object the adapter builds for Composio, beside the literal `status: "ACTIVE"` that
     * call sets, so an unfiltered body lets a caller write over it. Every other invented name is
     * the same hole with a less interesting key in it.
     *
     * A person cannot type a name the form did not draw, so this request is either a caller doing
     * something deliberate or an app whose published fields have moved — and neither is answered by
     * connecting them anyway with part of what they sent.
     */
    const { submitted, connectFields } = brokeredApp();

    const response = await connectFields({
      values: { api_key: "fc-live-a-secret", status: "ACTIVE" },
    });

    expect(response.status).toBe(400);
    const refusal = (await response.json()).error as string;
    expect(refusal).toContain("Firecrawl");
    /*
     * THE SENTENCE CARRIES NOTHING THAT WAS SUBMITTED. The values are somebody's own credential and
     * belong in no message, and the names are the caller's text rather than the vendor's on exactly
     * the request where they are wrong.
     */
    expect(refusal).not.toContain("fc-live-a-secret");
    expect(refusal).not.toContain("ACTIVE");
    // The half that matters: the key never left this deployment.
    expect(submitted).toEqual([]);
  });

  test("a value that is not text is refused rather than forwarded as one", async () => {
    // The names are checked against the published list and the values against being values at all:
    // a number under a published name typechecks nowhere and reaches the vendor as whatever JSON
    // makes of it.
    const { submitted, connectFields } = brokeredApp();

    const response = await connectFields({ values: { api_key: 12 } });

    expect(response.status).toBe(400);
    expect(submitted).toEqual([]);
  });

  test("a required box the submission leaves out is refused, and named", async () => {
    /*
     * THE SHAPE WAS NEVER THE QUESTION A REQUIRED FIELD ASKS. Every name here is published and
     * every value is text — vacuously, because there are none — so a guard that checked only those
     * two things let an empty body through, and what it made at Composio is an account carrying no
     * credential at all. Composio does not grade what it is given, and an app with nothing safe to
     * probe leaves the row written and every screen here drawing it as connected.
     */
    const { submitted, connectFields } = brokeredApp();

    const response = await connectFields({ values: {} });

    expect(response.status).toBe(400);
    const refusal = (await response.json()).error as string;
    // The app's name and the box that is missing, which is the whole of what fixes it. The name is
    // the vendor's own here rather than the caller's text, which is what makes it safe to quote.
    expect(refusal).toContain("Firecrawl");
    expect(refusal).toContain("api_key");
    expect(submitted).toEqual([]);
  });

  test("a required box holding only spaces is the empty box it looks like", async () => {
    /*
     * WHITESPACE IS ABSENCE, AND THE SERVER IS THE ONLY PLACE THAT CAN SAY SO. The browser's
     * `required` attribute refuses an empty box and accepts a space, so a space is exactly what
     * reaches here from a form that believes it is filled in — and a key made of spaces is a
     * credential in no sense anything downstream would notice: Composio accepts it, the row is
     * written, and the person is told they are connected.
     */
    const { submitted, connectFields } = brokeredApp();

    const response = await connectFields({
      values: { api_key: "   ", base_url: "https://api.firecrawl.dev" },
    });

    expect(response.status).toBe(400);
    expect(submitted).toEqual([]);
  });

  test("an optional box left empty is not a refusal", async () => {
    /*
     * THE OTHER HALF, AND THE ONE THIS GUARD COULD EASILY BREAK. The form seeds a box from the
     * default the app published and sends every published name back whether or not it was touched,
     * so a blank optional value is what an ordinary submission carries — not an incomplete one. A
     * guard that read "blank" as "missing" without reading `required` first would refuse the
     * commonest submission this route handles.
     */
    const { submitted, connectFields } = brokeredApp();

    const response = await connectFields({
      values: { api_key: "fc-live-a-secret", base_url: "" },
    });

    expect(response.status).toBe(200);
    expect(submitted).toEqual([
      {
        toolkit: "firecrawl",
        userId: ADMIN.id,
        values: { api_key: "fc-live-a-secret", base_url: "" },
      },
    ]);
  });

  test("an app that publishes no boxes connects nobody, form or no form", async () => {
    /*
     * A FIELD SCHEME IS A SECRET SOMEBODY TYPES, so an app publishing nothing to type it into
     * cannot be connected at all: there is no required box to be missing, and every check the
     * submission passes it passes for want of anything to check. The press answers with a refusal
     * rather than an account, and the form press above it still answers the empty list honestly.
     */
    const { submitted, connectFields } = brokeredApp(null, AUTHORIZATION_URL, {
      published: [],
    });

    expect(await (await connectFields()).json()).toEqual({ fields: [] });

    const response = await connectFields({ values: {} });

    expect(response.status).toBe(400);
    expect((await response.json()).error as string).toContain("Firecrawl");
    expect(submitted).toEqual([]);
  });

  test("an app that requires none of its boxes connects nobody, blank or seeded", async () => {
    /*
     * THE SAME CREDENTIAL-LESS ACCOUNT AS THE EMPTY LIST ABOVE, REACHED WITH BOXES ON THE SCREEN.
     * A field scheme is Composio's own statement that this person holds a secret, so an app
     * publishing not one box it says has to be filled in leaves the required guard nothing to be
     * about: `{}` passes it vacuously, a box holding spaces passes it, and so does the very default
     * the form seeded itself from. Every one of the three makes an account carrying no credential,
     * which Composio answers `ACTIVE` for because it does not grade what it is handed, and which an
     * app with nothing safe to probe leaves recorded and drawn as connected on every screen here.
     *
     * THE SEEDED DEFAULT IS THE CASE A GUARD ON THE SUBMISSION WOULD LET THROUGH, and it is the
     * ordinary press rather than a contrived one: the form draws `base_url` already holding the
     * default the app published and posts every published name back whether or not anybody touched
     * it, so somebody who types nothing at all submits a non-blank value they did not choose.
     * Counting non-blank values would call that a credential.
     *
     * AND THE FORM PRESS IS STILL ANSWERED HONESTLY, as it is for the empty list one test above:
     * the list is a true answer to what the app asks for. What is false is the account the NEXT
     * press would make, so that is the press that is refused.
     */
    const { submitted, connectFields } = brokeredApp(null, AUTHORIZATION_URL, {
      published: [
        {
          name: "base_url",
          label: "Base URL",
          help: "Leave this alone unless you run Firecrawl yourself.",
          required: false,
          secret: false,
          default: "https://api.firecrawl.dev",
        },
      ],
    });

    const form = await connectFields();
    expect(form.status).toBe(200);
    expect(
      ((await form.json()).fields as BrokerField[]).map((field) => field.name),
    ).toEqual(["base_url"]);

    for (const values of [
      {},
      { base_url: "   " },
      { base_url: "https://api.firecrawl.dev" },
    ]) {
      const response = await connectFields({ values });

      expect(response.status).toBe(400);
      const refusal = (await response.json()).error as string;
      // The app's name rather than the row's id, as everywhere else in this branch.
      expect(refusal).toContain("Firecrawl");
      expect(refusal).not.toContain("composio-firecrawl");
      /*
       * AND NOTHING THAT WAS SUBMITTED. The seeded default is still a value off the request, and a
       * refusal that echoed it would be echoing whatever a caller sent under that name instead.
       * The vendor's field NAME is what the sentence may carry, and it does.
       */
      expect(refusal).not.toContain("https://api.firecrawl.dev");
      expect(refusal).toContain("base_url");
    }

    expect(submitted).toEqual([]);
  });

  test("a box named after something every object already has is still an empty box", async () => {
    /*
     * THE NAME IS THE VENDOR'S AND THE BAG IT IS PUT IN IS THIS DEPLOYMENT'S, which is the whole of
     * why this case exists. The submitted values are collected into a plain `{}` and each published
     * name is then read back off it — so a field Composio names `constructor` or `toString` is a
     * name JavaScript answers for before the submission does: the read finds a function hanging off
     * `Object.prototype` rather than the `undefined` that means "nobody filled this in". What the
     * required guard then does with it is call `.trim()` on a function, which is a 500 in front of
     * somebody who typed nothing wrong — and a prototype value that HAD been text would have been
     * worse, because the guard would have counted a credential nobody supplied.
     *
     * BOTH NAMES, because the two are not one case: `constructor` is the one an attacker reaches
     * for and `toString` is the one an app could plausibly publish, and a bag that answers for
     * either answers for every other name on that prototype too.
     *
     * THE ANSWER IS THE ORDINARY REFUSAL. Nothing about this submission is exotic from the person's
     * side — they left two required boxes empty — so what they get is the sentence that names the
     * boxes, and nothing reaches the store.
     */
    const { submitted, connectFields } = brokeredApp(null, AUTHORIZATION_URL, {
      published: [
        {
          name: "constructor",
          label: "Instance",
          help: "Which instance this account lives on.",
          required: true,
          secret: false,
        },
        {
          name: "toString",
          label: "Rendering",
          help: "How this account names itself.",
          required: true,
          secret: false,
        },
      ],
    });

    const response = await connectFields({ values: {} });

    expect(response.status).toBe(400);
    const refusal = (await response.json()).error as string;
    expect(refusal).toContain("Firecrawl");
    // The vendor's own names, which is what this branch may quote and all it quotes.
    expect(refusal).toContain("constructor");
    expect(refusal).toContain("toString");
    expect(submitted).toEqual([]);
  });

  test("a box named __proto__ carries what was typed rather than vanishing on the way", async () => {
    /*
     * THE OTHER HALF OF THE SAME BAG, AND IT FAILS SILENTLY RATHER THAN LOUDLY. Assigning
     * `values["__proto__"] = "acme"` on a plain object does not store anything under that name — it
     * reaches the prototype setter, which ignores a string — so the value a person typed is dropped
     * between the check that admitted it and the store that was supposed to receive it. Composio
     * then makes an account missing one of the values the app publishes, answers `ACTIVE` for it
     * because it does not grade what it is handed, and every screen here draws the row as connected.
     *
     * OPTIONAL, SO THE DROP IS THE ONLY THING UNDER TEST. A required `__proto__` would be caught by
     * the guard above for a different reason; leaving it optional means this submission is complete,
     * the request succeeds, and the only question left is whether what was typed arrived.
     */
    const { submitted, connectFields } = brokeredApp(null, AUTHORIZATION_URL, {
      published: [
        {
          name: "api_key",
          label: "API key",
          help: "Your Firecrawl API key, a token starting with fc-",
          required: true,
          secret: true,
        },
        {
          name: "__proto__",
          label: "Tenant",
          help: "The tenant this key belongs to.",
          required: false,
          secret: false,
        },
      ],
    });

    const response = await connectFields({
      values: { api_key: "fc-live-a-secret", ["__proto__"]: "acme" },
    });

    expect(response.status).toBe(200);
    expect(submitted).toHaveLength(1);
    // Read as own names rather than by lookup, because a lookup is the very thing that went wrong.
    expect(Object.keys(submitted[0].values).sort()).toEqual([
      "__proto__",
      "api_key",
    ]);
    expect(submitted[0].values).toEqual({
      api_key: "fc-live-a-secret",
      ["__proto__"]: "acme",
    });
  });

  test("an account already connected is refused before the form is drawn", async () => {
    /*
     * THE ONE-ACCOUNT GUARD STILL RUNS FIRST, which is the ordering both branches were put after on
     * purpose. Drawing the form for somebody who already has an account attached invites them to
     * type a key that would be refused after they had entered it, and asking Composio what the app
     * wants is a call made on behalf of a request that is going to be refused anyway.
     */
    const { asked, submitted, connectFields } = brokeredApp({
      connectedAt: "2026-02-02T00:00:00.000Z",
    });

    const response = await connectFields();

    expect(response.status).toBe(409);
    const refusal = (await response.json()).error as string;
    expect(refusal.toLowerCase()).toContain("disconnect");
    // The app's name rather than the row's id, as on the consent half above.
    expect(refusal).toContain("Firecrawl");
    expect(refusal).not.toContain("composio-firecrawl");
    expect(asked).toEqual([]);
    expect(submitted).toEqual([]);
  });

  test("a consent app is untouched by either branch, whatever the body carries", async () => {
    /*
     * THE FORK IS ON THE SCHEME RECORDED ON THE ROW AND ON NOTHING IN THE REQUEST. A body carrying
     * values is not a statement about how an app connects, and a route that read it as one would
     * send somebody's typed key at a config created for a consent screen — which has nowhere to put
     * it — instead of minting the link they pressed for.
     */
    const { asked, submitted, authorized, connect } = brokeredApp();

    const response = await connect({ values: { api_key: "fc-live-a-secret" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorizationUrl: AUTHORIZATION_URL,
    });
    expect(authorized).toEqual([
      { userId: ADMIN.id, toolkit: "linear", returnUrl: RETURN_URL },
    ]);
    expect(asked).toEqual([]);
    expect(submitted).toEqual([]);
  });

  test("a key app connects on a deployment with no app URL to come back to", async () => {
    /*
     * A SETTING WITH NO BEARING ON THIS FLOW DOES NOT GET TO REFUSE IT.
     *
     * `OPENBOT_APP_URL` is where Composio sends somebody back to once they have consented, and this
     * half has no consent screen to come back from: the key is typed here, no link is minted, and
     * nobody ever leaves the deployment. The guard for it used to stand in front of the fork, so a
     * single-user deployment with no sign-in — the one shape that genuinely has no app URL — could
     * connect none of the key apps that make up most of Composio's catalogue, and was told to set a
     * variable that would not have changed anything about the press it refused.
     *
     * The same environment as the consent refusal above, which is what makes the pair meaningful:
     * one deployment, one missing setting, and the two halves of this route answering differently
     * because only one of them has a return leg.
     */
    const { asked, submitted, authorized, connectFields } = brokeredApp(
      null,
      AUTHORIZATION_URL,
      {
        environment: {
          OPENBOT_SINGLE_USER: "true",
          BETTER_AUTH_URL: undefined,
          BETTER_AUTH_SECRET: undefined,
          GOOGLE_OAUTH_CLIENT_ID: undefined,
          GOOGLE_OAUTH_CLIENT_SECRET: undefined,
          INITIAL_ADMIN_EMAILS: undefined,
        },
      },
    );

    const response = await connectFields({
      values: { api_key: "fc-live-a-secret" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connected: true,
      verified: true,
      probe: "FIRECRAWL_SCRAPE",
    });
    // The key reached the store rather than a 503, and the form was drawn from the vendor on the
    // way through.
    expect(asked).toEqual([{ toolkit: "firecrawl", authScheme: "API_KEY" }]);
    expect(submitted).toEqual([
      {
        toolkit: "firecrawl",
        userId: DEV_ACTOR.id,
        values: { api_key: "fc-live-a-secret" },
      },
    ]);
    // And still no consent link, which is the whole reason the setting has no bearing here.
    expect(authorized).toEqual([]);
  });

  test("a broker that will not say what an app asks for answers with its own sentence", async () => {
    // The same mapping every other brokered call in this file makes: the vendor's one sentence, a
    // 502 rather than a 500, and nothing else that travelled with it.
    const { connectFields } = brokeredApp(null, AUTHORIZATION_URL, {
      fieldsThrow: WRONG_KEY,
    });

    const response = await connectFields();
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(body).error).toBe("Invalid API key provided.");
    expect(body).not.toContain("req_a_trace_id_nobody_should_read");
  });

  test("a key the vendor rejected comes back in the words the store refused it with", async () => {
    /*
     * A MISTYPED KEY IS THE ORDINARY FAILURE HERE AND ITS SENTENCE IS THE WHOLE REMEDY. The store
     * raises a refusal that already says what happened and what to do about it, and flattening that
     * into "Composio said nothing about why" would leave the person who pasted a key with a newline
     * in it reading a sentence about this deployment's API key.
     */
    const { connectFields } = brokeredApp(null, AUTHORIZATION_URL, {
      storeThrows: new PluginRefusedError(
        "firecrawl would not answer with what was entered: 401 unauthorized. Nothing was saved, so entering it again is the whole of the retry.",
        null,
      ),
    });

    const response = await connectFields({ values: { api_key: "wrong" } });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("401 unauthorized");
  });
});

/**
 * The third half of the same route, which is the one it did not have: an app needing no credential.
 *
 * CRITERION. Pressing Connect on a `NO_AUTH` app is answered with what is true of it — there is no
 * account to make — in a sentence naming the app rather than the row, and nothing is asked of
 * Composio on the way: no form is drawn, no consent link is minted, and no key travels. The answer
 * is the same on a deployment with no `OPENBOT_APP_URL`, because that setting is where a consent
 * comes back to and this flow has no consent to come back from.
 *
 * REASON. Thirty-four of Composio's toolkits resolve to `no-auth`, and `NO_AUTH` is the literal
 * recorded on their rows. It is not a field scheme, so the fork above dropped every one of them
 * into the consent arm, where they met one of two dead ends: a 503 demanding `OPENBOT_APP_URL` for
 * a return leg that does not exist, or `broker.authorize`, which can only fail because
 * `ensureAuthConfig` deliberately creates no config for an app Composio refuses to hold one for —
 * answered with a sentence telling the person to remove the app and add it again, which would
 * produce the same row and the same failure. `connectionTokenFor` already settles what is true
 * here: a `NO_AUTH` app has no connection row, cannot have one, and its tools run without one.
 */
describe("connecting an app that needs no account", () => {
  test("the press is answered with what is true of the app, and nothing is asked of Composio", async () => {
    const { asked, authorized, submitted, queried, connectNoAuth } =
      brokeredApp();

    const response = await connectNoAuth();

    /*
     * A REFUSAL RATHER THAN A 200 SAYING CONNECTED, because no row was written and none ever can
     * be. `composio_connections` is the whole of the permission for a brokered call and every row
     * in it means a person granted access to an account; a route answering `connected: true` here
     * would have the settings page draw an account that does not exist, offer a Disconnect that
     * ends nothing, and put this app in front of offboarding as something to revoke.
     *
     * 400 for the reason the OAuth branch below refuses a row that is not connected as an
     * individual person with one: the act does not apply to this kind of row, and the sentence
     * says what is true instead.
     */
    expect(response.status).toBe(400);
    const refusal = (await response.json()).error as string;
    /*
     * THE APP'S TITLE, AND NOT THE ROW'S ID, as on both other halves of this route. "Hacker News"
     * is the name of the thing the person is looking at; `composio-hackernews` is how this
     * deployment keys a table.
     */
    expect(refusal).toContain("Hacker News");
    expect(refusal).not.toContain("composio-hackernews");
    /*
     * AND IT NAMES NO REMEDY, BECAUSE NOTHING IS WRONG. The sentence this used to produce told the
     * person to remove the app and add it again — a step that rebuilds the identical row and fails
     * identically. What is true is that the app works as it is.
     */
    expect(refusal.toLowerCase()).not.toContain("add it again");
    expect(refusal.toLowerCase()).not.toContain("administrator");

    // Neither of the other two branches was entered: no form drawn, no key sent, no link minted.
    expect(asked).toEqual([]);
    expect(submitted).toEqual([]);
    expect(authorized).toEqual([]);
    /*
     * The one-account guard still ran first, which is the ordering both other branches sit after
     * on purpose: whose press this is has to be settled before what the app is.
     */
    expect(queried).toEqual([{ toolkit: "hackernews", userId: ADMIN.id }]);
  });

  test("a deployment with no app URL answers the same way, because there is no return leg", async () => {
    /*
     * A SETTING WITH NO BEARING ON THIS FLOW DOES NOT GET TO REFUSE IT — the same case the key
     * branch makes one describe above, and the sharper version of it: a key app at least had a
     * form to draw once the guard moved, while a no-auth app has nothing at all to do and was
     * being refused for the want of an address nobody was ever going to be sent to.
     *
     * Single-user with no sign-in is the one deployment shape that genuinely has no app URL, and
     * it is the shape most likely to be running the apps that need no account.
     */
    const { authorized, connectNoAuth } = brokeredApp(null, AUTHORIZATION_URL, {
      environment: {
        OPENBOT_SINGLE_USER: "true",
        BETTER_AUTH_URL: undefined,
        BETTER_AUTH_SECRET: undefined,
        GOOGLE_OAUTH_CLIENT_ID: undefined,
        GOOGLE_OAUTH_CLIENT_SECRET: undefined,
        INITIAL_ADMIN_EMAILS: undefined,
      },
    });

    const response = await connectNoAuth();

    expect(response.status).toBe(400);
    const refusal = (await response.json()).error as string;
    expect(refusal).toContain("Hacker News");
    expect(refusal).not.toContain("OPENBOT_APP_URL");
    expect(authorized).toEqual([]);
  });

  test("a body carrying values is not a statement about how the app connects", async () => {
    /*
     * THE FORK IS THE SCHEME RECORDED ON THE ROW AND NOTHING IN THE REQUEST, which the consent
     * half asserts for itself and which matters once more here: values in a body must not talk a
     * route into sending somebody's typed secret at an app Composio holds no config for.
     */
    const { asked, submitted, connectNoAuth } = brokeredApp();

    const response = await connectNoAuth({
      values: { api_key: "hn-a-secret" },
    });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("hn-a-secret");
    expect(asked).toEqual([]);
    expect(submitted).toEqual([]);
  });
});

/**
 * Confirming a brokered connection, and ending one.
 *
 * CRITERION. Both routes act on the connection of the person whose session made the request, and on
 * nobody else's, whatever a body or a query says; both refuse a row that is not brokered in so many
 * words; and both tell a deployment with no broker which setting to set.
 *
 * REASON. The store's behaviour is pinned where it is decided — what a confirm writes, what a
 * disconnect revokes — so what is left here is the routing, and the routing is where the damage
 * would be. A user id these handlers could take from a caller turns one DELETE into a revoke of
 * somebody else's grant at the vendor and one POST into a connection recorded under a person who
 * never made one. It is the defect the prior art this design follows shipped three separate times,
 * and the first test of each pair hands the route a body AND a query naming somebody else so that
 * reading either is a failure rather than a silent pass.
 *
 * Neither route is admin-gated, deliberately: an administrator adds the app once and everybody then
 * manages their own account, so `requireUser` is the whole of the gate and the identity is the whole
 * of the scoping.
 */
describe("confirming and ending a brokered connection", () => {
  test("confirm asks about the session's own person, whatever the caller says", async () => {
    const { confirmed, confirm } = brokeredApp({
      connectedAt: "2026-02-02T00:00:00.000Z",
    });

    const response = await confirm({
      body: { userId: SOMEBODY_ELSE.id },
      query: `?userId=${SOMEBODY_ELSE.id}`,
    });

    expect(response.status).toBe(200);
    // The store's answer, passed through rather than restated: `connected` is what the vendor said.
    expect(await response.json()).toEqual({ connected: true });
    expect(confirmed).toEqual([{ toolkit: "linear", userId: ADMIN.id }]);
  });

  test("disconnect ends the session's own account, whatever the caller says", async () => {
    const { disconnected, disconnect } = brokeredApp({
      connectedAt: "2026-02-02T00:00:00.000Z",
    });

    const response = await disconnect({
      body: { userId: SOMEBODY_ELSE.id },
      query: `?userId=${SOMEBODY_ELSE.id}`,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ vendorRevocationRequested: true });
    /*
     * The owner and the actor are the same person, and `reason` is the word that says why. The
     * trail tells this apart from an administrator offboarding somebody by those three fields and
     * by nothing else, so a route that filed `person_removed` here, or named a different owner,
     * would leave a record of an act that did not happen.
     */
    expect(disconnected).toEqual([
      {
        toolkit: "linear",
        userId: ADMIN.id,
        by: ADMIN.id,
        reason: "self",
      },
    ]);
  });

  test("an app that is not brokered is refused for what is actually wrong", async () => {
    // `notion` is a row this deployment really has. What is wrong is not that it is missing but
    // that its connection does not live at Composio, and the sentence says so rather than talking
    // about a broker setting or an app nobody has heard of.
    const { confirmed, disconnected, confirm, disconnect } = brokeredApp();

    const confirmResponse = await confirm({ serverId: "notion" });
    const disconnectResponse = await disconnect({ serverId: "notion" });

    expect(confirmResponse.status).toBe(400);
    expect(disconnectResponse.status).toBe(400);
    expect((await confirmResponse.json()).error).toBe(
      "That app is not reached through a broker.",
    );
    expect((await disconnectResponse.json()).error).toBe(
      "That app is not reached through a broker.",
    );
    // And the store was left alone: a confirm here would write a row for an app whose connection
    // is not Composio's to answer about, and a disconnect would ask the broker to revoke a grant
    // it never issued.
    expect(confirmed).toEqual([]);
    expect(disconnected).toEqual([]);
  });

  test("a deployment with no broker is told which setting to set", async () => {
    // The same answer the directory and connect give, for the same reason: nobody was asked, and
    // the remedy is one environment variable long. Answering "not connected" instead would draw a
    // settled state over a deployment that has no broker to have connected anybody at.
    const { confirmed, disconnected, confirm, disconnect } = brokeredApp(
      null,
      null,
    );

    const confirmResponse = await confirm();
    const disconnectResponse = await disconnect();

    expect(confirmResponse.status).toBe(503);
    expect(disconnectResponse.status).toBe(503);
    expect((await confirmResponse.json()).error).toContain("COMPOSIO_API_KEY");
    expect((await disconnectResponse.json()).error).toContain(
      "COMPOSIO_API_KEY",
    );
    expect(confirmed).toEqual([]);
    expect(disconnected).toEqual([]);
  });

  test("a broker that throws reaches both routes as Composio's own sentence", async () => {
    /*
     * NEITHER OF THESE HAD ANY ERROR HANDLING, and there is no framework-level handler behind
     * them, so a wrong key answered both with a bare 500 and put the vendor's whole response
     * object on the console.
     *
     * Confirm is the sharper of the two. It runs on every page load, so the tempting answer to a
     * failure is `{ connected: false }` — which would be this deployment inventing a fact only
     * Composio holds, drawing "Not connected" over a live account and then deleting the row that
     * said otherwise. A failure is not a no.
     */
    const { confirm, disconnect } = brokeredApp(
      { connectedAt: "2026-02-02T00:00:00.000Z" },
      AUTHORIZATION_URL,
      { storeThrows: WRONG_KEY },
    );

    const confirmResponse = await confirm();
    const disconnectResponse = await disconnect();
    const confirmBody = await confirmResponse.text();
    const disconnectBody = await disconnectResponse.text();

    expect(confirmResponse.status).toBe(502);
    expect(disconnectResponse.status).toBe(502);
    expect(JSON.parse(confirmBody).error).toBe("Invalid API key provided.");
    expect(JSON.parse(disconnectBody).error).toBe("Invalid API key provided.");
    // And nothing else that travelled with the failure: the response headers it was carrying are
    // a request id in an error body, which is somebody's trace and nobody's remedy.
    expect(confirmBody).not.toContain("req_a_trace_id_nobody_should_read");
    expect(disconnectBody).not.toContain("req_a_trace_id_nobody_should_read");
  });

  test("a failure the vendor did not explain still says what to do on both routes", async () => {
    // The fallback says what a person can act on rather than guessing how far the call got: what
    // the page shows is the vendor's last answer and not this one, and a disconnect is safe to
    // press again because the revoke runs before anything here is deleted.
    const { confirm, disconnect } = brokeredApp(
      { connectedAt: "2026-02-02T00:00:00.000Z" },
      AUTHORIZATION_URL,
      { storeThrows: new Error("socket hang up") },
    );

    const confirmRefusal = (await (await confirm()).json()).error as string;
    const disconnectRefusal = (await (await disconnect()).json())
      .error as string;

    expect(confirmRefusal).toContain("last answer");
    expect(disconnectRefusal).toContain("Disconnect again");
    expect(confirmRefusal).not.toContain("socket hang up");
    expect(disconnectRefusal).not.toContain("socket hang up");
  });
});

/**
 * Re-checking a brokered connection, which is a button and never a page load.
 *
 * CRITERION. The route acts on the connection of the person whose session made the request whatever
 * a body or a query says; it refuses a row that is not brokered and a deployment with no broker in
 * the same words the other two do; and a probe that RAN AND FAILED reaches the browser as a failure
 * carrying the vendor's sentence rather than as a 200 saying the connection is not verified.
 *
 * REASON. The store decides what a re-check writes and what it refuses; what is left here is the
 * routing, and two things about it would do damage. A user id taken from a caller would spend a
 * stranger's rate limit at the vendor and rewrite the verification on their row from one POST. And
 * an answer of `{ verified: false }` for a probe that ran and was refused would be
 * indistinguishable, to the row drawing it, from an app that publishes nothing to check against —
 * so the Re-check button would quietly disappear for the one person who most needs it, the one who
 * has just fixed their key.
 *
 * IT IS NOT CALLED ON MOUNT, unlike confirm, and nothing here calls it twice. Composio never
 * re-checks a key by itself, so this is the only thing that can; but the call is spent against the
 * person's own quota at the vendor, and verifying on every render would burn it to redraw one word.
 */
describe("re-checking a brokered connection", () => {
  test("the re-check is made about the session's own person, whatever the caller says", async () => {
    const { rechecked, recheck } = brokeredApp({
      connectedAt: "2026-02-02T00:00:00.000Z",
    });

    const response = await recheck({
      body: { userId: SOMEBODY_ELSE.id },
      query: `?userId=${SOMEBODY_ELSE.id}`,
    });

    expect(response.status).toBe(200);
    // The store's answer, passed through: what was checked, when, and with which action.
    expect(await response.json()).toEqual({
      verified: true,
      verifiedAt: "2026-09-13T10:00:00.000Z",
      probe: "LINEAR_GET_ME",
    });
    expect(rechecked).toEqual([{ toolkit: "linear", userId: ADMIN.id }]);
  });

  test("a probe that ran and failed is a failure, not an answer saying not verified", async () => {
    /*
     * THE MUST-NOT CASE OF THIS ROUTE. The store raises for a key the vendor rejected, and the
     * sentence it raises with carries Composio's own words — so the route has to pass it through as
     * a refusal. Catching it and answering `{ verified: false }` instead would lose the sentence and
     * hand the row a flag it cannot read: the same `false` an app with nothing to probe produces.
     */
    const { recheck } = brokeredApp(
      { connectedAt: "2026-02-02T00:00:00.000Z" },
      AUTHORIZATION_URL,
      {
        storeThrows: new PluginRefusedError(
          "Linear would not answer with the key it is holding: Invalid API key provided. Your connection is recorded here as unchecked until a key that works is entered.",
          null,
        ),
      },
    );

    const response = await recheck();
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(body).error).toContain("Invalid API key provided.");
    // And it is a refusal rather than an answer: nothing in it for a row to read as a verification.
    expect(JSON.parse(body).verified).toBeUndefined();
  });

  test("an app that is not brokered is refused for what is actually wrong", async () => {
    // `notion` is a row this deployment really has; what is wrong is that its connection does not
    // live at Composio, so there is nothing here to re-check. Same sentence as the other two.
    const { rechecked, recheck } = brokeredApp();

    const response = await recheck({ serverId: "notion" });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "That app is not reached through a broker.",
    );
    expect(rechecked).toEqual([]);
  });

  test("a deployment with no broker is told which setting to set", async () => {
    const { rechecked, recheck } = brokeredApp(null, null);

    const response = await recheck();

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("COMPOSIO_API_KEY");
    expect(rechecked).toEqual([]);
  });

  test("a broker that throws reaches the browser as Composio's own sentence", async () => {
    // The other half of the failure mapping: a vendor object is not a refusal this deployment
    // authored, so it comes back as the vendor's sentence at 502 — and nothing else that travelled
    // with it, which is a request id nobody outside Composio can act on.
    const { recheck } = brokeredApp(
      { connectedAt: "2026-02-02T00:00:00.000Z" },
      AUTHORIZATION_URL,
      { storeThrows: WRONG_KEY },
    );

    const response = await recheck();
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(body).error).toBe("Invalid API key provided.");
    expect(body).not.toContain("req_a_trace_id_nobody_should_read");
  });
});

/**
 * What an administrator is told when removing a server did not finish.
 *
 * CRITERION. `DELETE /servers/:id` answers every refusal its store call can raise, in the words
 * that refusal carries, and never as the framework's bodyless 500.
 *
 * REASON. The route mapped nothing at all, and what it is calling is the loudest method in the
 * store: `removeServer` revokes every person's brokered account at Composio BEFORE it deletes a
 * row, deliberately, so that a failure leaves access dead-and-present rather than live-and-
 * unreachable. Every one of those refusals is authored — a partial revoke naming how many configs
 * went, an auth-config listing Composio described unreadably — and every one of them reached
 * Hono's default handler instead, where a body is not a thing that exists. So the administrator
 * who had just half-withdrawn an app from everybody was told nothing whatever, on the one act in
 * this file whose half-done state somebody has to go and finish by hand.
 */
function removalApp(
  removeServer: () => Promise<never>,
  role: "admin" | "user" = "admin",
) {
  const store = pluginStore({
    removeServer,
    // Every read the plugins surface makes on its way to the route under test.
    listServers: async () => [],
    listSkills: async () => [],
  });

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; `store` is 15, pluginStore.
    ...UP_TO_PLUGIN_STORE,
    store,
  );

  return () =>
    app.request("http://openbot.test/api/plugins/servers/composio-slack", {
      method: "DELETE",
    });
}

describe("removing a server that could not be fully withdrawn", () => {
  test("a partial revoke is the broker's own sentence, not a bodyless 500", async () => {
    /*
     * THE HALF-DONE REMOVAL. `deleteAuthConfig` drops this deployment's own configs one at a time
     * and reports what was left standing, because a config left behind is a live grant the removal
     * was supposed to end. That count is the whole remedy — one of two went, so pressing Remove
     * again asks only for what is left — and it is exactly what an unmapped throw threw away.
     *
     * 503 with the refusal's own words, because a refusal this deployment authored is not a third
     * party being down: Composio answered, this deployment read the answer and decided.
     */
    const sentence =
      "Composio removed 1 of this deployment's 2 authorization configs for slack and the app has " +
      "not been fully withdrawn. Removing it again asks only for what is left.";
    const response = await removalApp(async () => {
      throw new BrokerRefusalError(sentence);
    })();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: sentence });
  });

  test("an unreadable auth-config listing reaches the administrator too", async () => {
    // The other loud refusal on this path, and the one whose remedy is NOT the button that was
    // just pressed: a row Composio described with no id and no name will be exactly as unreadable
    // next time, so the sentence names the dashboard instead. A 500 named neither.
    const sentence =
      "Composio described 1 of its authorization configs for slack in a way this deployment " +
      "cannot read, so whether one of them is already its own is not something it can tell.";
    const response = await removalApp(async () => {
      throw new BrokerRefusalError(sentence);
    })();

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain(
      "cannot read",
    );
  });

  test("a contradiction in this deployment's own rows is a 409 in its own words", async () => {
    /*
     * `accessFor` is asked which app this row stands for before anything is revoked, and a row
     * claiming to be two servers at once raises there. It is on the `isDeploymentFault` shelf, so
     * it is answered one branch above the broker mapping — and this route is admin-gated, which is
     * what makes showing that sentence here the right answer.
     */
    const sentence =
      "composio-slack resolves to a brokered credential with no app in its url, so there is " +
      "nothing to ask what it offers.";
    const response = await removalApp(async () => {
      throw new PluginInvariantError(sentence);
    })();

    expect(response.status).toBe(409);
    /*
     * THE BODY WHOLE, which is what pins the ordering. Move the broker mapping above the shelf and
     * this same throw comes back 502 saying "neither this deployment nor Composio said why" about a
     * disagreement between two of this deployment's own columns — sending an operator to check a
     * key that is fine, over a row only they can correct. Nothing else on this route pins that
     * sequence.
     */
    expect(await response.json()).toEqual({ error: sentence });
  });

  test("a failure nobody explained says what to press, and is logged", async () => {
    /*
     * The last class, and the one the default handler used to serve well: a bare `Error` carries
     * no sentence from either side, and an unhandled throw at least put the stack where an
     * operator could find it. Catching it fixes the answer and would silence the log, so the log
     * is kept — the same shape and the same restraint the enable route's is held to.
     *
     * The sentence blames neither side, because this call path is half this deployment's own
     * writes and half the broker's, and which half failed is precisely what nobody said.
     */
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };

    try {
      const response = await removalApp(async () => {
        throw Object.assign(new Error("fetch failed"), {
          apiKey: "ak_a_key_nobody_should_read",
        });
      })();

      expect(response.status).toBe(502);
      const refusal = ((await response.json()) as { error: string }).error;
      expect(refusal).toContain("Remove");
      // Never the thrown object's own text: on this path it is as likely to be a stack frame as a
      // sentence, and the console line is what carries it to an operator.
      expect(refusal).not.toContain("fetch failed");
    } finally {
      console.error = realError;
    }

    const line = said.find((said) => said.includes("mcp-server-not-removed"));
    expect(line).toBeDefined();
    expect(line).toContain("composio-slack");
    expect(line).toContain("fetch failed");
    expect(line).not.toContain("ak_a_key_nobody_should_read");
  });

  test("somebody who is not an administrator never reaches the store", async () => {
    let asked = false;
    const response = await removalApp(async () => {
      asked = true;
      throw new Error("unreachable");
    }, "user")();

    expect(response.status).toBe(403);
    expect(asked).toBe(false);
  });
});

describe("enabling an app whose row was written before the failure", () => {
  test("a row that cannot be read back is not Composio's fault", async () => {
    /*
     * WHERE THIS ARRIVES FROM. `addBrokeredApp` creates the auth config, inserts the row and
     * writes its `configuration.changed` trail entry, and only THEN refreshes and reads the row
     * back out of `listServers` — raising {@link CatalogueEntryUnknownError} when it is not
     * there. Every one of those steps has already committed by that point.
     *
     * Unmapped, it fell through to the broker tail, which said "Slack could not be enabled, and
     * Composio said nothing about why. Try again, and check this deployment's Composio key" — a
     * 502 that is wrong three times over: the app WAS enabled, Composio was never involved in the
     * step that failed, and the administrator was sent to check a key that is fine while a row
     * they now hold went unmentioned.
     *
     * This is also the one refusal the three sibling add routes all map and this one did not.
     */
    const { app } = directoryApp(undefined, "admin", [], async () => {
      throw new CatalogueEntryUnknownError("composio-slack");
    });

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "slack" }),
      },
    );

    // 409 rather than the 400 its siblings give this class: there, an unknown key is a caller
    // naming a server this deployment will not connect to. Here the row was written and this
    // deployment cannot see it, which is two of its own reads disagreeing.
    expect(response.status).toBe(409);
    const refusal = ((await response.json()) as { error: string }).error;
    // What actually happened, which is the half the administrator has to act on: the app is added.
    expect(refusal).toContain("was added");
    // And none of the vendor blame the generic tail carries.
    expect(refusal).not.toContain("could not be enabled");
    expect(refusal).not.toContain("Composio said nothing about why");
    expect(refusal).not.toContain("COMPOSIO_API_KEY");
  });
});

describe("the directory read that is not the vendor's", () => {
  test("a failed query on what is already enabled is a 409, not a 500", async () => {
    /*
     * THE CALL OUTSIDE THE `try`. This route wraps `listApps` — the vendor half — and then reads
     * `serverUrls` to mark which apps are already enabled, outside any mapping at all. A query
     * this database refused there left an administrator with the framework's bodyless 500 on the
     * one screen where a Composio key has just been set, which is the reading most likely to send
     * them back to the key over a fault that has nothing to do with it.
     *
     * The same 409 and the same sentence its sibling admin routes give the shelf, which is the
     * criterion those routes state: every admin route whose store call can reach a fault on the
     * `isDeploymentFault` shelf answers with the sentence rather than leaving it to the default
     * handler.
     */
    const { app } = directoryApp(undefined, "admin", [], null, async () => {
      throw Object.assign(
        new Error(
          'Failed query: select "url" from "mcp_servers" params: composio',
        ),
        {
          query: 'select "url" from "mcp_servers"',
          params: ["composio"],
          cause: new Error("canceling statement due to statement timeout"),
        },
      );
    });

    const response = await app.request(
      "http://openbot.test/api/plugins/composio/apps",
    );

    expect(response.status).toBe(409);
    const refusal = ((await response.json()) as { error: string }).error;
    expect(refusal).toContain("canceling statement due to statement timeout");
    // And none of the statement, for the reason the refresh route's own case gives: an
    // administrator is entitled to the reason, not to the dump.
    expect(refusal).not.toContain("Failed query");
    expect(refusal).not.toContain("mcp_servers");
    // Never the vendor sentence: Composio answered this request perfectly well.
    expect(refusal).not.toContain("COMPOSIO_API_KEY");
  });
});
