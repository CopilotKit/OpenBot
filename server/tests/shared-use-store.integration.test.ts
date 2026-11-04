// server/tests/shared-use-store.integration.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  responsibilities,
  sharedUseApprovals,
  sharedUseRequests,
  users,
} from "../src/db/schema";
import {
  createSharedUseGate,
  createSharedUseStore,
} from "../src/plugins/shared-use-store";
import { expectOnlyRefusal } from "./helpers/refusals";
import {
  changeAccess,
  changeBot,
  grantBot,
  removeBots,
  seedBot,
} from "./support/bots";

/** Publish a Bot to named people and groups, as its owner's publish does. */
async function publishTo(
  botId: string,
  publishedBy: string,
  members: { kind: "user" | "group"; value: string }[],
) {
  await changeAccess([
    { op: "publish", botId, audience: "people", members, publishedBy },
  ]);
}
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  createTestPolicyCache,
  storedConnectionApprovals,
  useTestPolicy,
} from "./support/policy";

// Shared app approvals and approval rules are Intelligence's organization policy.
beforeAll(async () => {
  await useTestPolicy();
});
import {
  changeServer,
  removeServers,
  seedServer,
  useTestVault,
} from "./support/vault";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${suite}`;
const app = id("gh");
const bot = id("bot");
const store = createSharedUseStore(database, "composio");
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

beforeAll(async () => {
  await useTestVault();
});

beforeEach(async () => {
  await database
    .delete(sharedUseRequests)
    .where(eq(sharedUseRequests.agentId, bot));
  await removeBots([bot]);
  // Takes the app's approvals, requests and grants here with it, as the cascade from mcp_servers did.
  await removeServers([app]);
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
  await seedServer({
    id: app,
    title: "Team GitHub",
    vendor: "Composio",
    url: `composio://${app}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "shared",
    sharedVendorUserId: "openbot-deployment:x:R",
  });
  await seedBot({
    id: bot,
    name: "Triage",
    type: "built_in",
    ownerUserId: id("owner"),
    visibility: "private",
    title: "Triage",
    roleDescription: "Triage",
    avatarSeed: "x",
  });
  await grantBot(bot, "mcp", `${app}/GITHUB_LIST_ISSUES`, {
    grantedBy: "admin@example.test",
  });
});

afterAll(async () => {
  await removeBots([bot]);
  // Takes the app's approvals, requests and grants here with it, as the cascade from mcp_servers did.
  await removeServers([app]);
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
    await publishTo(bot, id("owner"), [
      { kind: "user", value: id("stranger") },
    ]);
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

describe("approval members", () => {
  test("repeated people and groups store one exact membership without widening access", async () => {
    await store.setApproval({
      botId: bot,
      serverId: app,
      by: id("owner"),
      approval: {
        audience: "people",
        outsideInput: false,
        members: [
          { kind: "user", value: id("named") },
          { kind: "user", value: id("named") },
          { kind: "group", value: "platform" },
          { kind: "group", value: "platform" },
          { kind: "group", value: id("named") },
        ],
      },
    });
    const approval = await store.approvalFor(bot, app);
    expect(approval?.members).toHaveLength(3);
    expect(approval?.members).toEqual(
      expect.arrayContaining([
        { kind: "user", value: id("named") },
        { kind: "group", value: "platform" },
        { kind: "group", value: id("named") },
      ]),
    );
    expect((await call("named")).allowed).toBe(true);
    expect((await call("newhire")).allowed).toBe(true);
    expect((await call("stranger")).allowed).toBe(false);
  });

  test("an audience also assigned to the Bot can be approved", async () => {
    await publishTo(bot, id("owner"), [{ kind: "group", value: "platform" }]);
    await changeAccess([
      {
        op: "assign",
        botId: bot,
        group: "platform",
        assignedBy: id("owner"),
      },
    ]);
    await call("newhire");
    const [pending] = await store.pendingFor(bot);
    expect(pending?.proposed.members).toEqual([
      { kind: "group", value: "platform" },
    ]);
    await store.decide({
      id: pending!.id,
      by: id("admin"),
      decision: "approve",
    });
    expect((await store.approvalFor(bot, app))?.members).toEqual([
      { kind: "group", value: "platform" },
    ]);
    expect((await call("newhire")).allowed).toBe(true);
    expect((await call("stranger")).allowed).toBe(false);
  });
});

describe("decision durability", () => {
  test("a direct approval made while a decision waits on its request stands, and both complete", async () => {
    /*
     * The decision and a direct approval used to be serialized by an advisory lock, and the one that
     * came later won. There is no lock now: the decision is written over the approval stored when it
     * began, so an administrator's approval stored while it waits is never replaced by it.
     */
    await call("stranger");
    const [pending] = await store.pendingFor(bot);
    const blocker = createDatabase(testDatabaseUrl(), { max: 1 });
    const deciding = createDatabase(testDatabaseUrl(), { max: 1 });
    const setting = createDatabase(testDatabaseUrl(), { max: 1 });
    const decidingName = `approval_deciding_${suite}`;
    const settingName = `approval_setting_${suite}`;
    await deciding.execute(
      sql`select set_config('application_name', ${decidingName}, false)`,
    );
    await setting.execute(
      sql`select set_config('application_name', ${settingName}, false)`,
    );
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const gate = blocker.transaction(async (tx) => {
      await tx
        .select()
        .from(sharedUseRequests)
        .where(eq(sharedUseRequests.id, pending!.id))
        .for("update");
      locked.resolve();
      await release.promise;
    });
    void gate.catch(locked.reject);
    const operations: Promise<unknown>[] = [];
    async function waitForDatabaseLock(name: string) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await database.execute(
          sql`select wait_event_type from pg_stat_activity where application_name = ${name} and datname = current_database()`,
        );
        if (rows.some((row) => row.wait_event_type === "Lock")) return;
      }
      throw new Error(
        `The database did not report the expected lock wait for ${name}`,
      );
    }
    try {
      await locked.promise;
      operations.push(
        createSharedUseStore(deciding, "composio").decide({
          id: pending!.id,
          by: id("admin"),
          decision: "approve",
        }),
      );
      await waitForDatabaseLock(decidingName);
      operations.push(
        createSharedUseStore(setting, "composio").setApproval({
          botId: bot,
          serverId: app,
          by: id("owner"),
          approval: { audience: "team", outsideInput: true, members: [] },
        }),
      );
      await waitForDatabaseLock(settingName);
      release.resolve();
      await gate;
      const outcomes = await Promise.allSettled(operations);
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      expect((await store.approvalFor(bot, app))?.audience).toBe("team");
      expect(
        (await storedConnectionApprovals({ agentId: bot }))[0]?.audience,
      ).toBe("team");
      expect(await store.pendingFor(bot)).toHaveLength(0);
    } finally {
      release.resolve();
      await Promise.allSettled([gate, ...operations]);
      await Promise.all([
        blocker.$client.end(),
        deciding.$client.end(),
        setting.$client.end(),
      ]);
    }
  }, 15000);

  test("an approval Intelligence refuses leaves the request pending and retryable", async () => {
    await publishTo(bot, id("owner"), [{ kind: "group", value: "platform" }]);
    await call("newhire");
    const [pending] = await store.pendingFor(bot);
    // A group name longer than Intelligence keeps, so the approval write is refused after the claim.
    await database
      .update(sharedUseRequests)
      .set({ proposedMembers: [{ kind: "group", value: "x".repeat(501) }] })
      .where(eq(sharedUseRequests.id, pending!.id));
    await expect(
      store.decide({
        id: pending!.id,
        by: id("admin"),
        decision: "approve",
      }),
    ).rejects.toThrow();
    const [row] = await database
      .select()
      .from(sharedUseRequests)
      .where(eq(sharedUseRequests.id, pending!.id));
    expect(row?.status).toBe("pending");
    expect(row?.decidedAt).toBeNull();
    expect(await store.approvalFor(bot, app)).toBeNull();
    expect(await storedConnectionApprovals({ agentId: bot })).toHaveLength(0);

    await database
      .update(sharedUseRequests)
      .set({ proposedMembers: [{ kind: "group", value: "platform" }] })
      .where(eq(sharedUseRequests.id, pending!.id));
    await store.decide({
      id: pending!.id,
      by: id("admin"),
      decision: "approve",
    });
    expect(await store.pendingFor(bot)).toHaveLength(0);
    expect((await store.approvalFor(bot, app))?.members).toEqual([
      { kind: "group", value: "platform" },
    ]);
    expect((await call("newhire")).allowed).toBe(true);
    expect((await call("stranger")).allowed).toBe(false);
  });

  test("approving writes Intelligence and never this deployment's own tables", async () => {
    await call("stranger");
    const [pending] = await store.pendingFor(bot);
    await store.decide({
      id: pending!.id,
      by: id("admin"),
      decision: "approve",
    });
    expect(await storedConnectionApprovals({ agentId: bot })).toHaveLength(1);
    expect(
      await database
        .select()
        .from(sharedUseApprovals)
        .where(eq(sharedUseApprovals.agentId, bot)),
    ).toHaveLength(0);
  });
});

describe("owner approvals", () => {
  test.each(["owner", "people"] as const)(
    "an owner's grant on a server that has not heard of an administrator's %s approval cannot replace it",
    async (audience) => {
      const approval = {
        audience,
        outsideInput: false,
        members:
          audience === "people"
            ? [{ kind: "user" as const, value: id("named") }]
            : [],
      };
      await changeServer(app, { ownerGrants: "any" });
      await changeBot(bot, { visibility: "public" });
      // Another server, read before the administrator's approval and deaf to announcements since.
      const behind = createTestPolicyCache({ subscribe: false });
      await behind.start();
      behind.stop();
      try {
        await store.setApproval({
          botId: bot,
          serverId: app,
          by: id("admin"),
          approval,
        });
        // It still believes there is no approval, so the owner's grant tries to fill the absence.
        expect(
          behind.connectionApproval({ agentId: bot, connectionId: app }),
        ).toBeUndefined();
        const ownerStore = createSharedUseStore(database, "composio", behind);
        expect(
          await ownerStore.approveOwnerGrant({
            botId: bot,
            serverId: app,
            by: id("owner"),
          }),
        ).toBeNull();
        expect(await store.approvalSource(bot, app)).toBe("admin");
        expect(await store.approvalFor(bot, app)).toEqual(approval);
        const [stored] = await storedConnectionApprovals({ agentId: bot });
        expect(stored?.approvedAs).toBe("admin");
      } finally {
        behind.stop();
      }
    },
  );
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
    await publishTo(bot, id("owner"), [{ kind: "group", value: "platform" }]);
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
    await removeBots([other]);
    await removeServers([duplicate]);
    await seedServer({
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
    await removeBots([other]);
    await removeServers([duplicate]);
  });

  test("appIdOf names the answering row for either id", async () => {
    expect(await store.appIdOf(duplicate)).toBe(app);
    expect(await store.appIdOf(app)).toBe(app);
  });

  test("an approval written through the duplicate is the one the gate reads by the answering id", async () => {
    await changeAccess([{ op: "revokeMatching", kind: "mcp", botIds: [bot] }]);
    await grantBot(bot, "mcp", `${duplicate}/GITHUB_LIST_ISSUES`, {
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
    await grantBot(bot, "mcp", `${duplicate}/GITHUB_CREATE_ISSUE`, {
      grantedBy: "admin@example.test",
    });
    expect(await store.sharedAppsHeldBy(bot)).toEqual([
      { serverId: app, title: "Team GitHub" },
    ]);
  });

  test("botsHolding the answering id includes a Bot granted only through the duplicate", async () => {
    await seedBot({ id: other, name: "Other", type: "built_in" });
    await grantBot(other, "mcp", `${duplicate}/GITHUB_LIST_ISSUES`, {
      grantedBy: "admin@example.test",
    });
    const holding = await store.botsHolding(app);
    expect(holding).toContain(other);
    expect(holding).toContain(bot);
  });

  test("a row at the app's url with a trailing slash still answers through the canonical row", async () => {
    const slashy = `${app}-slash`;
    await removeServers([slashy]);
    await seedServer({
      id: slashy,
      title: "Team GitHub (slash)",
      vendor: "Composio",
      url: `composio://${app}/`,
      provenance: "composio",
      authScheme: "OAUTH2",
      accountMode: "personal",
    });
    try {
      await changeAccess([
        { op: "revokeMatching", kind: "mcp", botIds: [bot] },
      ]);
      await grantBot(bot, "mcp", `${slashy}/GITHUB_LIST_ISSUES`, {
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
      await removeServers([slashy]);
    }
  });
});

afterAll(async () => {
  await database.$client.close();
});
