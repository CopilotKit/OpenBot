import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput } from "../src/audit";
import {
  createGroupConversations,
  createGroupRoutes,
  createGroupStore,
  GROUP_TURN_KIND,
  GroupNotFoundError,
  GroupRefusedError,
  groupSourceForRun,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
  workItems,
} from "../src/db/schema";
import { createPrivateShareCheck } from "../src/proactive/private-share";
import type { TurnRunner } from "../src/routines/runner";
import { createTeamBots } from "../src/team-bots/team-bots";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const prefix = `group-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const createdChannels: string[] = [];

afterEach(async () => {
  await database.delete(workItems).where(like(workItems.key, `${prefix}%`));
  for (const id of createdChannels.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, id));
    await database.delete(channels).where(eq(channels.id, id));
  }
  if (createdAgents.length) {
    const ids = createdAgents.splice(0);
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, ids));
    await database.delete(agents).where(inArray(agents.id, ids));
  }
  for (const id of createdUsers.splice(0))
    await database.delete(users).where(eq(users.id, id));
});
afterAll(async () => {
  await database.$client.close();
});

async function person(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Group Test" });
  createdUsers.push(id);
  return { id, role: "user" };
}
async function bot(owner: AgentActor, name: string) {
  const profile = await profileStore.create(owner, {
    name,
    title: "Tester",
    roleDescription: "Answer briefly.",
    visibility: "private",
  });
  createdAgents.push(profile.id);
  return profile.id;
}

function service(options: {
  replies: Record<
    string,
    (input: Parameters<TurnRunner>[0]) => string | Promise<string>
  >;
  maxDepth?: number;
  granted?: boolean;
  auditFails?: boolean;
  privateShare?: Parameters<typeof createGroupConversations>[0]["privateShare"];
  listenForConsent?: Parameters<
    typeof createGroupConversations
  >[0]["listenForConsent"];
  activity?: Parameters<typeof createGroupConversations>[0]["activity"];
}) {
  const calls: Parameters<TurnRunner>[0][] = [];
  const audit: AuditEventInput[] = [];
  const conversations = createGroupConversations({
    store: createGroupStore(database, () => threadIdentity.mint()),
    queue: createWorkQueue(database),
    owner: `${prefix}-replica`,
    // The production wiring's roster, against the real channel and profile stores.
    roster: async (ownerUserId, channelId) => {
      const actor: AgentActor = { id: ownerUserId, role: "user" };
      const channel = await channelStore.get(actor, channelId);
      if (!channel || channel.agentIds.length < 2) return null;
      const bots = [];
      for (const agentId of channel.agentIds) {
        const profile = await profileStore.get(actor, agentId);
        if (profile) bots.push({ id: agentId, name: profile.name });
      }
      return bots;
    },
    runTurn: async (input) => {
      calls.push(input);
      const reply = options.replies[input.agentId];
      if (!reply) throw new Error(`unexpected Bot ${input.agentId}`);
      return { replyText: await reply(input) };
    },
    caps: { maxDepth: options.maxDepth ?? 1, maxPerRun: 2 },
    mayAddress: async () => options.granted ?? true,
    auditStore: {
      insert: async (event) => {
        if (options.auditFails) throw new Error("audit store unavailable");
        audit.push(event);
      },
    },
    createChannel: async (ownerUserId, agentIds) => {
      const channel = await channelStore.create(
        { id: ownerUserId, role: "user" },
        agentIds,
      );
      createdChannels.push(channel.id);
      return channel;
    },
    progressEveryMs: 0,
    ...(options.privateShare ? { privateShare: options.privateShare } : {}),
    ...(options.listenForConsent
      ? { listenForConsent: options.listenForConsent }
      : {}),
    ...(options.activity ? { activity: options.activity } : {}),
  });
  return { conversations, calls, audit };
}

async function drain(conversations: { sweep(): Promise<boolean> }) {
  for (let i = 0; i < 10 && (await conversations.sweep()); i++) {}
}

describe("group conversations in PostgreSQL", () => {
  test("two Bots answer one person, see each other, and answer each other within the depth cap", async () => {
    const owner = await person();
    const named = new Map([
      [await bot(owner, "Ada"), "Ada"],
      [await bot(owner, "Grace"), "Grace"],
    ]);
    // The group answers in its roster order, which is the channel's Bot order.
    const [ada = "", grace = ""] = [...named.keys()].sort();
    const A = named.get(ada) ?? "";
    const G = named.get(grace) ?? "";
    const channel = await channelStore.create(owner, [ada, grace]);
    createdChannels.push(channel.id);
    const { conversations, calls, audit } = service({
      replies: {
        [ada]: () => `Draft ready. @${G} can you check the numbers?`,
        [grace]: (input) =>
          input.initiator?.kind === "handoff"
            ? `Numbers checked. @${A} looks right.`
            : "I will review the draft.",
      },
    });

    const messageId = `${prefix}-m1`;
    await conversations.send(owner.id, channel.id, {
      id: messageId,
      text: "Plan the launch",
    });
    await drain(conversations);

    // Person turn: the first Bot then the second, then the second again because the first addressed
    // it (depth 1). Its mention back is at the depth cap, so it is refused and audited, not run.
    expect(calls.map((call) => call.agentId)).toEqual([ada, grace, grace]);
    expect(calls[0]?.threadId).not.toBe(calls[1]?.threadId);
    expect(calls[1]?.threadId).toBe(calls[2]?.threadId);
    expect(String(calls[1]?.userMessage?.content)).toContain(
      `"speaker":"${A}"`,
    );
    expect(calls[2]?.initiator).toEqual({ kind: "handoff", id: ada });
    expect(String(calls[2]?.userMessage?.content)).toContain(
      `${A} addressed you`,
    );

    const { messages, bots } = await conversations.list(owner.id, channel.id);
    expect(bots.map((row) => row.name).sort()).toEqual(["Ada", "Grace"]);
    expect(messages.map((row) => [row.agentId, row.status, row.text])).toEqual([
      [null, "completed", "Plan the launch"],
      [ada, "completed", `Draft ready. @${G} can you check the numbers?`],
      [grace, "completed", "I will review the draft."],
      [grace, "completed", `Numbers checked. @${A} looks right.`],
    ]);
    expect(audit.map((event) => event.eventType)).toEqual([
      "agent.handoff_offered",
      "agent.handoff_refused",
    ]);
    expect(audit[1]?.payload.reason).toBe("depth_cap");

    // A group Bot's thread authorises its own coordination callbacks, and no one else's.
    const threadId = calls[0]?.threadId ?? "";
    expect(
      await groupSourceForRun(database, {
        threadId,
        actorId: owner.id,
        botId: ada,
      }),
    ).toEqual({ channelId: channel.id, botId: ada });
    expect(
      await groupSourceForRun(database, {
        threadId,
        actorId: owner.id,
        botId: grace,
      }),
    ).toBeNull();

    // Resending the same message is one message, not a second turn.
    await conversations.send(owner.id, channel.id, {
      id: messageId,
      text: "Plan the launch",
    });
    await drain(conversations);
    expect(calls).toHaveLength(3);
  });

  test("another person cannot read, post into, or borrow the group's threads", async () => {
    const owner = await person();
    const stranger = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    const channel = await channelStore.create(owner, [ada, grace]);
    createdChannels.push(channel.id);
    const { conversations, calls } = service({
      replies: { [ada]: () => "hi", [grace]: () => "hello" },
    });
    await expect(conversations.list(stranger.id, channel.id)).rejects.toThrow(
      GroupNotFoundError,
    );
    await expect(
      conversations.send(stranger.id, channel.id, {
        id: `${prefix}-intruder`,
        text: "let me in",
      }),
    ).rejects.toThrow(GroupNotFoundError);
    await expect(
      conversations.send(owner.id, channel.id, {
        id: `${prefix}-wrong-bot`,
        text: "only you",
        agentId: "not-in-this-group",
      }),
    ).rejects.toThrow(GroupRefusedError);

    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-only-ada`,
      text: "only Ada please",
      agentId: ada,
    });
    await drain(conversations);
    expect(calls.map((call) => call.agentId)).toEqual([ada]);
    expect(
      await groupSourceForRun(database, {
        threadId: calls[0]?.threadId,
        actorId: stranger.id,
        botId: ada,
      }),
    ).toBeNull();

    // Over HTTP the refusal is the same not-found as a channel that does not exist.
    const routes = createGroupRoutes(conversations, async (context, next) => {
      context.set("actor", {
        id: context.req.header("x-test-user") ?? "",
      } as never);
      await next();
    });
    const asStranger = await routes.request(`/${channel.id}`, {
      headers: { "x-test-user": stranger.id },
    });
    expect(asStranger.status).toBe(404);
    const asOwner = await routes.request(`/${channel.id}`, {
      headers: { "x-test-user": owner.id },
    });
    expect(asOwner.status).toBe(200);
    expect(
      ((await asOwner.json()) as { messages: unknown[] }).messages,
    ).toHaveLength(2);
  });

  test("without a Bot-to-Bot grant a mention is audited and refused", async () => {
    const owner = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    const channel = await channelStore.create(owner, [ada, grace]);
    createdChannels.push(channel.id);
    const { conversations, calls, audit } = service({
      granted: false,
      replies: { [ada]: () => "@Grace over to you", [grace]: () => "ok" },
    });
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-ungranted`,
      text: "go",
      agentId: ada,
    });
    await drain(conversations);
    expect(calls.map((call) => call.agentId)).toEqual([ada]);
    expect(audit.map((event) => event.payload.reason)).toEqual(["not_granted"]);
    expect(
      (
        await database
          .select()
          .from(workItems)
          .where(eq(workItems.kind, GROUP_TURN_KIND))
      ).filter((row) => row.key.startsWith(prefix) && row.key.includes(">")),
    ).toEqual([]);
  });
  test("a fault after a reply is saved still posts its consent cards and hands it on", async () => {
    const owner = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    const channel = await channelStore.create(owner, [ada, grace]);
    createdChannels.push(channel.id);
    const { conversations, calls } = service({
      replies: { [ada]: () => "@Grace over to you", [grace]: () => "ok" },
      // Only Ada's saved reply fails to reach the activity feed; the person's message still does.
      activity: async (_turn, agentId) => {
        if (agentId === ada) throw new Error("activity feed unavailable");
      },
      listenForConsent: (_ownerUserId, agentId) => () =>
        agentId === ada
          ? [{ botId: ada, serverId: "gmail", message: "Ada needs your mail." }]
          : [],
    });
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-activity-fault`,
      text: "go",
      agentId: ada,
    });
    await drain(conversations);
    const { messages } = await conversations.list(owner.id, channel.id);
    expect(
      messages.find((row) => row.agentId === ada && !row.consent),
    ).toMatchObject({
      status: "completed",
      text: "@Grace over to you",
    });
    expect(messages.some((row) => row.consent?.serverId === "gmail")).toBe(
      true,
    );
    expect(calls.some((call) => call.agentId === grace)).toBe(true);
  });

  test("a fault handing a saved reply on does not write over the reply", async () => {
    const owner = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    const channel = await channelStore.create(owner, [ada, grace]);
    createdChannels.push(channel.id);
    const { conversations } = service({
      auditFails: true,
      replies: { [ada]: () => "@Grace over to you", [grace]: () => "ok" },
    });
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-relay-fault`,
      text: "go",
      agentId: ada,
    });
    await drain(conversations);
    const reply = (
      await conversations.list(owner.id, channel.id)
    ).messages.find((row) => row.agentId === ada);
    expect(reply).toMatchObject({
      status: "completed",
      text: "@Grace over to you",
    });
  });
  test("Bots answer in the order chosen, or in the order a message names them", async () => {
    const owner = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    const linus = await bot(owner, "Linus");
    const { conversations, calls } = service({
      replies: { [ada]: () => "a", [grace]: () => "g", [linus]: () => "l" },
    });
    const channel = await conversations.create(owner.id, {
      agentIds: [linus, ada, grace],
    });
    expect(
      (await conversations.list(owner.id, channel.id)).bots.map((b) => b.id),
    ).toEqual([linus, ada, grace]);
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-all`,
      text: "everyone",
    });
    await drain(conversations);
    expect(calls.map((call) => call.agentId)).toEqual([linus, ada, grace]);
    calls.length = 0;
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-named`,
      text: "@Grace first, then @Ada",
    });
    await drain(conversations);
    expect(calls.map((call) => call.agentId)).toEqual([grace, ada]);
  });

  test("partial text is visible while a Bot runs, an approval resumes into the row, and a relayed answer is attributed", async () => {
    const owner = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    let seenMidRun = "";
    let channelId = "";
    const { conversations, calls } = service({
      replies: {
        [ada]: async (input) => {
          input.onText?.("Hal");
          await new Promise((resolve) => setTimeout(resolve, 30));
          seenMidRun =
            (await conversations.list(owner.id, channelId)).messages.at(-1)
              ?.text ?? "";
          return "Hallo";
        },
        [grace]: () => {
          throw new HeadlessToolSuspension("Waiting for your approval.", {
            kind: "approval",
            approvalId: `${prefix}-approval`,
          });
        },
      },
    });
    const channel = await conversations.create(owner.id, {
      agentIds: [ada, grace],
    });
    channelId = channel.id;
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-stream`,
      text: "hello",
    });
    await drain(conversations);
    expect(seenMidRun).toBe("Hal");
    let { messages } = await conversations.list(owner.id, channel.id);
    expect(messages.map((row) => row.status)).toEqual([
      "completed",
      "completed",
      "waiting",
    ]);

    await conversations.continueWaiting(`${prefix}-approval`, async () => ({
      replyText: "Approved and done.",
    }));
    ({ messages } = await conversations.list(owner.id, channel.id));
    expect(messages.at(-1)).toMatchObject({
      agentId: grace,
      status: "completed",
      text: "Approved and done.",
    });

    const adaThread = calls[0]?.threadId ?? "";
    const relayed = {
      threadId: adaThread,
      actorId: owner.id,
      agentId: grace,
      text: "Grace's answer, relayed.",
    };
    expect(await conversations.announceHandoff(relayed)).toBe(true);
    expect(await conversations.announceHandoff(relayed)).toBe(true);
    ({ messages } = await conversations.list(owner.id, channel.id));
    const lines = messages.filter((row) => row.text === relayed.text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agentId: ada, answeredBy: grace });
    expect(
      await conversations.announceHandoff({
        ...relayed,
        threadId: "not-a-group",
      }),
    ).toBe(false);
  });

  test("a member can add another signed-in person, who then reads the shared transcript", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    const { conversations } = service({
      replies: { [ada]: () => "a", [grace]: () => "g" },
    });
    const channel = await conversations.create(owner.id, {
      agentIds: [ada, grace],
    });
    await expect(conversations.list(teammate.id, channel.id)).rejects.toThrow(
      GroupNotFoundError,
    );
    const [row] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, teammate.id));
    await conversations.addMember(owner.id, channel.id, {
      email: row?.email.toUpperCase(),
    });
    const seen = await conversations.list(teammate.id, channel.id);
    // The owner's private Bots stay private: the teammate reads, but cannot run them.
    expect(seen.bots).toEqual([]);
    await expect(
      conversations.addMember(teammate.id, channel.id, {
        email: "nobody@example.test",
      }),
    ).rejects.toThrow(GroupRefusedError);
  });
  test("with another person in the group, a reply waits for the owner's permission before anyone sees it", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    let decision: "pending" | "approved" | "denied" = "pending";
    const opened: unknown[] = [];
    const privateShare = createPrivateShareCheck({
      approvals: {
        open: async (action) => {
          opened.push(action);
          return { id: `${prefix}-share`, status: decision } as never;
        },
        list: async () => [],
        rules: async () => [],
      },
    });
    const { conversations } = service({
      replies: {
        [ada]: (input) =>
          String(input.userMessage?.content).includes("everyone")
            ? "From your notes: the launch slipped."
            : "All quiet.",
      },
      privateShare,
    });
    const channel = await conversations.create(owner.id, {
      agentIds: [ada, grace],
    });

    // Alone in the group, nothing is asked.
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-alone`,
      text: "status?",
      agentId: ada,
    });
    await drain(conversations);
    expect(opened).toHaveLength(0);

    const [row] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, teammate.id));
    await conversations.addMember(owner.id, channel.id, { email: row?.email });
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-shared`,
      text: "status for everyone?",
      agentId: ada,
    });
    await drain(conversations);
    const seen = await conversations.list(teammate.id, channel.id);
    const held = seen.messages.at(-1);
    expect(held).toMatchObject({ agentId: ada, status: "waiting", text: "" });
    expect(JSON.stringify(seen)).not.toContain("launch slipped");

    decision = "approved";
    await conversations.continueWaiting(`${prefix}-share`, async () => {
      throw new Error("a held reply is shown, not re-run");
    });
    const after = await conversations.list(teammate.id, channel.id);
    expect(after.messages.at(-1)).toMatchObject({
      status: "completed",
      text: "From your notes: the launch slipped.",
    });
  });
  test("while a reply waits on the owner's permission, other members do not see it stream in", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    const privateShare = createPrivateShareCheck({
      approvals: {
        open: async () =>
          ({ id: `${prefix}-stream-share`, status: "pending" }) as never,
        list: async () => [],
        rules: async () => [],
      },
    });
    let channelId = "";
    let teammateMidRun = "";
    let ownerMidRun = "";
    const { conversations } = service({
      replies: {
        [ada]: async (input) => {
          input.onText?.("From your notes: the launch slipped.");
          await new Promise((resolve) => setTimeout(resolve, 30));
          teammateMidRun = JSON.stringify(
            await conversations.list(teammate.id, channelId),
          );
          ownerMidRun = JSON.stringify(
            await conversations.list(owner.id, channelId),
          );
          return "From your notes: the launch slipped.";
        },
      },
      privateShare,
    });
    const channel = await conversations.create(owner.id, {
      agentIds: [ada, grace],
    });
    channelId = channel.id;
    const [row] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, teammate.id));
    await conversations.addMember(owner.id, channel.id, { email: row?.email });
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-stream-private`,
      text: "status?",
      agentId: ada,
    });
    await drain(conversations);
    expect(teammateMidRun).not.toContain("launch slipped");
    // The owner, whose Bot it is, still watches the reply arrive.
    expect(ownerMidRun).toContain("launch slipped");
  });

  test("a reply still waiting on its owner's permission is not handed to another person's Bot", async () => {
    const owner = await person();
    const teammate = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    // Bots the teammate may use too, so the teammate can address them in the group.
    await database
      .update(agentProfiles)
      .set({ visibility: "public" })
      .where(inArray(agentProfiles.agentId, [ada, grace]));
    const privateShare = createPrivateShareCheck({
      approvals: {
        open: async () =>
          ({ id: `${prefix}-handed-share`, status: "pending" }) as never,
        list: async () => [],
        rules: async () => [],
      },
    });
    let channelId = "";
    let graceSaw = "";
    const { conversations } = service({
      replies: {
        [ada]: async (input) => {
          input.onText?.("From your notes: the launch slipped.");
          await new Promise((resolve) => setTimeout(resolve, 30));
          // Meanwhile the teammate asks Grace, and another replica runs that turn.
          await conversations.send(teammate.id, channelId, {
            id: `${prefix}-handed-teammate`,
            text: "what is the status?",
            agentId: grace,
          });
          await conversations.sweep();
          return "From your notes: the launch slipped.";
        },
        [grace]: (input) => {
          graceSaw = JSON.stringify(input.userMessage?.content ?? "");
          return "I do not know yet.";
        },
      },
      privateShare,
    });
    const channel = await conversations.create(owner.id, {
      agentIds: [ada, grace],
    });
    channelId = channel.id;
    const [row] = await database
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, teammate.id));
    await conversations.addMember(owner.id, channel.id, { email: row?.email });
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-handed-private`,
      text: "status?",
      agentId: ada,
    });
    await drain(conversations);
    expect(graceSaw).toContain("what is the status?");
    expect(graceSaw).not.toContain("launch slipped");
  });

  test("a peer turn resumed after an approval keeps its depth in the Bot-to-Bot chain", async () => {
    const owner = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    const { conversations, audit } = service({
      replies: {
        [ada]: () => "Over to you, @Grace.",
        [grace]: () => {
          throw new HeadlessToolSuspension("Waiting for your approval.", {
            kind: "approval",
            approvalId: `${prefix}-peer-approval`,
          });
        },
      },
      maxDepth: 1,
    });
    const channel = await conversations.create(owner.id, {
      agentIds: [ada, grace],
    });
    await conversations.send(owner.id, channel.id, {
      id: `${prefix}-chain`,
      text: "start",
      agentId: ada,
    });
    await drain(conversations);
    // Grace's turn is one hop deep, and paused.
    expect(
      audit.filter((event) => event.eventType === "agent.handoff_offered"),
    ).toHaveLength(1);

    await conversations.continueWaiting(
      `${prefix}-peer-approval`,
      async () => ({
        replyText: "Done. Back to you, @Ada.",
      }),
    );
    // Answering Ada would be a second hop, past the cap of one: refused, not offered.
    const toAda = audit.filter(
      (event) =>
        (event.payload as { to?: string; target?: string }).to === ada ||
        (event.payload as { target?: string }).target === ada,
    );
    expect(toAda.map((event) => event.eventType)).toEqual([
      "agent.handoff_refused",
    ]);
    expect(toAda[0]?.payload).toMatchObject({ reason: "depth_cap", depth: 1 });
  });

  test("a Team Bot's consent card in a group turn is a line in the shared transcript", async () => {
    const owner = await person();
    const teammate = await person();
    const teamBot = await bot(owner, "Mailer");
    const own = await bot(teammate, "Helper");
    const teamBots = createTeamBots({
      database,
      connectedServers: async (userId) =>
        new Set(userId === teammate.id ? ["gmail"] : []),
    });
    await database
      .update(agentProfiles)
      .set({ roleDescription: "Sends mail." })
      .where(eq(agentProfiles.agentId, teamBot));
    await teamBots.publish(owner, teamBot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    const { conversations } = service({
      replies: {
        // Standing in for the granted tool the Bot would call during its turn.
        [teamBot]: async (input) => {
          const said = await teamBots
            .credentialActorFor(
              input.ownerUserId,
              teamBot,
            )("gmail/send")
            .then(
              () => "sent",
              () => "I need your permission to use your mail.",
            );
          return said;
        },
        [own]: () => "ok",
      },
      listenForConsent: (ownerUserId, agentId) =>
        teamBots.listenForConsent(ownerUserId, agentId),
    });
    const channel = await conversations.create(teammate.id, {
      agentIds: [teamBot, own],
    });
    await conversations.send(teammate.id, channel.id, {
      id: `${prefix}-consent`,
      text: "mail the team",
      agentId: teamBot,
    });
    await drain(conversations);
    const { messages, people } = await conversations.list(
      teammate.id,
      channel.id,
    );
    expect(messages.at(-1)).toMatchObject({
      agentId: teamBot,
      consent: { botId: teamBot, serverId: "gmail" },
    });
    expect(people.map((row) => row.userId)).toEqual([teammate.id]);
  });

  test("the person who made a group can take someone out; others can only leave", async () => {
    const owner = await person();
    const second = await person();
    const third = await person();
    const ada = await bot(owner, "Ada");
    const grace = await bot(owner, "Grace");
    const { conversations } = service({
      replies: { [ada]: () => "a", [grace]: () => "g" },
    });
    const channel = await conversations.create(owner.id, {
      agentIds: [ada, grace],
    });
    for (const member of [second, third]) {
      const [row] = await database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, member.id));
      await conversations.addMember(owner.id, channel.id, {
        email: row?.email,
      });
    }
    expect(
      (await conversations.list(owner.id, channel.id)).people.map((p) => [
        p.userId,
        p.creator,
      ]),
    ).toEqual([
      [owner.id, true],
      [second.id, false],
      [third.id, false],
    ]);
    await expect(
      conversations.removeMember(second.id, channel.id, third.id),
    ).rejects.toThrow(GroupRefusedError);
    await expect(
      conversations.removeMember(owner.id, channel.id, owner.id),
    ).rejects.toThrow(GroupRefusedError);
    await conversations.removeMember(second.id, channel.id, second.id);
    await conversations.removeMember(owner.id, channel.id, third.id);
    for (const gone of [second, third])
      await expect(conversations.list(gone.id, channel.id)).rejects.toThrow(
        GroupNotFoundError,
      );
  });
});
