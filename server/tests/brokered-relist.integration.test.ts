import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { and, eq, inArray } from "drizzle-orm";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { withApprovalContext } from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  approvalRequests,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { setEdition } from "../src/edition";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { LISTING_REVISION } from "../src/plugins/plugin-store/model";
import { startBrokeredRelist } from "../src/plugins/relist";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * An install upgraded from a release that recorded an Arcade action Arcade says nothing about as
 * destructive, which now always asks. Its stored rows can't tell that silence from an action Arcade
 * did flag, so at the first start the app is listed again, once, and records what a fresh install
 * would. Real plugin store, real tables, the real refresh; only Arcade's answer is a seam.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const TOOLKIT = `Sheets${suite}`;
const APP = `arcade-${TOOLKIT}`;
const BOT = `relist-bot-${suite}`;
const OWNER = `relist-owner-${suite}`;

const approvals = createApprovalStore(database);
const service = createApprovalService(approvals);
const plugins = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  approvalGate: (candidate) => service.gate(candidate),
  broker: createArcadeClient("never-dialled").broker,
  deploymentId: `relist-${suite}`,
});

/** What Arcade answers today: one action it says nothing about, one it flags, one named delete. */
const arcadeLists = (answered: { listed: number }) =>
  useArcadeClient({
    listTools: async () => {
      answered.listed += 1;
      return {
        items: [
          { qualified_name: `${TOOLKIT}.GetRow`, metadata: null },
          {
            qualified_name: `${TOOLKIT}.ClearSheet`,
            metadata: { behavior: { destructive: true, read_only: false } },
          },
          { qualified_name: `${TOOLKIT}.DeleteRow`, metadata: null },
        ].map((item) => ({
          ...item,
          description: "",
          input: { parameters: [] },
        })),
      };
    },
    execute: async () => {
      throw new Error("Relisting runs nothing.");
    },
  });

const NAMES = ["GetRow", "ClearSheet", "DeleteRow"];

async function rows() {
  return (
    await database
      .select({
        name: mcpTools.name,
        destructive: mcpTools.destructive,
        unclassified: mcpTools.unclassified,
      })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, APP))
  ).sort((left, right) => left.name.localeCompare(right.name));
}

async function revision() {
  const [row] = await database
    .select({ revision: mcpServers.listingRevision })
    .from(mcpServers)
    .where(eq(mcpServers.id, APP));
  return row?.revision;
}

/** Whether calling the action stopped to ask the person first. */
async function asks(name: string): Promise<boolean> {
  const toolCallId = randomUUID();
  return withApprovalContext(
    {
      runId: randomUUID(),
      threadId: `relist-${suite}-${toolCallId}`,
      toolCallId,
      toolName: `mcp__${APP}__${name}`,
      args: {},
      messages: [{ id: "u1", role: "user", content: "Tidy the sheet." }],
      state: {},
      context: [],
      forwardedProps: {},
    },
    () =>
      plugins.callTool({
        ref: `${APP}/${name}`,
        args: {},
        botId: BOT,
        actorId: OWNER,
      }),
  ).then(
    () => false,
    (error: unknown) => error instanceof HeadlessToolSuspension,
  );
}

beforeAll(async () => {
  setEdition("team");
  await database
    .insert(users)
    .values({ id: OWNER, email: `${OWNER}@example.test` });
  await database
    .insert(agents)
    .values({ id: BOT, name: "Sheets", type: "built_in", configuration: {} });
  // As the earlier release left the app: listed before `unclassified` or a listing revision
  // existed, so every action Arcade said nothing about is a destructive write.
  await database.insert(mcpServers).values({
    id: APP,
    title: TOOLKIT,
    vendor: "Arcade",
    url: `arcade://${TOOLKIT}`,
    provenance: "arcade",
  });
  await database.insert(mcpTools).values(
    NAMES.map((name) => ({
      serverId: APP,
      name,
      vendorName: `${TOOLKIT}.${name}`,
      inputSchema: {},
      effect: "write",
      destructive: true,
    })),
  );
  await database.insert(pluginGrants).values(
    NAMES.map((name) => ({
      kind: "mcp",
      ref: `${APP}/${name}`,
      agentId: BOT,
    })),
  );
});

afterEach(() => useArcadeClient(null));

afterAll(async () => {
  const asked = await database
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(eq(approvalRequests.ownerUserId, OWNER));
  if (asked.length)
    await database.delete(workItems).where(
      and(
        eq(workItems.kind, "approval.resume"),
        inArray(
          workItems.key,
          asked.map((row) => row.id),
        ),
      ),
    );
  await database
    .delete(approvalRequests)
    .where(eq(approvalRequests.ownerUserId, OWNER));
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(eq(users.id, OWNER));
  await database.$client.close();
});

test("an app listed by an earlier release asks about every action until it is listed again", async () => {
  expect(await revision()).toBe(0);
  expect(await asks("GetRow")).toBeTrue();
});

test("a broker that can't be reached leaves the app as it was, to be listed again later", async () => {
  useArcadeClient({
    listTools: async () => {
      throw new Error("Arcade is down.");
    },
    execute: async () => {
      throw new Error("Relisting runs nothing.");
    },
  });
  expect(await plugins.relistOutdatedBrokeredApps()).toContain(APP);
  expect(await revision()).toBe(0);
  expect((await rows()).every((row) => row.destructive)).toBeTrue();
});

test("at the next start it is listed again once, and records what a fresh install would", async () => {
  const answered = { listed: 0 };
  arcadeLists(answered);
  expect(await plugins.relistOutdatedBrokeredApps()).toEqual([]);
  expect(answered.listed).toBe(1);
  expect(await revision()).toBe(LISTING_REVISION);
  expect(await rows()).toEqual([
    { name: "ClearSheet", destructive: true, unclassified: false },
    { name: "DeleteRow", destructive: false, unclassified: true },
    { name: "GetRow", destructive: false, unclassified: true },
  ]);

  // Silence is an ordinary change now. A flagged action and a delete name still always ask.
  expect(await asks("GetRow")).toBeFalse();
  const askedAbout = await database
    .select({ action: approvalRequests.action })
    .from(approvalRequests)
    .where(eq(approvalRequests.ownerUserId, OWNER));
  // Only the one call before the app was listed again.
  expect(
    askedAbout.filter(
      (row) => (row.action as { toolRef?: string }).toolRef === `${APP}/GetRow`,
    ),
  ).toHaveLength(1);
  expect(await asks("ClearSheet")).toBeTrue();
  expect(await asks("DeleteRow")).toBeTrue();

  // Once: the next start asks Arcade nothing.
  expect(await plugins.relistOutdatedBrokeredApps()).toEqual([]);
  expect(answered.listed).toBe(1);
});

test("the start keeps trying while an app is behind, and stops once none is", async () => {
  const calls: number[] = [];
  const answers = [["arcade-Down"], ["arcade-Down"], []];
  const stop = startBrokeredRelist(
    {
      relistOutdatedBrokeredApps: async () => {
        calls.push(Date.now());
        return answers.shift() ?? [];
      },
    },
    [1],
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  stop();
  expect(calls).toHaveLength(3);
});
