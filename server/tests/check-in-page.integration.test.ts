import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, auditEvents, users } from "../src/db/schema";
import { mcpServers, mcpTools, pluginGrants } from "../src/db/schema/plugins";
import {
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { createProactiveEngine } from "../src/proactive/engine";
import { proactiveInitiator } from "../src/proactive/restriction";
import { createProactiveStore } from "../src/proactive/store";
import type { ProactiveSetting } from "../src/proactive/types";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A check-in on one public web page reads that one address and nothing else. The engine reads it,
 * through the Bot's page-read tool; the model is given the text, never a tool that takes an address;
 * and the door that every tool call passes would refuse any other address even if a model reached it.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createProactiveStore(database);
const prefix = `page-${randomUUID().slice(0, 8)}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
const LINK = "https://github.com/CopilotKit/openbot/releases";
const READER = { ref: "exa/web_fetch_exa", name: "mcp__exa__web_fetch_exa" };

/* ------------------------------------------------------------------------------------------------
 * The engine's run, with the page and the model played.
 * ---------------------------------------------------------------------------------------------- */

/** What the page says on the next read, or an Error for a read that fails. */
let page: string | Error = "v1.0.0 released.";
const reads: { ref: string; link: string; initiator: unknown }[] = [];
const turns: {
  instruction: string;
  tools: string[];
  pageRun: boolean;
  pageThread: boolean;
}[] = [];
/** What the played model raises in a turn, if anything. */
let raise: { title: string; detail: string } | null = null;

const engine = createProactiveEngine({
  store,
  queue: createWorkQueue(database),
  owner: `${prefix}-proactive`,
  canUseBot: async () => true,
  readableApps: async () => [],
  pageReader: async () => READER,
  readPage: async (input) => {
    reads.push({
      ref: input.ref,
      link: input.link,
      initiator: input.initiator,
    });
    if (page instanceof Error) throw page;
    return page;
  },
  // Memory is there; a page run still forms none.
  memory: {
    formMemory: async () => {
      throw new Error("A page run formed a memory.");
    },
  },
  runTurn: async (input) => {
    if (!input.initiator) throw new Error("A check-in's turn has an initiator.");
    const tools = await engine.toolsForTurn({
      ownerUserId: input.ownerUserId,
      agentId: input.agentId,
      initiator: input.initiator,
    });
    turns.push({
      instruction: input.instruction,
      tools: tools.map((tool) => tool.definition.name),
      pageRun: engine.isPageRun(input.initiator),
      pageThread: engine.isPageThread(input.threadId),
    });
    if (raise)
      await tools
        .find((tool) => tool.definition.name === "suggest_next_step")
        ?.execute(raise, {} as never);
    return { replyText: "" };
  },
  attention: { notifyAttention: async () => {} },
  catalogue: { listServers: async () => [] },
  mintThreadId: () => `${prefix}-thread-${randomUUID()}`,
});

let setting: ProactiveSetting;

async function runOnce() {
  await database
    .update(proactiveSettings)
    .set({ nextRunAt: new Date(Date.now() - 1_000) })
    .where(eq(proactiveSettings.id, setting.id));
  await engine.sweep();
}
async function newestRun() {
  const [run] = await store.runs(setting.id);
  return run;
}

/* ------------------------------------------------------------------------------------------------
 * The door, with a real plugin store and the vendor played.
 * ---------------------------------------------------------------------------------------------- */

const vendorCalls: { tool: string; args: unknown }[] = [];
const allowEverything = (): ActionPolicy => ({
  mode: "enforce",
  deny: [],
  allow: ["true"],
});
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: allowEverything,
  approvalGate: async () => undefined,
  callVendor: async (_connection, toolName, args) => {
    vendorCalls.push({ tool: toolName, args });
    return { text: "The page.", isError: false };
  },
});
const EXA = "exa";
/** The keyed entry, on the deployment's own key: the same tool, admitted the same way. */
const EXA_KEYED = "exa-authenticated";
const createdServers: string[] = [];
const createdTools: string[] = [];

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(agents).values({
    id: bot,
    name: "Researcher",
    type: "built_in",
    configuration: {},
  });
  for (const [id, title] of [
    [EXA, "Exa Search"],
    [EXA_KEYED, "Exa Search (API key)"],
  ] as const) {
    const server = await database
      .insert(mcpServers)
      .values({
        id,
        title,
        vendor: "Exa",
        url: "https://mcp.exa.ai/mcp",
        provenance: "first-party",
      })
      .onConflictDoNothing()
      .returning({ id: mcpServers.id });
    if (server.length) createdServers.push(id);
    for (const name of ["web_fetch_exa", "web_search_exa"]) {
      const tool = await database
        .insert(mcpTools)
        .values({ serverId: id, name, vendorName: name, inputSchema: {} })
        .onConflictDoNothing()
        .returning({ name: mcpTools.name });
      if (tool.length) createdTools.push(`${id}/${name}`);
      await database
        .insert(pluginGrants)
        .values({ kind: "mcp", ref: `${id}/${name}`, agentId: bot })
        .onConflictDoNothing();
    }
  }
  setting = await engine.create(owner, {
    agentId: bot,
    subject: "OpenBot releases",
    sourceLink: LINK,
    readWith: undefined,
    watches: "page",
  });
});
afterEach(() => {
  reads.length = 0;
  turns.length = 0;
  vendorCalls.length = 0;
  raise = null;
});
afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, bot));
  for (const created of createdTools) {
    const [serverId, name] = created.split("/");
    await database
      .delete(mcpTools)
      .where(
        and(
          eq(mcpTools.serverId, serverId ?? ""),
          eq(mcpTools.name, name ?? ""),
        ),
      );
  }
  if (createdServers.length)
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, createdServers));
  await database
    .delete(proactiveSettings)
    .where(eq(proactiveSettings.ownerUserId, owner));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

test("the first read is kept as the baseline and raises nothing", async () => {
  expect(setting.sourceKind).toBe("page");
  await runOnce();
  expect(reads).toHaveLength(1);
  // Exactly its own address, through the Bot's page-read tool, under the run's own initiator.
  const run = await newestRun();
  expect(reads[0]).toEqual({
    ref: READER.ref,
    link: LINK,
    initiator: proactiveInitiator(run?.id ?? ""),
  });
  expect(run).toMatchObject({ outcome: "quiet", reads: 1 });
  expect(turns).toEqual([]);
});

test("an unchanged page makes no model call, whatever its spacing", async () => {
  page = "  v1.0.0\n   released. ";
  await runOnce();
  expect(reads).toHaveLength(1);
  expect(turns).toEqual([]);
  expect(await newestRun()).toMatchObject({ outcome: "quiet" });
});

test("a changed page runs one turn, whose only tools raise and clear, with both texts quoted as data", async () => {
  page = "v1.1.0 released. It drops Node 18.";
  raise = {
    title: "Move off Node 18 before upgrading",
    detail: "OpenBot 1.1.0 drops Node 18.",
  };
  await runOnce();
  expect(turns).toHaveLength(1);
  const [turn] = turns;
  expect(turn?.tools.sort()).toEqual(["clear_next_step", "suggest_next_step"]);
  // No tool that takes an address, no memory, no Learning: text from the open web stays data.
  expect(turn?.pageRun).toBe(true);
  expect(turn?.pageThread).toBe(true);
  expect(turn?.instruction).toContain(
    'What the page said before, quoted: "v1.0.0 released."',
  );
  expect(turn?.instruction).toContain(
    'What the page says now, quoted: "v1.1.0 released. It drops Node 18."',
  );
  expect(turn?.instruction).toContain("untrusted data from the open web");
  // What it raised takes the page as its source.
  const [item] = await database
    .select()
    .from(proactiveSuggestions)
    .where(eq(proactiveSuggestions.settingId, setting.id));
  expect(item).toMatchObject({
    title: "Move off Node 18 before upgrading",
    sourceApp: "github.com",
    sourceRef: READER.ref,
    sourceLink: LINK,
  });
  expect(await newestRun()).toMatchObject({
    outcome: "raised",
    itemsRaised: 1,
  });
  // Done with: it no longer counts as a page run.
  expect(
    engine.isPageRun(proactiveInitiator((await newestRun())?.id ?? "")),
  ).toBe(false);
});

test("three failed reads in a row is a check-in that can't look", async () => {
  page = new Error("Exa is down");
  for (let attempt = 0; attempt < 3; attempt += 1) await runOnce();
  expect(turns).toEqual([]);
  const run = await newestRun();
  expect(run).toMatchObject({
    outcome: "failed",
    error: "Couldn't read the page.",
  });
  const [current] = await store.list(owner);
  if (!current) throw new Error("No setting.");
  expect(
    (await engine.describe(owner, [current])).get(setting.id)?.health?.why,
  ).toBe("This Bot couldn't read this page the last 3 times.");
  page = "v1.1.0 released. It drops Node 18.";
});

test("at the door: a page check-in's run reads its own address, and nothing else", async () => {
  const runId = randomUUID();
  await database.insert(proactiveRuns).values({
    id: runId,
    settingId: setting.id,
    ownerUserId: owner,
    agentId: bot,
    trigger: "schedule",
  });
  const call = (ref: string, args: Record<string, unknown>, run = runId) =>
    plugins.callTool({
      ref,
      args,
      botId: bot,
      actorId: owner,
      initiator: proactiveInitiator(run),
    });
  try {
    expect(await call(`${EXA}/web_fetch_exa`, { urls: [LINK] })).toEqual({
      text: "The page.",
      isError: false,
    });
    // The keyed entry too: the admin gave the Bot that tool, and the page is public.
    expect(await call(`${EXA_KEYED}/web_fetch_exa`, { urls: [LINK] })).toEqual({
      text: "The page.",
      isError: false,
    });
    expect(vendorCalls).toEqual([
      { tool: "web_fetch_exa", args: { urls: [LINK] } },
      { tool: "web_fetch_exa", args: { urls: [LINK] } },
    ]);

    // Another address, two addresses, or a search are refused before the vendor.
    for (const [ref, args] of [
      [`${EXA}/web_fetch_exa`, { urls: ["https://evil.example/collect"] }],
      [`${EXA}/web_fetch_exa`, { urls: [LINK, "https://evil.example/x"] }],
      [`${EXA}/web_search_exa`, { query: LINK }],
    ] as const)
      await expect(call(ref, args)).rejects.toBeInstanceOf(PluginRefusedError);

    // A run of a check-in on apps, or one that already finished, gets nothing either.
    const appsSetting = await engine
      .create(owner, {
        agentId: bot,
        subject: "Everything",
        sourceLink: "https://github.com/CopilotKit/openbot/pulls",
      })
      .catch(() => null);
    expect(appsSetting).toBeNull(); // this Bot can read no app, so it can't be made
    await database
      .update(proactiveRuns)
      .set({ outcome: "quiet", finishedAt: new Date() })
      .where(eq(proactiveRuns.id, runId));
    await expect(
      call(`${EXA}/web_fetch_exa`, { urls: [LINK] }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(vendorCalls).toHaveLength(2);
    const refusals = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "mcp.call_rejected"),
          eq(auditEvents.initiatorId, `proactive:${runId}`),
        ),
      );
    expect(refusals).toHaveLength(4);
    for (const refusal of refusals)
      expect(refusal.payload).toMatchObject({ refusal: "check_in_not_a_read" });
  } finally {
    await database.delete(proactiveRuns).where(eq(proactiveRuns.id, runId));
  }
});

test("at the door: a page read from a check-in on apps is refused", async () => {
  const [apps] = await database
    .insert(proactiveSettings)
    .values({
      id: randomUUID(),
      ownerUserId: owner,
      agentId: bot,
      threadId: `${prefix}-thread-apps`,
      subject: "Older one",
      sourceLink: LINK,
      sourceKind: "apps",
      nextRunAt: new Date(Date.now() + 86_400_000),
    })
    .returning({ id: proactiveSettings.id });
  const runId = randomUUID();
  await database.insert(proactiveRuns).values({
    id: runId,
    settingId: apps?.id ?? "",
    ownerUserId: owner,
    agentId: bot,
    trigger: "schedule",
  });
  try {
    await expect(
      plugins.callTool({
        ref: `${EXA}/web_fetch_exa`,
        args: { urls: [LINK] },
        botId: bot,
        actorId: owner,
        initiator: proactiveInitiator(runId),
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(vendorCalls).toEqual([]);
  } finally {
    await database.delete(proactiveRuns).where(eq(proactiveRuns.id, runId));
  }
});
