// server/tests/shared-use-store.integration.test.ts
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  mcpServers,
  pluginGrants,
  responsibilities,
  sharedUseRequests,
  teamBotAudience,
  teamBotPublications,
  users,
} from "../src/db/schema";
import {
  createSharedUseGate,
  createSharedUseStore,
} from "../src/plugins/shared-use-store";
import { expectOnlyRefusal } from "./helpers/refusals";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${suite}`;
const app = id("gh");
const bot = id("bot");
const store = createSharedUseStore(database);
const gate = createSharedUseGate(store, createAuditStore(database));

async function seedUser(name: string, groups: string[] = []) {
  // users requires the NOT NULL columns in server/src/db/schema/core.ts:60-90; set each one here.
  await database.insert(users).values({
    id: id(name),
    email: `${id(name)}@example.test`,
    name,
    emailVerified: true,
    groups,
  });
}

beforeEach(async () => {
  await database
    .delete(sharedUseRequests)
    .where(eq(sharedUseRequests.agentId, bot));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(mcpServers).where(eq(mcpServers.id, app));
  await database
    .delete(users)
    .where(
      inArray(
        users.id,
        ["owner", "admin", "named", "newhire", "stranger"].map(id),
      ),
    );
  await seedUser("owner");
  await seedUser("named");
  await seedUser("newhire", ["platform"]);
  await seedUser("stranger");
  await database.insert(mcpServers).values({
    id: app,
    title: "Team GitHub",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "shared",
    sharedVendorUserId: "openbot-deployment:x:R",
  });
  await database
    .insert(agents)
    .values({ id: bot, name: "Triage", type: "built_in", configuration: {} });
  await database.insert(agentProfiles).values({
    agentId: bot,
    ownerUserId: id("owner"),
    visibility: "private",
    title: "Triage",
    roleDescription: "Triage",
    avatarSeed: "x",
  });
  await database.insert(pluginGrants).values({
    kind: "mcp",
    ref: `${app}/GITHUB_LIST_ISSUES`,
    agentId: bot,
    grantedBy: "admin@example.test",
  });
});

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(mcpServers).where(eq(mcpServers.id, app));
  await database
    .delete(users)
    .where(
      inArray(
        users.id,
        ["owner", "admin", "named", "newhire", "stranger"].map(id),
      ),
    );
});

const call = (
  actor: string,
  initiator: Parameters<typeof gate>[0]["initiator"] | null = {
    kind: "person",
  },
) =>
  gate({
    botId: bot,
    serverId: app,
    title: "Team GitHub",
    actorId: id(actor),
    ...(initiator ? { initiator } : {}),
  });

describe("the shared-use gate", () => {
  test("with no approval, even the owner is refused and one request is filed", async () => {
    const answer = await call("owner");
    expect(answer.allowed).toBe(false);
    if (!answer.allowed)
      expectOnlyRefusal(answer.message, "sharedAudience", "Team GitHub");
    expect(await store.pendingFor(bot)).toHaveLength(1);
  });

  test("a second refusal does not file a second request", async () => {
    await call("stranger");
    await call("stranger");
    expect(await store.pendingFor(bot)).toHaveLength(1);
  });

  test("owner-only admits the owner and refuses a stranger", async () => {
    await store.setApproval({
      botId: bot,
      serverId: app,
      by: id("owner"),
      approval: { audience: "owner", outsideInput: false, members: [] },
    });
    expect((await call("owner")).allowed).toBe(true);
    expect((await call("stranger")).allowed).toBe(false);
  });

  test("people admits the approved list and group members, and refuses someone added later", async () => {
    await store.setApproval({
      botId: bot,
      serverId: app,
      by: id("owner"),
      approval: {
        audience: "people",
        outsideInput: false,
        members: [
          { kind: "user", value: id("named") },
          { kind: "group", value: "platform" },
        ],
      },
    });
    expect((await call("named")).allowed).toBe(true);
    expect((await call("newhire")).allowed).toBe(true);
    await database
      .insert(teamBotPublications)
      .values({ agentId: bot, publishedBy: id("owner"), audience: "people" });
    await database
      .insert(teamBotAudience)
      .values({ agentId: bot, kind: "user", value: id("stranger") });
    expect((await call("stranger")).allowed).toBe(false);
  });

  test("a Bot that subscribed itself to email is refused on its next shared call", async () => {
    await store.setApproval({
      botId: bot,
      serverId: app,
      by: id("owner"),
      approval: { audience: "team", outsideInput: false, members: [] },
    });
    const [goal] = await database
      .insert(responsibilities)
      .values({
        id: id("goal"),
        ownerUserId: id("owner"),
        agentId: bot,
        title: "Watch mail",
        instruction: "x",
        channelId: id("ch"),
        threadId: id("th"),
        successCriteria: "x",
        subscriptions: [{ source: "email", eventType: "*" }],
      })
      .returning({ id: responsibilities.id });
    const answer = await call("owner", {
      kind: "responsibility",
      id: goal!.id,
    });
    expect(answer.allowed).toBe(false);
    expect(await store.pendingFor(bot)).toEqual([
      expect.objectContaining({
        reason: "refused_call",
        proposed: expect.objectContaining({ outsideInput: true }),
      }),
    ]);
  });

  test("email → A → B → this Bot is refused when outside input was not approved", async () => {
    await store.setApproval({
      botId: bot,
      serverId: app,
      by: id("owner"),
      approval: { audience: "team", outsideInput: false, members: [] },
    });
    await database.insert(responsibilities).values({
      id: id("mailgoal"),
      ownerUserId: id("owner"),
      agentId: bot,
      title: "x",
      instruction: "x",
      channelId: id("ch"),
      threadId: id("th"),
      successCriteria: "x",
      subscriptions: [{ source: "email", eventType: "*" }],
    });
    const answer = await call("owner", {
      kind: "handoff",
      id: "bot_b",
      origin: { kind: "responsibility", id: id("mailgoal") },
    });
    expect(answer.allowed).toBe(false);
  });

  test("a person who reaches the Bot only through a handoff is checked as themselves", async () => {
    await store.setApproval({
      botId: bot,
      serverId: app,
      by: id("owner"),
      approval: { audience: "owner", outsideInput: false, members: [] },
    });
    expect(
      (
        await call("stranger", {
          kind: "handoff",
          id: "public_a",
          origin: { kind: "person" },
        })
      ).allowed,
    ).toBe(false);
  });

  test("a call that does not say what started its run is refused, and files no request", async () => {
    await store.setApproval({
      botId: bot,
      serverId: app,
      by: id("owner"),
      approval: { audience: "team", outsideInput: true, members: [] },
    });
    const answer = await call("owner", null);
    expect(answer.allowed).toBe(false);
    if (!answer.allowed) {
      expectOnlyRefusal(answer.message, "sharedSteering", "Team GitHub");
      expect(answer.refusal).toBe("shared_steering");
    }
    expect(await store.pendingFor(bot)).toHaveLength(0);
  });

  test("a handoff with no origin is refused", async () => {
    await store.setApproval({
      botId: bot,
      serverId: app,
      by: id("owner"),
      approval: { audience: "team", outsideInput: true, members: [] },
    });
    expect((await call("owner", { kind: "handoff", id: "x" })).allowed).toBe(
      false,
    );
  });
});

describe("decide", () => {
  test("two admins deciding one request record exactly one decision", async () => {
    await call("stranger");
    const [pending] = await store.pendingFor(bot);
    const results = await Promise.allSettled([
      store.decide({ id: pending!.id, by: id("admin1"), decision: "approve" }),
      store.decide({ id: pending!.id, by: id("admin2"), decision: "decline" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  test("approving writes the proposed approval, members included", async () => {
    await database
      .insert(teamBotPublications)
      .values({ agentId: bot, publishedBy: id("owner"), audience: "people" });
    await database
      .insert(teamBotAudience)
      .values({ agentId: bot, kind: "group", value: "platform" });
    await call("newhire");
    const [pending] = await store.pendingFor(bot);
    await store.decide({
      id: pending!.id,
      by: id("admin"),
      decision: "approve",
    });
    expect(await store.approvalFor(bot, app)).toEqual({
      audience: "people",
      outsideInput: false,
      members: [{ kind: "group", value: "platform" }],
    });
    expect((await call("newhire")).allowed).toBe(true);
  });
});

describe("an app with a duplicate row at its url", () => {
  /*
   * THE DUPLICATE SORTS AFTER THE ANSWERING ROW (`gh-<suite>` < `gh-<suite>-dup`), so `app` stays
   * the row that answers for `composio://<app>` and the duplicate is the one a grant can be made
   * through without being the authority.
   */
  const duplicate = `${app}-dup`;
  const other = id("otherbot");

  beforeEach(async () => {
    await database.delete(agents).where(eq(agents.id, other));
    await database.delete(mcpServers).where(eq(mcpServers.id, duplicate));
    await database.insert(mcpServers).values({
      id: duplicate,
      title: "Team GitHub (copy)",
      vendor: "Composio",
      url: `composio://${app}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      accountMode: "personal",
    });
  });

  afterAll(async () => {
    await database.delete(agents).where(eq(agents.id, other));
    await database.delete(mcpServers).where(eq(mcpServers.id, duplicate));
  });

  test("appIdOf names the answering row for either id", async () => {
    expect(await store.appIdOf(duplicate)).toBe(app);
    expect(await store.appIdOf(app)).toBe(app);
  });

  test("an approval written through the duplicate is the one the gate reads by the answering id", async () => {
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, bot));
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: `${duplicate}/GITHUB_LIST_ISSUES`,
      agentId: bot,
      grantedBy: "admin@example.test",
    });
    await store.setApproval({
      botId: bot,
      serverId: duplicate,
      by: id("owner"),
      approval: { audience: "owner", outsideInput: false, members: [] },
    });
    expect(await store.approvalFor(bot, app)).toEqual({
      audience: "owner",
      outsideInput: false,
      members: [],
    });
    expect((await call("owner")).allowed).toBe(true);
    expect(await store.pendingFor(bot)).toHaveLength(0);
  });

  test("sharedAppsHeldBy lists the app once, by its answering row, when both rows are granted", async () => {
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: `${duplicate}/GITHUB_CREATE_ISSUE`,
      agentId: bot,
      grantedBy: "admin@example.test",
    });
    expect(await store.sharedAppsHeldBy(bot)).toEqual([
      { serverId: app, title: "Team GitHub" },
    ]);
  });

  test("botsHolding the answering id includes a Bot granted only through the duplicate", async () => {
    await database.insert(agents).values({
      id: other,
      name: "Other",
      type: "built_in",
      configuration: {},
    });
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: `${duplicate}/GITHUB_LIST_ISSUES`,
      agentId: other,
      grantedBy: "admin@example.test",
    });
    const holding = await store.botsHolding(app);
    expect(holding).toContain(other);
    expect(holding).toContain(bot);
  });

  test("a row at the app's url with a trailing slash still answers through the canonical row", async () => {
    const slashy = `${app}-slash`;
    await database.delete(mcpServers).where(eq(mcpServers.id, slashy));
    await database.insert(mcpServers).values({
      id: slashy,
      title: "Team GitHub (slash)",
      vendor: "Composio",
      url: `composio://${app}/`,
      provenance: "composio",
      authScheme: "OAUTH2",
      accountMode: "personal",
    });
    try {
      await database.delete(pluginGrants).where(eq(pluginGrants.agentId, bot));
      await database.insert(pluginGrants).values({
        kind: "mcp",
        ref: `${slashy}/GITHUB_LIST_ISSUES`,
        agentId: bot,
        grantedBy: "admin@example.test",
      });
      await store.setApproval({
        botId: bot,
        serverId: slashy,
        by: id("owner"),
        approval: { audience: "owner", outsideInput: false, members: [] },
      });
      expect(await store.approvalFor(bot, app)).toEqual({
        audience: "owner",
        outsideInput: false,
        members: [],
      });
      expect(await store.botsHolding(app)).toContain(bot);
    } finally {
      await database.delete(mcpServers).where(eq(mcpServers.id, slashy));
    }
  });
});
