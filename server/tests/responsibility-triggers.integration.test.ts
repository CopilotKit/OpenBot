/**
 * Real PostgreSQL: trigger registration, secret rotation in the vault, owner scoping, the store's
 * trigger-targeted matching, per-trigger delivery dedup and paused-never-runs, end to end through
 * the public ingress route. Needs a database with `responsibility_triggers` (parity_dev today).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, credentials, users } from "../src/db/schema/core";
import { responsibilityRuns } from "../src/db/schema/responsibilities";
import { workItems } from "../src/db/schema/work";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createTriggerIngressRoutes } from "../src/responsibilities/trigger-routes";
import { createTriggerStore } from "../src/responsibilities/triggers";
import { ResponsibilityNotFoundError } from "../src/responsibilities/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `triggers-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const strangerId = `${prefix}-stranger`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const credentialStore = createCredentialStore(database);
const triggers = createTriggerStore(database, {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
});
const store = createResponsibilityStore(database, {
  resolveTarget: async (owner, bot, channel) =>
    owner === ownerId && bot === botId && channel === channelId
      ? { threadId: `${prefix}-thread` }
      : null,
});
const routes = createTriggerIngressRoutes({
  directory: triggers.directory,
  ingest: (event) => store.ingestEvent(event),
});
const runIds: string[] = [];

beforeAll(async () => {
  await database.insert(users).values([
    { id: ownerId, email: `${ownerId}@example.test` },
    { id: strangerId, email: `${strangerId}@example.test` },
  ]);
  await database.insert(agents).values({
    id: botId,
    name: "Trigger test Bot",
    type: "built_in",
    configuration: {},
  });
});
afterAll(async () => {
  if (runIds.length)
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "responsibility.run"),
          inArray(workItems.key, runIds),
        ),
      );
  await database.delete(users).where(inArray(users.id, [ownerId, strangerId]));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

async function goal() {
  return store.create(ownerId, {
    agentId: botId,
    channelId,
    title: "Triage deploys",
    instruction: "Summarize the deploy.",
    successCriteria: "A summary is posted.",
  });
}
const post = (id: string, body: string, headers: Record<string, string>) =>
  routes.fetch(
    new Request(`https://openbot.test/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );

test("a generic webhook trigger queues exactly one run per idempotency key, and paused never runs", async () => {
  const responsibility = await goal();
  const created = await triggers.create(ownerId, responsibility.id, {
    config: { kind: "webhook", filter: { eventTypes: ["deploy"] } },
  });
  expect(created.secret).toMatch(/^whsec_/);
  const auth = {
    authorization: `Bearer ${created.secret}`,
    "idempotency-key": "k-1",
  };

  const first = await post(
    created.trigger.id,
    JSON.stringify({ type: "deploy.finished" }),
    auth,
  );
  expect(first.status).toBe(200);
  const accepted = (await first.json()) as {
    runIds: string[];
    duplicate: boolean;
  };
  expect(accepted.runIds).toHaveLength(1);
  runIds.push(...accepted.runIds);
  const again = (await (
    await post(
      created.trigger.id,
      JSON.stringify({ type: "deploy.finished" }),
      auth,
    )
  ).json()) as {
    runIds: string[];
    duplicate: boolean;
  };
  expect(again).toMatchObject({ duplicate: true, runIds: accepted.runIds });
  const runs = await database
    .select()
    .from(responsibilityRuns)
    .where(eq(responsibilityRuns.responsibilityId, responsibility.id));
  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe("queued");

  // A paused trigger acknowledges but never queues.
  await triggers.setEnabled(ownerId, created.trigger.id, false);
  const pausedTrigger = await post(
    created.trigger.id,
    JSON.stringify({ type: "deploy.finished" }),
    { authorization: `Bearer ${created.secret}`, "idempotency-key": "k-p" },
  );
  expect(pausedTrigger.status).toBe(409);
  await triggers.setEnabled(ownerId, created.trigger.id, true);
  expect(
    (await triggers.listForAgent(ownerId, botId)).some(
      (trigger) => trigger.id === created.trigger.id && trigger.enabled,
    ),
  ).toBe(true);
  // Slack triggers are refused when no Slack access is wired.
  await expect(
    triggers.create(ownerId, responsibility.id, {
      config: { kind: "slack", teamId: "T1", mode: "message" },
    }),
  ).rejects.toThrow(/not connected/);

  await store.transition(ownerId, responsibility.id, "paused");
  const paused = await post(
    created.trigger.id,
    JSON.stringify({ type: "deploy.finished" }),
    {
      authorization: `Bearer ${created.secret}`,
      "idempotency-key": "k-2",
    },
  );
  expect(paused.status).toBe(409);
  // A run queued before the pause is skipped at dispatch, never run.
  expect(await store.beginRun(accepted.runIds[0] ?? "")).toBeNull();
  const [skipped] = await database
    .select()
    .from(responsibilityRuns)
    .where(eq(responsibilityRuns.id, accepted.runIds[0] ?? ""));
  expect(skipped?.status).toBe("skipped");
});

test("rotation revokes the old key in the vault; provider secrets are pasted and never echoed", async () => {
  const responsibility = await goal();
  const created = await triggers.create(ownerId, responsibility.id, {
    config: { kind: "webhook" },
  });
  const rotated = await triggers.setSecret(ownerId, created.trigger.id);
  expect(rotated.secret).not.toBe(created.secret);
  expect(await triggers.revealSecret(ownerId, created.trigger.id)).toBe(
    rotated.secret ?? "",
  );
  expect(
    (
      await post(created.trigger.id, "{}", {
        authorization: `Bearer ${created.secret}`,
      })
    ).status,
  ).toBe(401);
  const live = await post(created.trigger.id, "{}", {
    authorization: `Bearer ${rotated.secret}`,
  });
  expect(live.status).toBe(200);
  runIds.push(...((await live.json()) as { runIds: string[] }).runIds);

  const linear = await triggers.create(ownerId, responsibility.id, {
    config: { kind: "linear" },
  });
  expect(linear.trigger.hasSecret).toBe(false);
  expect((await post(linear.trigger.id, "{}", {})).status).toBe(503);
  const pasted = await triggers.setSecret(
    ownerId,
    linear.trigger.id,
    "lin_wh_pasted",
  );
  expect(pasted).toMatchObject({ secret: null, trigger: { hasSecret: true } });
  await expect(
    triggers.revealSecret(ownerId, linear.trigger.id),
  ).rejects.toThrow();
  const body = JSON.stringify({
    action: "create",
    type: "Issue",
    webhookTimestamp: Date.now(),
  });
  const delivered = await post(linear.trigger.id, body, {
    "linear-signature": createHmac("sha256", "lin_wh_pasted")
      .update(body)
      .digest("hex"),
    "linear-delivery": randomUUID(),
  });
  expect(delivered.status).toBe(200);
  runIds.push(...((await delivered.json()) as { runIds: string[] }).runIds);

  await triggers.remove(ownerId, linear.trigger.id);
  const [revoked] = await database
    .select({ revokedAt: credentials.revokedAt })
    .from(credentials)
    .where(eq(credentials.keyId, linear.trigger.id));
  expect(revoked?.revokedAt).toBeInstanceOf(Date);
});

test("another person can neither see, add to, nor name a trigger they do not own", async () => {
  const responsibility = await goal();
  const created = await triggers.create(ownerId, responsibility.id, {
    config: { kind: "webhook" },
  });
  await expect(
    triggers.list(strangerId, responsibility.id),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
  await expect(
    triggers.create(strangerId, responsibility.id, {
      config: { kind: "webhook" },
    }),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
  await expect(
    triggers.revealSecret(strangerId, created.trigger.id),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
  // The store re-checks the trigger belongs to the owner and responsibility it claims.
  await expect(
    store.ingestEvent({
      ownerUserId: strangerId,
      responsibilityId: responsibility.id,
      triggerId: created.trigger.id,
      source: "webhook",
      externalId: "x",
      type: "received",
      payload: {},
    }),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
});
