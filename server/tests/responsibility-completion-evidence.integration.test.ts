import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { responsibilityTools } from "../src/responsibilities/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A Bot closes a responsibility only with evidence that its success criteria were met, and the
 * trail keeps that evidence, against a real PostgreSQL.
 *
 * The success criteria were free text no code ever read, and completion was a boolean the model
 * set: `complete_responsibility` closed the goal with no reason at all, and nothing on the trail said
 * why a goal ended. A person closing a goal from its page is not asked for evidence; a Bot is.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `evidence-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const store = createResponsibilityStore(database, {
  async resolveTarget(owner, bot, channel) {
    return owner === ownerId && bot === botId && channel === channelId
      ? { threadId: `${prefix}-thread` }
      : null;
  },
});

let written: AuditEventInput[] = [];
const auditStore: AuditStore = {
  insert: async (event) => void written.push(event),
};

function tools() {
  const list = responsibilityTools({
    store,
    engine: { ingest: async () => ({}) as never },
    ownerUserId: ownerId,
    agentId: botId,
    channelId,
    auditStore,
  });
  const byName = (name: string) => {
    const found = list.find((tool) => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return (args: Record<string, unknown>) =>
      found.execute(args) as Promise<string>;
  };
  return {
    report: byName("report_responsibility_progress"),
    complete: byName("complete_responsibility"),
    pause: byName("pause_responsibility"),
  };
}

async function goal() {
  return store.create(ownerId, {
    agentId: botId,
    channelId,
    title: "Quarterly graph",
    instruction: "Produce a graphical report",
    successCriteria: "The report has the quarterly graph",
    subscriptions: [],
  });
}

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: ownerId, email: `${ownerId}@example.test` });
  await database.insert(agents).values({
    id: botId,
    name: "Evidence test Bot",
    type: "built_in",
    configuration: {},
  });
});

beforeEach(() => {
  written = [];
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [ownerId]));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

test("marking a goal complete without evidence is refused, and the goal stays open", async () => {
  const value = await goal();

  const said = await tools().report({
    id: value.id,
    summary: "Drew the graph.",
    complete: true,
  });

  expect(said.startsWith("Refused.")).toBe(true);
  expect((await store.get(ownerId, value.id)).status).toBe("active");
  expect(written).toEqual([]);
});

test("with evidence, the goal closes, keeps the evidence, and the trail says why", async () => {
  const value = await goal();

  await tools().report({
    id: value.id,
    summary: "Drew the graph.",
    complete: true,
    evidence:
      "report.pdf page 2 shows the Q3 graph: https://example.test/report.pdf",
  });

  const closed = await store.get(ownerId, value.id);
  expect(closed.status).toBe("completed");
  expect(closed.progress).toContain("Drew the graph.");
  expect(closed.progress).toContain("report.pdf page 2 shows the Q3 graph");
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({
    eventType: "responsibility.completed",
    targetType: "responsibility",
    targetId: value.id,
    actorUserId: ownerId,
    initiator: { kind: "responsibility", id: value.id },
    payload: {
      bot: botId,
      criteria: "The report has the quarterly graph",
      evidence:
        "report.pdf page 2 shows the Q3 graph: https://example.test/report.pdf",
    },
  });
});

test("complete_responsibility asks for evidence too", async () => {
  const value = await goal();

  const refused = await tools().complete({ id: value.id });
  expect(refused.startsWith("Refused.")).toBe(true);
  expect((await store.get(ownerId, value.id)).status).toBe("active");

  await tools().complete({
    id: value.id,
    evidence: "The Q3 graph is on page 2 of the report.",
  });
  const closed = await store.get(ownerId, value.id);
  expect(closed.status).toBe("completed");
  expect(closed.progress).toContain("The Q3 graph is on page 2 of the report.");
  expect(written.map((event) => event.eventType)).toEqual([
    "responsibility.completed",
  ]);
});

test("progress that does not close the goal needs no evidence and writes no completion", async () => {
  const value = await goal();

  await tools().report({ id: value.id, summary: "Collected the Q3 numbers." });

  const open = await store.get(ownerId, value.id);
  expect(open.status).toBe("active");
  expect(open.progress).toBe("Collected the Q3 numbers.");
  expect(written).toEqual([]);
});

test("pausing a goal still needs no evidence", async () => {
  const value = await goal();

  await tools().pause({ id: value.id });

  expect((await store.get(ownerId, value.id)).status).toBe("paused");
});

test("a person closing a goal from its page is not asked for evidence", async () => {
  const value = await goal();

  const closed = await store.transition(ownerId, value.id, "completed");

  expect(closed.status).toBe("completed");
});

test("the longest summary with the longest evidence still closes, and the evidence is kept whole", async () => {
  const value = await goal();
  const evidence = `${"e".repeat(1999)}!`;

  const said = await tools().report({
    id: value.id,
    summary: "s".repeat(6000),
    complete: true,
    evidence,
  });

  expect(said.startsWith("Refused.")).toBe(false);
  const closed = await store.get(ownerId, value.id);
  expect(closed.status).toBe("completed");
  expect(closed.progress?.length).toBeLessThanOrEqual(6000);
  expect(closed.progress?.endsWith(`Evidence: ${evidence}`)).toBe(true);
});

test("a goal that closed is reported closed even when the trail could not be written", async () => {
  const value = await goal();
  const failing: AuditStore = {
    insert: async () => {
      throw new Error("audit database is unavailable");
    },
  };
  const list = responsibilityTools({
    store,
    engine: { ingest: async () => ({}) as never },
    ownerUserId: ownerId,
    agentId: botId,
    channelId,
    auditStore: failing,
  });
  const complete = list.find((tool) => tool.name === "complete_responsibility");

  const said = (await complete?.execute({
    id: value.id,
    evidence: "The Q3 graph is on page 2.",
  })) as string;

  expect(said.startsWith("Refused.")).toBe(false);
  expect((await store.get(ownerId, value.id)).status).toBe("completed");
});

test("a Bot cannot close a goal its person paused", async () => {
  const value = await goal();
  await store.transition(ownerId, value.id, "paused");

  const said = await tools().complete({
    id: value.id,
    evidence: "The Q3 graph is on page 2.",
  });

  expect(said.startsWith("Refused.")).toBe(true);
  expect((await store.get(ownerId, value.id)).status).toBe("paused");
  expect(written).toEqual([]);
});
