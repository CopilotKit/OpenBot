import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { HANDED_OVER } from "@openbot/shared/handoff-markers";
import { eq, inArray, sql } from "drizzle-orm";
import { wireCoordination } from "../src/agents/coordination-wiring";
import { createHandoffDesk, HANDOFF_KIND } from "../src/agents/handoff";
import { HANDOFF_TOOL } from "../src/agents/handoff-tool";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAuditStore } from "../src/audit";
import type { DeploymentConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  pluginGrants,
  workItems,
} from "../src/db/schema";
import { setEdition } from "../src/edition";
import { createPluginStore } from "../src/plugins/store";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * In the personal edition one person's Bot hands work to another of that person's Bots.
 *
 * Found on OpenBot Desktop: asked to "ask the Claude Agent SDK bot for three short bullet points",
 * Personal Assistant answered that it had no tool to message another Bot. Nobody had granted it one,
 * and in the personal edition there is nobody to grant it: there is one person and every Bot is
 * theirs, as every app they connect already is.
 *
 * Wired the way `index.ts` wires it: the real plugin store's grant read behind the desk and behind
 * `wireCoordination`, the real profile store, the real queue. What a run is offered is read off the
 * tools `coordinationForActor` hands the run, and the call goes through the same tool.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const ASSISTANT = `personal-handoff-assistant-${suite}`;
const PICKED = `personal-handoff-picked-${suite}`;
const ACTOR = `personal-handoff-person-${suite}`;
const ALL = [ASSISTANT, PICKED];

const auditStore = createAuditStore(database);
const pluginStore = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const agentProfileStore = createAgentProfileStore(database, undefined);
// The one person on the machine, who is the admin there.
const actorFor = async (id: string) => ({ id, role: "admin" as const });
const caps = { maxDepth: 1, maxPerRun: 3 };

// As index.ts builds it: the grant read, failing closed.
const handoffDesk = createHandoffDesk({
  queue: createWorkQueue(database),
  profiles: agentProfileStore,
  mayAddress: async (fromBotId, toBotId) =>
    (
      await pluginStore.botsReachableFrom(fromBotId).catch(() => [] as string[])
    ).includes(toBotId),
  addressable: (fromBotId) => pluginStore.botsReachableFrom(fromBotId),
  actorFor,
  auditStore,
  caps,
});

const { coordinationForActor } = wireCoordination({
  handoffDesk,
  config: { handoff: caps } as DeploymentConfig,
  // No approval gate: what is asked of the person is not what this is about. The private-share
  // check is reached only for another person's Bot, and in this edition there is no other person.
  approvalService: { gate: undefined, store: {} } as never,
  agentProfileStore,
  actorFor,
  channelSourceForRun: async () => null,
  database,
  pluginStore,
  bootAuditStore: auditStore,
  peopleStore: {
    find: async (id: string) => ({ id, revoked: false }),
  } as never,
  // The person's own conversation with the asking Bot, which a direct run owns.
  sourceForCoordinationRun: async (run) => ({
    channelId: `channel-${suite}`,
    botId: run.botId,
  }),
  channelStore: {} as never,
  notify: async () => {},
});

async function clean() {
  await database
    .delete(workItems)
    .where(sql`${workItems.payload}->>'actorId' = ${ACTOR}`);
  await database.delete(pluginGrants).where(inArray(pluginGrants.agentId, ALL));
  await database
    .delete(agentProfiles)
    .where(inArray(agentProfiles.agentId, ALL));
  await database.delete(agents).where(inArray(agents.id, ALL));
}

/** The two Bots the personal package starts with on Desktop, once a harness is picked. */
beforeEach(async () => {
  await clean();
  for (const [id, name, type] of [
    [ASSISTANT, `Personal Assistant ${suite}`, "built_in"],
    [PICKED, `Claude Agent SDK ${suite}`, "remote_ag_ui"],
  ] as const) {
    await database.insert(agents).values({ id, name, type, configuration: {} });
    await database.insert(agentProfiles).values({
      agentId: id,
      title: name,
      roleDescription: "Help",
      avatarSeed: id,
      visibility: "public",
    });
  }
});

afterEach(() => setEdition("team"));

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

async function toolsFor(botId: string) {
  return coordinationForActor(ACTOR)(botId, {
    threadId: `thread-${suite}`,
    runId: `run-${suite}`,
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
}

/** The Bot names the tool's own schema offers the model. */
function offeredNames(tool: { parameters: unknown }): string[] {
  const shape = (
    tool.parameters as {
      shape: { bot: { options?: readonly string[] } };
    }
  ).shape;
  return [...(shape.bot.options ?? [])];
}

describe("handing work between Bots in the personal edition", () => {
  test("a Bot is offered message_bot naming the person's other Bot, and the call reaches it", async () => {
    setEdition("personal");

    const tools = await toolsFor(ASSISTANT);
    const handoff = tools.find((tool) => tool.name === HANDOFF_TOOL);
    expect(handoff).toBeDefined();
    if (!handoff) return;
    expect(offeredNames(handoff)).toContain(`Claude Agent SDK ${suite}`);
    expect(offeredNames(handoff)).not.toContain(`Personal Assistant ${suite}`);

    const answer = await handoff.execute({
      bot: `Claude Agent SDK ${suite}`,
      task: "Three short bullet points on what a company needs before deploying on Kubernetes.",
    });
    expect(answer.startsWith(HANDED_OVER)).toBe(true);

    const hops = await database
      .select({ payload: workItems.payload })
      .from(workItems)
      .where(
        sql`${workItems.kind} = ${HANDOFF_KIND} and ${workItems.payload}->>'actorId' = ${ACTOR}`,
      );
    expect(hops).toHaveLength(1);
    expect(hops[0]?.payload).toMatchObject({
      fromBotId: ASSISTANT,
      toBotId: PICKED,
    });
  });

  test("the picked Bot can ask Personal Assistant in return", async () => {
    setEdition("personal");
    const tools = await toolsFor(PICKED);
    const handoff = tools.find((tool) => tool.name === HANDOFF_TOOL);
    expect(handoff).toBeDefined();
    if (handoff)
      expect(offeredNames(handoff)).toContain(`Personal Assistant ${suite}`);
  });

  test("a deleted Bot is not offered", async () => {
    setEdition("personal");
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, PICKED));
    const tools = await toolsFor(ASSISTANT);
    const handoff = tools.find((tool) => tool.name === HANDOFF_TOOL);
    if (handoff)
      expect(offeredNames(handoff)).not.toContain(`Claude Agent SDK ${suite}`);
    expect(await pluginStore.botsReachableFrom(ASSISTANT)).not.toContain(
      PICKED,
    );
  });

  test("the team edition still needs an admin's grant", async () => {
    setEdition("team");
    const before = await toolsFor(ASSISTANT);
    expect(before.some((tool) => tool.name === HANDOFF_TOOL)).toBe(false);

    await database.insert(pluginGrants).values({
      kind: "bot",
      ref: PICKED,
      agentId: ASSISTANT,
      grantedBy: "test",
    });
    const after = await toolsFor(ASSISTANT);
    const handoff = after.find((tool) => tool.name === HANDOFF_TOOL);
    expect(handoff).toBeDefined();
    if (handoff)
      expect(offeredNames(handoff)).toEqual([`Claude Agent SDK ${suite}`]);
  });
});
