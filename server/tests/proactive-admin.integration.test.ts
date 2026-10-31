import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { createTurnRunner, type RunnerLike } from "@openbot/toolkit/run-turn";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { Observable } from "rxjs";
import {
  type EnterpriseControls,
  installEnterpriseControls,
  proactiveAdmin,
} from "../src/admin/controls";
import {
  createEnterpriseAdminRoutes,
  createProactiveAdminRoutes,
} from "../src/admin/routes";
import { DEFAULT_ENTERPRISE_SETTINGS } from "../src/admin/settings-store";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  botLifecycle,
  capabilitySettings,
  enterpriseSettings,
  modelUsage,
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
  userRoles,
  users,
  workItems,
} from "../src/db/schema";
import { createMemoryStore } from "../src/memory/store";
import { createPluginStore } from "../src/plugins/store";
import type {
  ProactiveMetricsResponse,
  ProactiveRunOutcome,
  ProactiveSkipReason,
} from "../src/proactive/contracts";
import {
  createProactiveEngine,
  DEFAULT_DAILY_RUNS,
} from "../src/proactive/engine";
import { createProactiveStore } from "../src/proactive/store";
import type {
  ProactiveSetting,
  SuggestionStatus,
} from "../src/proactive/types";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The admin's say over check-ins, through the real path: real Postgres, the real enterprise controls
 * and their routes, the real proactive store, work queue and headless turn runner, with the engine
 * asking `proactiveAdmin` exactly as the server wires it. The model is the only fake: a scripted
 * AG-UI agent that looks and finds nothing, so a request reaching it is a check-in that ran.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const admin = { id: `ci-admin-${suite}`, email: `ci-admin-${suite}@acme.test` };
/** A member in the sales group. */
const seller = {
  id: `ci-seller-${suite}`,
  email: `ci-seller-${suite}@acme.test`,
};
/** A member in no group. */
const member = {
  id: `ci-member-${suite}`,
  email: `ci-member-${suite}@acme.test`,
};
const people = [admin, seller, member];
const inboxBot = `ci-inbox-${suite}`;
const calendarBot = `ci-calendar-${suite}`;
const FAR = new Date("2100-01-01T00:00:00Z");

const store = createProactiveStore(database);
const queue = createWorkQueue(database);
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});

let controls: EnterpriseControls;
/** Each person's setting for each Bot, keyed `<person>:<bot>`. */
const settings = new Map<string, ProactiveSetting>();
const settingOf = (person: { id: string }, bot: string) =>
  settings.get(`${person.id}:${bot}`) as ProactiveSetting;

beforeAll(async () => {
  await database.insert(users).values([
    { ...admin, name: "Admin" },
    { ...seller, name: "Seller", groups: [`sales-${suite}`] },
    { ...member, name: "Member" },
  ]);
  await database.insert(userRoles).values({ userId: admin.id, role: "admin" });
  await database.insert(agents).values([
    { id: inboxBot, name: "Inbox Bot", type: "built_in", configuration: {} },
    {
      id: calendarBot,
      name: "Calendar Bot",
      type: "built_in",
      configuration: {},
    },
  ]);
  await database.insert(agentProfiles).values({
    agentId: inboxBot,
    ownerUserId: admin.id,
    title: "Inbox",
    roleDescription: "Reads mail",
    avatarSeed: `inbox-seed-${suite}`,
    visibility: "private",
  });
  for (const person of people)
    for (const bot of [inboxBot, calendarBot])
      settings.set(
        `${person.id}:${bot}`,
        await store.create(
          person.id,
          { agentId: bot, channelId: `ci-channel-${bot}-${person.id}` },
          `ci-thread-${randomUUID()}`,
        ),
      );
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    builtInModel: "openai/gpt-check-in",
    env: {},
  });
});

const settingIds = () => [...settings.values()].map((setting) => setting.id);

/** Every switch back to untouched, every setting on and not due, and nothing in the ledger. */
async function reset() {
  await database
    .delete(capabilitySettings)
    .where(eq(capabilitySettings.capability, "proactive"));
  await database
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, "proactive_daily_runs"));
  await controls.refresh();
  await database
    .delete(workItems)
    .where(
      and(
        eq(workItems.kind, "proactive.run"),
        inArray(sql<string>`${workItems.payload}->>'settingId'`, settingIds()),
      ),
    );
  await database
    .delete(proactiveSuggestions)
    .where(inArray(proactiveSuggestions.settingId, settingIds()));
  await database.delete(proactivePings).where(
    inArray(
      proactivePings.ownerUserId,
      people.map((person) => person.id),
    ),
  );
  await database
    .delete(proactiveRuns)
    .where(inArray(proactiveRuns.settingId, settingIds()));
  await database
    .delete(botLifecycle)
    .where(inArray(botLifecycle.agentId, [inboxBot, calendarBot]));
  await database
    .update(users)
    .set({ preferences: {} })
    .where(
      inArray(
        users.id,
        people.map((person) => person.id),
      ),
    );
  await database
    .update(proactiveSettings)
    .set({ enabled: true, nextRunAt: FAR, lastStatus: "idle", lastRunAt: null })
    .where(inArray(proactiveSettings.id, settingIds()));
}
beforeEach(reset);

afterAll(async () => {
  await reset();
  await controls?.stop();
  await database
    .delete(modelUsage)
    .where(inArray(modelUsage.agentId, [inboxBot, calendarBot]));
  await database
    .delete(proactiveSettings)
    .where(inArray(proactiveSettings.id, settingIds()));
  await database
    .delete(agents)
    .where(inArray(agents.id, [inboxBot, calendarBot]));
  await database.delete(users).where(like(users.email, `%${suite}%`));
  await database.$client.close();
});

/* ------------------------------------------------------------------------------------------------
 * The scripted model and the engine.
 * ---------------------------------------------------------------------------------------------- */

const runner: RunnerLike = {
  run: ({ agent, input }) =>
    new Observable((subscriber) => {
      agent
        .runAgent(input, { onEvent: ({ event }) => subscriber.next(event) })
        .then(
          () => subscriber.complete(),
          (error) => subscriber.error(error),
        );
    }),
  stop: async () => true,
};

/** A model that looked and found nothing, which every check-in may end with. */
function quietly(input: RunAgentInput): BaseEvent[] {
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "reply",
      role: "assistant",
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "reply",
      delta: "Looked at the inbox. Nothing new.",
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    },
  ] as BaseEvent[];
}

/**
 * One replica's engine, asking the admin's switch and cap through `proactiveAdmin` as the server
 * does. `asked` is the owner of every check-in that reached the model.
 */
function replica() {
  const asked: string[] = [];
  const turn = createTurnRunner({
    admission: serverTurnAdmission,
    intelligence: {
      getOrCreateThread: async () => undefined,
      getThreadMessages: async () => ({ messages: [] }),
      ɵacquireThreadLock: async () => undefined,
      ɵrenewThreadLock: async () => undefined,
      ɵcleanupThreadLock: async () => undefined,
    },
    runner,
    buildAgentFor: async () =>
      new HttpAgent({
        agentId: "bot",
        url: "https://agent.example/ag-ui",
        fetch: async (_url, init) => {
          const input = JSON.parse(String(init?.body)) as RunAgentInput;
          return new Response(
            quietly(input)
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      }),
    toolsForTurn: (input) => engine.toolsForTurn(input),
  });
  const engine = createProactiveEngine({
    store,
    memory: createMemoryStore(database),
    queue,
    owner: `ci-replica-${suite}-${randomUUID()}`,
    runTurn: async (input) => {
      asked.push(input.ownerUserId);
      return turn(input);
    },
    resolveScope: async (ownerUserId, channelId, agentId) => ({
      ownerUserId,
      channelId,
      agentId,
      threadId: `${channelId}-thread`,
    }),
    notify: async () => undefined,
    admin: proactiveAdmin,
    catalogue: plugins,
    deniedToolNames: async () => [],
    mintThreadId: () => `ci-check-in-${randomUUID()}`,
  });
  return { engine, asked };
}

/** Make these settings due, and sweep until every one of them has been tried. */
async function checkIn(...due: ProactiveSetting[]) {
  await database
    .update(proactiveSettings)
    .set({ nextRunAt: new Date(Date.now() - 1_000) })
    .where(
      inArray(
        proactiveSettings.id,
        due.map((setting) => setting.id),
      ),
    );
  const { engine, asked } = replica();
  for (let sweep = 0; sweep < due.length + 2; sweep += 1) await engine.sweep();
  return asked;
}

const lastRunOf = async (setting: ProactiveSetting) =>
  (await store.runs(setting.id))[0];

/* ------------------------------------------------------------------------------------------------
 * The admin's routes, signed in as somebody.
 * ---------------------------------------------------------------------------------------------- */

function appFor(actor: AuthenticatedActor) {
  const app = new Hono<{ Variables: AppVariables }>();
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  app.route("/api/admin/enterprise", createEnterpriseAdminRoutes(requireUser));
  app.route("/api/admin/proactive", createProactiveAdminRoutes(requireUser));
  return app;
}
const asAdmin = appFor({ ...admin, role: "admin" });
const asMember = appFor({ ...member, role: "user" });

const put = (app: ReturnType<typeof appFor>, path: string, body: unknown) =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const setSwitch = async (
  scopeKind: "organization" | "role" | "group",
  scopeId: string,
  allowed: boolean | null,
) =>
  expect(
    (
      await put(asAdmin, "/api/admin/enterprise/capabilities", {
        scopeKind,
        scopeId,
        capability: "proactive",
        allowed,
      })
    ).status,
  ).toBe(200);
const metrics = async (days?: 7 | 30) =>
  (await (
    await asAdmin.request(`/api/admin/proactive${days ? `?days=${days}` : ""}`)
  ).json()) as ProactiveMetricsResponse;
const botIn = (body: ProactiveMetricsResponse, agentId: string) =>
  body.bots.find((bot) => bot.agentId === agentId);

/* ------------------------------------------------------------------------------------------------
 * The tests.
 * ---------------------------------------------------------------------------------------------- */

describe("the Check-ins switch", () => {
  test("is a capability on Enterprise controls, on by default", async () => {
    const overview = (await (
      await asAdmin.request("/api/admin/enterprise")
    ).json()) as {
      capabilities: { capability: string; title: string; default: boolean }[];
      settings: { proactiveDailyRuns: number };
    };
    expect(
      overview.capabilities.find((row) => row.capability === "proactive"),
    ).toMatchObject({ title: "Check-ins", default: true });
    expect(overview.settings.proactiveDailyRuns).toBe(24);
    // The engine's own default, for a server without the controls, is the same number.
    expect(DEFAULT_ENTERPRISE_SETTINGS.proactiveDailyRuns).toBe(
      DEFAULT_DAILY_RUNS,
    );
  });

  test("turned off for the organization, every person's claimed check-in is skipped as off_admin before the model", async () => {
    await setSwitch("organization", "", false);
    const asked = await checkIn(
      settingOf(admin, inboxBot),
      settingOf(seller, inboxBot),
      settingOf(member, inboxBot),
    );
    expect(asked).toEqual([]);
    for (const person of people)
      expect(await lastRunOf(settingOf(person, inboxBot))).toMatchObject({
        outcome: "skipped",
        skipReason: "off_admin",
      });

    // Back on, the next check-in reaches the model.
    await setSwitch("organization", "", null);
    expect(await checkIn(settingOf(member, inboxBot))).toEqual([member.id]);
    expect(await lastRunOf(settingOf(member, inboxBot))).toMatchObject({
      outcome: "quiet",
    });
  });

  test("a role row of off covers its role, and a group row of on widens it for the group's members", async () => {
    await setSwitch("role", "user", false);
    const everyone = people.map((person) => settingOf(person, inboxBot));
    expect((await checkIn(...everyone)).sort()).toEqual([admin.id]);
    expect(await lastRunOf(settingOf(seller, inboxBot))).toMatchObject({
      outcome: "skipped",
      skipReason: "off_admin",
    });
    expect(await lastRunOf(settingOf(member, inboxBot))).toMatchObject({
      outcome: "skipped",
      skipReason: "off_admin",
    });

    await setSwitch("group", `sales-${suite}`, true);
    expect(
      (
        await checkIn(settingOf(seller, inboxBot), settingOf(member, inboxBot))
      ).sort(),
    ).toEqual([seller.id]);
    expect(await lastRunOf(settingOf(member, inboxBot))).toMatchObject({
      outcome: "skipped",
      skipReason: "off_admin",
    });

    // A group row of off narrows nothing: the organization's on still reaches its members.
    await setSwitch("role", "user", null);
    await setSwitch("group", `sales-${suite}`, false);
    expect(await checkIn(settingOf(seller, inboxBot))).toEqual([seller.id]);
  });
});

describe("the daily cap", () => {
  test("is per Bot: the check-in past the admin's number is skipped as capped and counted, and another Bot still runs", async () => {
    // Only an admin's whole number from 1 to 1440 is saved.
    for (const value of [0, 1441, 2.5, "3"])
      expect(
        (
          await put(
            asAdmin,
            "/api/admin/enterprise/settings/proactiveDailyRuns",
            {
              value,
            },
          )
        ).status,
      ).toBe(400);
    const saved = await put(
      asAdmin,
      "/api/admin/enterprise/settings/proactiveDailyRuns",
      { value: 2 },
    );
    expect(saved.status).toBe(200);
    expect(await proactiveAdmin.proactiveDailyRuns(inboxBot)).toBe(2);

    const inbox = settingOf(member, inboxBot);
    const calendar = settingOf(member, calendarBot);
    expect(await checkIn(inbox)).toEqual([member.id]);
    expect(await checkIn(inbox)).toEqual([member.id]);
    // The third in a day is past the cap: no model call.
    expect(await checkIn(inbox)).toEqual([]);
    expect(await lastRunOf(inbox)).toMatchObject({
      outcome: "skipped",
      skipReason: "capped",
    });
    // The same person's other Bot has its own day.
    expect(await checkIn(calendar)).toEqual([member.id]);

    const body = await metrics();
    expect(body.dailyRuns).toBe(2);
    expect(botIn(body, inboxBot)?.runs).toMatchObject({
      quiet: 2,
      skipped: { capped: 1 },
    });
    expect(botIn(body, calendarBot)?.runs).toMatchObject({
      quiet: 1,
      skipped: { capped: 0 },
    });

    // The change is on the audit trail with who made it, like every other enterprise setting.
    const trail = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "enterprise.setting_changed"),
          eq(auditEvents.targetId, "proactiveDailyRuns"),
          eq(auditEvents.actorUserId, admin.id),
        ),
      );
    expect(trail.map((row) => row.payload)).toContainEqual({
      setting: "proactiveDailyRuns",
      before: 24,
      after: 2,
      by: admin.email,
    });
  });
});

describe("the numbers", () => {
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000);
  const DAY = 24 * 60;

  async function seedRuns(
    setting: ProactiveSetting,
    runs: [ProactiveRunOutcome, ProactiveSkipReason | null, number][],
  ) {
    await database.insert(proactiveRuns).values(
      runs.map(([outcome, skipReason, agoMinutes]) => ({
        id: `ci-run-${randomUUID()}`,
        settingId: setting.id,
        ownerUserId: setting.ownerUserId,
        agentId: setting.agentId,
        trigger: "schedule" as const,
        outcome,
        skipReason,
        startedAt: minutesAgo(agoMinutes),
        finishedAt: outcome === "running" ? null : minutesAgo(agoMinutes - 1),
      })),
    );
  }
  async function seedItems(
    setting: ProactiveSetting,
    items: [string, SuggestionStatus, number, boolean][],
  ) {
    await database.insert(proactiveSuggestions).values(
      items.map(([title, status, agoMinutes, pinged]) => ({
        id: `ci-item-${randomUUID()}`,
        ownerUserId: setting.ownerUserId,
        agentId: setting.agentId,
        settingId: setting.id,
        runId: `ci-run-${randomUUID()}`,
        title,
        detail: `Why: ${title}`,
        sourceApp: "Mail",
        sourceRef: "mail/list_messages",
        status,
        createdAt: minutesAgo(agoMinutes),
        deliveredAt: pinged ? minutesAgo(agoMinutes - 1) : null,
        resolvedAt: status === "open" ? null : minutesAgo(agoMinutes - 2),
      })),
    );
  }

  test("count runs, items and pings per Bot, with acceptance, and carry no titles and no people", async () => {
    const before = await metrics(7);
    const before30 = await metrics(30);
    const inbox = settingOf(member, inboxBot);
    const calendar = settingOf(member, calendarBot);
    await seedRuns(inbox, [
      ["quiet", null, 60],
      ["quiet", null, 120],
      ["quiet", null, 180],
      ["raised", null, 240],
      ["raised", null, 300],
      ["failed", null, 360],
      ["skipped", "capped", 420],
      ["skipped", "paused", 480],
      ["skipped", "paused", 540],
      ["skipped", "off_admin", 600],
      // Still running: it has not ended, so it is in none of the counts.
      ["running", null, 2],
      // Ten days ago: in the 30-day window only.
      ["quiet", null, 10 * DAY],
    ]);
    await seedItems(inbox, [
      ["Reply to Dana about the Q3 plan", "started", 300, true],
      ["Sign the supplier contract", "started", 300, true],
      ["Archive the newsletter", "dismissed", 240, true],
      ["Book the offsite", "superseded", 240, false],
      ["Answer the board", "open", 240, false],
      ["Renew the lease", "started", 10 * DAY, true],
    ]);
    await seedItems(calendar, [["Move the standup", "open", 60, false]]);
    await database.insert(proactivePings).values([
      {
        id: `ci-ping-${randomUUID()}`,
        ownerUserId: member.id,
        itemCount: 3,
        text: "3 things need you",
        pushBody: "3 things need you",
        createdAt: minutesAgo(300),
        offeredAt: minutesAgo(299),
      },
      {
        id: `ci-ping-${randomUUID()}`,
        ownerUserId: member.id,
        itemCount: 1,
        text: "One thing needs you",
        pushBody: "One thing needs you",
        createdAt: minutesAgo(60),
        offeredAt: minutesAgo(59),
      },
      // Written but never offered: it reached nobody.
      {
        id: `ci-ping-${randomUUID()}`,
        ownerUserId: member.id,
        itemCount: 5,
        text: "5 things need you",
        pushBody: "5 things need you",
        createdAt: minutesAgo(5),
      },
      {
        id: `ci-ping-${randomUUID()}`,
        ownerUserId: seller.id,
        itemCount: 4,
        text: "4 things need you",
        pushBody: "4 things need you",
        createdAt: minutesAgo(10 * DAY),
        offeredAt: minutesAgo(10 * DAY - 1),
      },
    ]);
    // Who is checked on now: everybody's settings are on; the admin turned their own off for all
    // their Bots, the seller paused the calendar Bot, and the member turned the calendar Bot off.
    await database
      .update(users)
      .set({ preferences: { proactive: "off" } })
      .where(eq(users.id, admin.id));
    await database.insert(botLifecycle).values({
      ownerUserId: seller.id,
      agentId: calendarBot,
      pausedAt: new Date(),
    });
    await database
      .update(proactiveSettings)
      .set({ enabled: false })
      .where(eq(proactiveSettings.id, calendar.id));

    const week = await metrics();
    expect(week.days).toBe(7);
    expect(week.dailyRuns).toBe(24);
    expect(botIn(week, inboxBot)).toEqual({
      agentId: inboxBot,
      name: "Inbox Bot",
      avatarSeed: `inbox-seed-${suite}`,
      peopleOn: 2,
      runs: {
        quiet: 3,
        raised: 2,
        failed: 1,
        skipped: {
          off_admin: 1,
          off_person: 0,
          paused: 2,
          capped: 1,
          unreachable: 0,
          no_sources: 0,
          busy: 0,
        },
      },
      items: { raised: 5, started: 2, hidden: 1, cleared: 1, open: 1 },
      acceptance: 2 / 3,
      pinged: 3,
    });
    // Nobody decided anything the calendar Bot raised yet, so there is no acceptance to show. A Bot
    // with no picture of its own is drawn from its id, as everywhere else.
    expect(botIn(week, calendarBot)).toMatchObject({
      name: "Calendar Bot",
      avatarSeed: calendarBot,
      peopleOn: 0,
      items: { raised: 1, open: 1 },
      acceptance: null,
    });
    // Bots are listed by name.
    const ours = week.bots
      .filter((bot) => [inboxBot, calendarBot].includes(bot.agentId))
      .map((bot) => bot.name);
    expect(ours).toEqual(["Calendar Bot", "Inbox Bot"]);
    // Pings belong to nobody's Bot: two offered this week, three items and one.
    expect(week.pings.sent).toBe(before.pings.sent + 2);
    const sum = (body: ProactiveMetricsResponse) =>
      body.pings.sent * (body.pings.itemsPerPing ?? 0);
    expect(week.pings.itemsPerPing).toBeCloseTo(
      (sum(before) + 4) / (before.pings.sent + 2),
    );

    const month = await metrics(30);
    expect(botIn(month, inboxBot)).toMatchObject({
      runs: { quiet: 4 },
      items: { raised: 6, started: 3, hidden: 1 },
      acceptance: 3 / 4,
      pinged: 4,
    });
    expect(month.pings.sent).toBe(before30.pings.sent + 3);

    // Counts only: no title, no why, no person anywhere in what an admin reads.
    const text = JSON.stringify([week, month]);
    for (const secret of [
      "Dana",
      "supplier",
      "newsletter",
      "Why:",
      "things need you",
      ...people.flatMap((person) => [person.id, person.email]),
    ])
      expect(text).not.toContain(secret);
  });

  test("are an admin's alone, as is the cap", async () => {
    expect((await asMember.request("/api/admin/proactive")).status).toBe(403);
    expect(
      (
        await put(
          asMember,
          "/api/admin/enterprise/settings/proactiveDailyRuns",
          {
            value: 100,
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await put(asMember, "/api/admin/enterprise/capabilities", {
          scopeKind: "organization",
          capability: "proactive",
          allowed: false,
        })
      ).status,
    ).toBe(403);
    expect(await proactiveAdmin.proactiveDailyRuns(inboxBot)).toBe(24);
    expect(await proactiveAdmin.proactiveAllowed(member.id)).toBe(true);
    // Only the two windows the page offers.
    const refused = await asAdmin.request("/api/admin/proactive?days=14");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'Query parameter "days" must be 7 or 30.',
    });
  });
});
