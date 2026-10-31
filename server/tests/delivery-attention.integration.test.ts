import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  configureBotLifecycle,
  createBotLifecycleStore,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";
import {
  type BotLifecycleServices,
  createBotLifecycleRoutes,
} from "../src/agents/lifecycle-routes";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema/core";
import {
  deliveryBindings,
  deliveryInbox,
  deliveryOutbox,
} from "../src/db/schema/delivery";
import {
  botLifecycle,
  updateRoutingPreferences,
} from "../src/db/schema/lifecycle";
import {
  proactivePeople,
  proactivePings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { workItems } from "../src/db/schema/work";
import { createExpoPushTransport } from "../src/delivery/push";
import { createDeliveryRouter } from "../src/delivery/router";
import { createDeliveryStore } from "../src/delivery/store";
import type {
  BindingTransport,
  DeliveryBinding,
  DeliveryScope,
  DeliverySender,
} from "../src/delivery/types";
import type { AttentionPing } from "../src/proactive/contracts";
import { createProactiveStore } from "../src/proactive/store";
import type { ProactiveSetting } from "../src/proactive/types";
import { createWorkQueue } from "../src/work/queue";
import { notificationDestination } from "../../mobile/src/links";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * A ping's delivery through the real path: real Postgres, the real proactive store writing the ping
 * from real items, the real delivery router, store, outbox and work queue, the person's real routing
 * and per-Bot preferences, and the real Expo transport. The providers' wires are the only fakes: a
 * Slack, Teams and SMS transport that records what it was asked to send, and Expo's HTTP endpoint.
 * Which conversations the person can still reach is the server's rule (`deliveryScopeFor`), modelled
 * here as a set the tests take conversations out of.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `attention-owner-${suite}`;
const inboxBot = `attention-inbox-${suite}`;
const calendarBot = `attention-calendar-${suite}`;
const researchBot = `attention-research-${suite}`;
const inboxChannel = `attention-inbox-channel-${suite}`;
const calendarChannel = `attention-calendar-channel-${suite}`;
const researchChannel = `attention-research-channel-${suite}`;
const phone = `attention-phone-${suite}`;
const tablet = `attention-tablet-${suite}`;
const BOTS = [inboxBot, calendarBot, researchBot];
const CHANNELS = [inboxChannel, calendarChannel, researchChannel];
const botOf: Record<string, string> = {
  [inboxChannel]: inboxBot,
  [calendarChannel]: calendarBot,
  [researchChannel]: researchBot,
};
const threadOf = (channelId: string) => `${channelId}-thread`;

const proactive = createProactiveStore(database);
const deliveries = createDeliveryStore(database);
const lifecycle = createBotLifecycleStore(database);

/** The conversations the person can still reach. A test takes one out to revoke it. */
const reachable = new Set<string>();
const scopeFor = async (
  ownerUserId: string,
  channelId: string,
  agentId: string,
): Promise<DeliveryScope | null> =>
  ownerUserId === owner &&
  reachable.has(channelId) &&
  botOf[channelId] === agentId
    ? { ownerUserId, channelId, agentId, threadId: threadOf(channelId) }
    : null;

type ChatSend = {
  transport: BindingTransport;
  address: string;
  text: string;
  sender?: DeliverySender;
};
const chatSends: ChatSend[] = [];
const pushSends: Record<string, unknown>[] = [];
const turns: DeliveryScope[] = [];
const chat = (transport: BindingTransport) => ({
  send: async (input: {
    id: string;
    address: string;
    text: string;
    sender?: DeliverySender;
  }) => {
    chatSends.push({
      transport,
      address: input.address,
      text: input.text,
      ...(input.sender ? { sender: input.sender } : {}),
    });
    return { id: `${transport}-${chatSends.length}`, status: "sent" as const };
  },
});
const router = createDeliveryRouter({
  store: deliveries,
  queue: createWorkQueue(database),
  owner: `attention-delivery-${suite}`,
  // The server's rule: the conversation is still theirs, on its own thread.
  authoriseScope: async (scope) =>
    (await scopeFor(scope.ownerUserId, scope.channelId, scope.agentId))
      ?.threadId === scope.threadId,
  scopeFor,
  runTurn: async (input) => {
    turns.push({
      ownerUserId: input.ownerUserId,
      channelId: input.channelId,
      agentId: input.agentId,
      threadId: input.threadId,
    });
    return { replyText: "On it." };
  },
  providers: {
    slack: chat("slack"),
    teams: chat("teams"),
    sms: chat("sms"),
    // The real Expo transport; only its HTTP endpoint answers from here.
    push: createExpoPushTransport({
      fetch: async (_url, init) => {
        pushSends.push(JSON.parse(String(init?.body)));
        return Response.json({
          data: { status: "ok", id: `ticket-${pushSends.length}` },
        });
      },
    }),
  },
});

let inbox: ProactiveSetting;
let calendar: ProactiveSetting;
/** Two Slack workspaces, one Teams tenant and a phone number, each in a conversation of its own. */
let slackOld: DeliveryBinding;
let slackNew: DeliveryBinding;
let teams: DeliveryBinding;
let sms: DeliveryBinding;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

beforeAll(async () => {
  configureBotLifecycle({ database });
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(agents).values([
    { id: inboxBot, name: "Inbox Bot", type: "built_in", configuration: {} },
    {
      id: calendarBot,
      name: "Calendar Bot",
      type: "built_in",
      configuration: {},
    },
    {
      id: researchBot,
      name: "Research Bot",
      type: "built_in",
      configuration: {},
    },
  ]);
  await database
    .insert(channels)
    .values(CHANNELS.map((id) => ({ id, name: id, description: "" })));
  inbox = await proactive.create(
    owner,
    { agentId: inboxBot, channelId: inboxChannel },
    `inbox-check-ins-${suite}`,
  );
  calendar = await proactive.create(
    owner,
    { agentId: calendarBot, channelId: calendarChannel },
    `calendar-check-ins-${suite}`,
  );
  const bind = (
    transport: BindingTransport,
    channelId: string,
    realm: string,
    address: string,
  ) =>
    deliveries.bind({
      ownerUserId: owner,
      channelId,
      agentId: botOf[channelId] as string,
      threadId: threadOf(channelId),
      transport,
      realm: `${suite}-${realm}`,
      identity: `${realm}-person`,
      address,
    });
  slackOld = await bind("slack", researchChannel, "T1", "D-research");
  slackNew = await bind("slack", inboxChannel, "T2", "D-inbox");
  teams = await bind("teams", calendarChannel, "tenant", "C-calendar");
  sms = await bind("sms", inboxChannel, "sms", "+15550100");
  for (const id of [phone, tablet])
    await deliveries.registerDevice({
      id,
      ownerUserId: owner,
      token: `ExponentPushToken[${id}]`,
      projectId: randomUUID(),
      platform: "ios",
    });
});

/** Every send forgotten, every account back to how it was connected, and nothing waiting. */
async function reset() {
  chatSends.length = 0;
  pushSends.length = 0;
  turns.length = 0;
  for (const channelId of CHANNELS) reachable.add(channelId);
  const outbox = await database
    .select({ id: deliveryOutbox.id })
    .from(deliveryOutbox)
    .where(eq(deliveryOutbox.ownerUserId, owner));
  if (outbox.length)
    await database.delete(workItems).where(
      and(
        inArray(workItems.kind, ["delivery.outbound", "delivery.push-receipt"]),
        inArray(
          workItems.key,
          outbox.map((row) => row.id),
        ),
      ),
    );
  await database
    .delete(deliveryOutbox)
    .where(eq(deliveryOutbox.ownerUserId, owner));
  await database
    .delete(deliveryInbox)
    .where(eq(deliveryInbox.ownerUserId, owner));
  await database
    .delete(proactiveSuggestions)
    .where(eq(proactiveSuggestions.ownerUserId, owner));
  await database
    .delete(proactivePings)
    .where(eq(proactivePings.ownerUserId, owner));
  await database
    .delete(proactivePeople)
    .where(eq(proactivePeople.ownerUserId, owner));
  await database
    .delete(botLifecycle)
    .where(eq(botLifecycle.ownerUserId, owner));
  await database
    .delete(updateRoutingPreferences)
    .where(eq(updateRoutingPreferences.ownerUserId, owner));
  /*
   * Connected in this order, three hours to an hour ago. The older Slack account was the one the
   * person last wrote through (ten minutes ago), so it is their most recently used one.
   */
  const connected: [DeliveryBinding, number][] = [
    [slackOld, 3],
    [teams, 2.5],
    [sms, 2],
    [slackNew, 1],
  ];
  for (const [binding, hours] of connected)
    await database
      .update(deliveryBindings)
      .set({ createdAt: hoursAgo(hours), enabled: true })
      .where(eq(deliveryBindings.id, binding.id));
  await wroteThrough(slackOld, 10 / 60);
}
beforeEach(reset);

afterAll(async () => {
  await reset();
  resetBotLifecycleForTests();
  await database.delete(users).where(eq(users.id, owner));
  await database.delete(agents).where(inArray(agents.id, BOTS));
  await database.delete(channels).where(inArray(channels.id, CHANNELS));
  await database.$client.end({ timeout: 5 });
});

/** The person wrote to their Bot through this account, `hours` hours ago. */
async function wroteThrough(binding: DeliveryBinding, hours: number) {
  const row = await deliveries.recordInbox({
    ownerUserId: binding.ownerUserId,
    channelId: binding.channelId,
    agentId: binding.agentId,
    threadId: binding.threadId,
    bindingId: binding.id,
    source: binding.transport,
    realm: binding.realm,
    externalId: randomUUID(),
    text: "Hi",
  });
  await database
    .update(deliveryInbox)
    .set({ createdAt: hoursAgo(hours) })
    .where(eq(deliveryInbox.id, row?.id as string));
}

/** An open item a check-in raised, waiting for the person's hourly ping. */
const raise = (setting: ProactiveSetting, title: string, why: string) =>
  proactive.addSuggestion({
    ownerUserId: owner,
    agentId: setting.agentId,
    settingId: setting.id,
    runId: `run-${randomUUID()}`,
    title,
    detail: why,
    sourceApp: "Mail",
    sourceRef: "mail/list_messages",
    sourceLink: null,
  });

/** The ping the person's free slot lets through, as the ping pass writes it. */
async function ping(): Promise<AttentionPing> {
  await database
    .update(proactivePeople)
    .set({ lastPingedAt: null })
    .where(eq(proactivePeople.ownerUserId, owner));
  const written = await proactive.pings.take(owner);
  if (!written) throw new Error("Expected a ping.");
  return written;
}

/** Two Bots' items folded into one ping, Inbox Bot's first. */
async function twoBotPing() {
  await raise(inbox, "Reply to Dana about Friday", "Dana asked about Friday.");
  await raise(calendar, "Move the standup", "The room is double-booked.");
  return ping();
}

const outboxOf = () =>
  database
    .select()
    .from(deliveryOutbox)
    .where(eq(deliveryOutbox.ownerUserId, owner))
    .orderBy(deliveryOutbox.transport, deliveryOutbox.dedupeKey);

/** Send everything offered, as the delivery sweep does, one row at a time. */
async function drain() {
  for (let pass = 0; pass < 50; pass++) {
    const queued = (await outboxOf()).filter((row) => row.state === "queued");
    if (queued.length === 0) return;
    await router.sweep("delivery.outbound");
  }
  throw new Error("The outbox never drained.");
}

/** Where each row went: its transport, and the account or device. */
const placed = (rows: Awaited<ReturnType<typeof outboxOf>>) =>
  rows.map((row) => `${row.transport}:${row.bindingId ?? row.deviceId}`);

describe("a ping", () => {
  test("reaches each phone once and each chat platform once, into the account the person used there last, naming every item's Bot", async () => {
    const sent = await twoBotPing();
    await router.notifyAttention(sent);
    const rows = await outboxOf();
    expect(placed(rows).sort()).toEqual(
      [
        `push:${phone}`,
        `push:${tablet}`,
        `slack:${slackOld.id}`,
        `sms:${sms.id}`,
        `teams:${teams.id}`,
      ].sort(),
    );
    expect(rows.every((row) => row.kind === "attention")).toBe(true);
    // Each chat message is filed under its own account's conversation, so its Bot sends it.
    const slack = rows.find((row) => row.transport === "slack");
    expect(slack).toMatchObject({
      channelId: researchChannel,
      agentId: researchBot,
      threadId: threadOf(researchChannel),
      text: sent.text,
    });

    await drain();
    expect(
      (await outboxOf()).map((row) => [row.transport, row.state]).sort(),
    ).toEqual([
      ["push", "accepted"],
      ["push", "accepted"],
      ["slack", "sent"],
      ["sms", "sent"],
      ["teams", "sent"],
    ]);
    expect(chatSends.map((send) => send.transport).sort()).toEqual([
      "slack",
      "sms",
      "teams",
    ]);
    const [toSlack] = chatSends.filter((send) => send.transport === "slack");
    expect(toSlack?.address).toBe("D-research");
    expect(toSlack?.sender).toMatchObject({
      agentId: researchBot,
      name: "Research Bot",
    });
    expect(toSlack?.text.split("\n")).toEqual([
      "2 things need you",
      "• Inbox Bot: Reply to Dana about Friday. Dana asked about Friday. (from Mail)",
      "• Calendar Bot: Move the standup. The room is double-booked. (from Mail)",
      "Start or hide them in OpenBot.",
    ]);
    expect(
      chatSends.find((send) => send.transport === "teams")?.sender,
    ).toMatchObject({ agentId: calendarBot, name: "Calendar Bot" });

    // A reply there reaches that account's own Bot, in its own conversation, as any reply does.
    const answer = await router.converse({
      transport: "slack",
      realm: slackOld.realm,
      identity: slackOld.identity,
      externalId: `reply-${suite}`,
      text: "Thanks, I'll handle Dana.",
      signal: new AbortController().signal,
    });
    expect(answer).toMatchObject({ kind: "replied", replyText: "On it." });
    expect(turns).toEqual([
      {
        ownerUserId: owner,
        channelId: researchChannel,
        agentId: researchBot,
        threadId: threadOf(researchChannel),
      },
    ]);
  });

  test("the push is titled for the person, a line per item naming its Bot, and opens Needs you; other pushes are unchanged", async () => {
    await router.notifyAttention(await twoBotPing());
    await drain();
    expect(pushSends).toHaveLength(2);
    for (const push of pushSends)
      expect(push).toMatchObject({
        title: "2 things need you",
        body: "Inbox Bot: Reply to Dana about Friday\nCalendar Bot: Move the standup",
        data: { kind: "attention", url: "openbotmobile://needs-you" },
      });
    // The phone opens its Needs you list on a tap.
    expect(notificationDestination(pushSends[0]?.data)).toEqual({
      pathname: "/needs-you",
      params: {},
    });
    // Filed under the newest item's check-in conversation, which says nothing on the phone.
    expect(pushSends[0]?.data).not.toHaveProperty("channelId");
    expect(
      (await outboxOf())
        .filter((row) => row.transport === "push")
        .map((row) => row.channelId),
    ).toEqual([calendarChannel, calendarChannel]);
    // Each phone once.
    expect(new Set(pushSends.map((push) => push.to as string)).size).toBe(2);

    // A Bot's reply still pushes as it always has: titled OpenBot, opening its conversation.
    pushSends.length = 0;
    await router.notify(
      {
        ownerUserId: owner,
        channelId: inboxChannel,
        agentId: inboxBot,
        threadId: threadOf(inboxChannel),
      },
      {
        id: `reply-${suite}`,
        text: "Drafted the reply to Dana.",
        kind: "reply",
      },
      false,
    );
    await drain();
    expect(pushSends).toHaveLength(2);
    expect(pushSends[0]).toMatchObject({
      title: "OpenBot",
      body: "Drafted the reply to Dana.",
      data: {
        kind: "reply",
        channelId: inboxChannel,
        url: `openbotmobile://conversation?channelId=${inboxChannel}`,
      },
    });
  });

  test("a person with no chat account connected gets the push alone", async () => {
    await database
      .update(deliveryBindings)
      .set({ enabled: false })
      .where(eq(deliveryBindings.ownerUserId, owner));
    await router.notifyAttention(await twoBotPing());
    expect(placed(await outboxOf()).sort()).toEqual(
      [`push:${phone}`, `push:${tablet}`].sort(),
    );
  });

  test("offered twice, it sends once, even after the person used another account on the same platform", async () => {
    const sent = await twoBotPing();
    await router.notifyAttention(sent);
    await drain();
    // Now the newer Slack account is the one they used last.
    await wroteThrough(slackNew, 0);
    await router.notifyAttention(sent);
    await drain();
    expect(await outboxOf()).toHaveLength(5);
    expect(chatSends.filter((send) => send.transport === "slack")).toEqual([
      expect.objectContaining({ address: "D-research" }),
    ]);
    expect(pushSends).toHaveLength(2);

    // The next ping goes where the person is now.
    await raise(inbox, "Pay the invoice", "It is due tomorrow.");
    await router.notifyAttention(await ping());
    await drain();
    expect(
      chatSends
        .filter((send) => send.transport === "slack")
        .map((send) => send.address),
    ).toEqual(["D-research", "D-inbox"]);
  });
});

describe("where the person routes it", () => {
  const routes = new Hono().route(
    "/api/bots",
    createBotLifecycleRoutes(
      // Only the routing routes are called here, and they use only the lifecycle store.
      { lifecycle } as unknown as BotLifecycleServices,
      (async (
        context: { set: (key: string, value: unknown) => void },
        next: () => Promise<void>,
      ) => {
        context.set("actor", { id: owner, email: `${owner}@example.test` });
        await next();
      }) as never,
    ),
  );
  const route = (transports: string[] | "all") =>
    routes.request("/api/bots/routing/attention", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transports }),
    });

  test("'Something needs you' is a kind the person routes, and it picks the transports", async () => {
    const before = (await (
      await routes.request("/api/bots/routing")
    ).json()) as {
      routing: Record<string, unknown>;
    };
    expect(before.routing.attention).toBe("all");

    const saved = await route(["push", "teams"]);
    expect(saved.status).toBe(200);
    expect(
      ((await saved.json()) as { routing: Record<string, unknown> }).routing
        .attention,
    ).toEqual(["push", "teams"]);
    // Another kind's routing is its own.
    await lifecycle.setRouting(owner, "progress", []);

    await router.notifyAttention(await twoBotPing());
    expect(placed(await outboxOf()).sort()).toEqual(
      [`push:${phone}`, `push:${tablet}`, `teams:${teams.id}`].sort(),
    );
  });

  test("routed to the web alone, it leaves nothing in the outbox; the items stay listed", async () => {
    expect((await route([])).status).toBe(200);
    const sent = await twoBotPing();
    await router.notifyAttention(sent);
    expect(await outboxOf()).toEqual([]);
    expect(await proactive.suggestions(owner)).toHaveLength(2);
    expect((await route(["sms"])).status).toBe(200);
    // Teams and Slack are off and push too; only the SMS account is written to.
    await router.notifyAttention(sent);
    expect(placed(await outboxOf())).toEqual([`sms:${sms.id}`]);
  });

  test("a Bot set to only what needs input still sends; one set to nothing contributes nothing", async () => {
    await lifecycle.setNotify(owner, inboxBot, "needs_input");
    await lifecycle.setNotify(owner, calendarBot, "none");
    await raise(
      inbox,
      "Reply to Dana about Friday",
      "Dana asked about Friday.",
    );
    await raise(calendar, "Move the standup", "The room is double-booked.");
    const sent = await ping();
    expect(sent.items.map((item) => item.agentName)).toEqual(["Inbox Bot"]);
    await router.notifyAttention(sent);
    await drain();
    expect(chatSends.map((send) => send.transport).sort()).toEqual([
      "slack",
      "sms",
      "teams",
    ]);
    for (const send of chatSends) {
      expect(send.text).toStartWith("One thing needs you\n");
      expect(send.text).not.toContain("Move the standup");
    }
    expect(pushSends.map((push) => push.title)).toEqual([
      "One thing needs you",
      "One thing needs you",
    ]);
  });
});

describe("a conversation the person lost", () => {
  test("is passed over for the next account they used on that platform, and a push is filed under a conversation they still have", async () => {
    // The Slack account they used last is in a conversation they can no longer reach.
    reachable.delete(researchChannel);
    // And so is the newest item's Bot's conversation.
    reachable.delete(calendarChannel);
    await router.notifyAttention(await twoBotPing());
    const rows = await outboxOf();
    expect(placed(rows).sort()).toEqual(
      [
        `push:${phone}`,
        `push:${tablet}`,
        `slack:${slackNew.id}`,
        `sms:${sms.id}`,
      ].sort(),
    );
    expect(
      rows.filter((row) => row.transport === "push").map((r) => r.channelId),
    ).toEqual([inboxChannel, inboxChannel]);
  });

  test("lost between the offer and the send is refused, as any send is, and nothing reaches it", async () => {
    await router.notifyAttention(await twoBotPing());
    reachable.delete(researchChannel);
    reachable.delete(calendarChannel);
    await drain();
    const byTransport = Object.fromEntries(
      (await outboxOf()).map((row) => [
        row.transport,
        { state: row.state, error: row.error },
      ]),
    );
    expect(byTransport.slack).toEqual({
      state: "failed",
      error: "Conversation access has been revoked.",
    });
    expect(byTransport.teams).toEqual({
      state: "failed",
      error: "Conversation access has been revoked.",
    });
    // The pushes were filed under the calendar conversation, now gone too.
    expect(byTransport.push?.state).toBe("failed");
    expect(byTransport.sms?.state).toBe("sent");
    expect(chatSends.map((send) => send.transport)).toEqual(["sms"]);
    expect(pushSends).toEqual([]);
  });

  test("none left at all: nothing is offered", async () => {
    reachable.clear();
    await router.notifyAttention(await twoBotPing());
    expect(await outboxOf()).toEqual([]);
    expect(
      await database
        .select({ id: proactiveSuggestions.id })
        .from(proactiveSuggestions)
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            sql`${proactiveSuggestions.pingId} is not null`,
          ),
        ),
    ).toHaveLength(2);
  });
});
