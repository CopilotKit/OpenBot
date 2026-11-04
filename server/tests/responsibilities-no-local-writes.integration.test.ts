import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { and, inArray, or, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { createResponsibilityBindingStore } from "../src/responsibilities/bindings";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createTriggerIngressRoutes } from "../src/responsibilities/trigger-routes";
import { createTriggerStore } from "../src/responsibilities/triggers";
import { removeBots, seedBot } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { vaultCredentials } from "./support/vault";
import {
  purgeResponsibilitiesOwnedBy,
  testScheduleClient,
  useTestSchedules,
} from "./support/schedules";
import { sourceFiles, stripComments } from "./support/source-scan";

/**
 * Responsibilities, their triggers, bound repositories, events and runs live in Intelligence now.
 * The five local tables stay one release for the upgrade copy and must receive nothing: a write
 * that still landed there would be a responsibility, a trigger or a run Intelligence never heard of.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `responsibilities-no-local-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
// The secrets live in Intelligence's vault.
const vault = { store: vaultCredentials(), reader: vaultCredentials() };
const runIds: string[] = [];

beforeAll(async () => {
  await useTestSchedules();
  await database
    .insert(users)
    .values({ id: ownerId, email: `${ownerId}@example.test` });
  await seedBot({ id: botId, name: "No local writes", type: "built_in" });
});
afterAll(async () => {
  await database
    .delete(workItems)
    .where(
      and(
        inArray(workItems.kind, [
          "responsibility.run",
          "responsibility.ingest",
        ]),
        or(
          inArray(sql<string>`${workItems.payload}->>'runId'`, ["", ...runIds]),
          sql`${workItems.payload}->'event'->>'ownerUserId' = ${ownerId}`,
        ),
      ),
    );
  await purgeResponsibilitiesOwnedBy(ownerId);
  await removeBots([botId]);
  await database.delete(users).where(inArray(users.id, [ownerId]));
  await database.$client.close();
});

async function legacyCounts() {
  const [row] = await database.execute<{
    responsibilities: number;
    events: number;
    runs: number;
    triggers: number;
    bindings: number;
  }>(sql`
    select
      (select count(*) from responsibilities)::int as responsibilities,
      (select count(*) from responsibility_events)::int as events,
      (select count(*) from responsibility_runs)::int as runs,
      (select count(*) from responsibility_triggers)::int as triggers,
      (select count(*) from responsibility_source_bindings)::int as bindings`);
  return row;
}

describe("the legacy responsibility tables", () => {
  test("no server source names them except the upgrade copy and the schema", () => {
    const root = join(import.meta.dir, "..", "src");
    const allowed = new Set([
      "responsibilities/upgrade.ts",
      "db/schema/responsibilities.ts",
      "db/schema/index.ts",
    ]);
    const offenders = sourceFiles(root, [".ts"]).flatMap((file) => {
      const path = relative(root, file);
      if (allowed.has(path)) return [];
      const code = stripComments(readFileSync(file, "utf8"));
      // A table is reached by importing it from the schema; a local variable of the same name is not one.
      return /import \{[^}]*\b(responsibilities|responsibilityEvents|responsibilityRuns|responsibilityTriggers|responsibilitySourceBindings)\b[^}]*\} from "[./]+db\/schema(\/responsibilities)?"/.test(
        code,
      )
        ? [path]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  test("a responsibility's whole life, its triggers and a bound repository write nothing to them", async () => {
    const store = createResponsibilityStore(database, {
      resolveTarget: async (owner, bot, channel) =>
        owner === ownerId && bot === botId && channel === channelId
          ? { threadId: `${prefix}-thread` }
          : null,
    });
    const triggers = createTriggerStore(database, vault);
    const bindings = createResponsibilityBindingStore(database, vault);
    const routes = createTriggerIngressRoutes({
      directory: triggers.directory,
      ingest: (event) => store.ingestEvent(event),
    });
    const before = await legacyCounts();

    const goal = await store.create(ownerId, {
      agentId: botId,
      channelId,
      title: "Triage deploys",
      instruction: "Summarize the deploy.",
      successCriteria: "A summary is posted.",
      subscriptions: [{ source: "github", eventType: "push" }],
    });
    await store.update(ownerId, goal.id, { title: "Triage every deploy" });
    const created = await triggers.create(ownerId, goal.id, {
      config: { kind: "webhook" },
    });
    await triggers.update(ownerId, created.trigger.id, {
      config: { kind: "webhook", filter: { eventTypes: ["deploy"] } },
    });
    await triggers.setEnabled(ownerId, created.trigger.id, false);
    await triggers.setEnabled(ownerId, created.trigger.id, true);
    const rotated = await triggers.setSecret(ownerId, created.trigger.id);
    const delivered = await routes.fetch(
      new Request(`https://openbot.test/${created.trigger.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${rotated.secret}`,
        },
        body: JSON.stringify({ type: "deploy.finished" }),
      }),
    );
    expect(delivered.status).toBe(200);
    const { runIds: queued } = (await delivered.json()) as {
      runIds: string[];
    };
    runIds.push(...queued);
    const runId = queued[0];
    if (!runId) throw new Error("Expected a queued run.");
    expect(await store.beginRun(runId)).not.toBeNull();
    await store.recordProgress(ownerId, goal.id, {
      summary: "Read the deploy log.",
      sourceRunId: runId,
    });
    await store.settleRun(runId, { status: "succeeded", replyText: "Done." });
    await store.listRuns(ownerId, goal.id);
    await triggers.listForAgent(ownerId, botId);
    await triggers.remove(ownerId, created.trigger.id);
    const binding = await bindings.create(ownerId, {
      repository: "acme/deploys",
      secret: "github-webhook-secret",
    });
    expect((await bindings.githubBindingFor(binding.id))?.repository).toBe(
      "acme/deploys",
    );
    await bindings.list(ownerId);
    await bindings.remove(ownerId, binding.id);
    await store.transition(ownerId, goal.id, "completed");

    expect(await legacyCounts()).toEqual(before);
    const held = await testScheduleClient().get("responsibilities", goal.id);
    expect(held).toMatchObject({
      title: "Triage every deploy",
      status: "completed",
      progress: "Read the deploy log.",
      lastResult: "Done.",
    });
  });
});
