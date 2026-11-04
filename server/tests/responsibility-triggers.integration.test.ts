/**
 * Real PostgreSQL and a real Intelligence: trigger registration, secret rotation in the vault, owner
 * scoping, the store's trigger-targeted matching, per-trigger delivery dedup and paused-never-runs,
 * end to end through the public ingress route. Triggers, events and runs live in Intelligence's
 * agent schedules; the secrets and the work queue live here.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { and, inArray, or, sql } from "drizzle-orm";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createTriggerIngressRoutes } from "../src/responsibilities/trigger-routes";
import { createTriggerStore } from "../src/responsibilities/triggers";
import { ResponsibilityNotFoundError } from "../src/responsibilities/types";
import { removeBots, seedBot } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  purgeResponsibilitiesOwnedBy,
  responsibilityEventsFor,
  responsibilityRunsOf,
  storedResponsibilityRun,
  testScheduleClient,
  useTestSchedules,
} from "./support/schedules";
import { purgeSecrets, secretsNamed, useTestVault } from "./support/vault";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `triggers-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const strangerId = `${prefix}-stranger`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
let triggers: ReturnType<typeof createTriggerStore>;
let credentialStore: ReturnType<typeof createCredentialStore>;
let routes: ReturnType<typeof createTriggerIngressRoutes>;
const store = createResponsibilityStore(database, {
  resolveTarget: async (owner, bot, channel) =>
    owner === ownerId && bot === botId && channel === channelId
      ? { threadId: `${prefix}-thread` }
      : null,
});
const runIds: string[] = [];

beforeAll(async () => {
  await useTestSchedules();
  // The trigger secrets live in Intelligence's vault.
  credentialStore = createCredentialStore(await useTestVault());
  triggers = createTriggerStore(database, {
    store: credentialStore,
    reader: credentialStore,
  });
  routes = createTriggerIngressRoutes({
    directory: triggers.directory,
    ingest: (event) => store.ingestEvent(event),
  });
  await database.insert(users).values([
    { id: ownerId, email: `${ownerId}@example.test` },
    { id: strangerId, email: `${strangerId}@example.test` },
  ]);
  await seedBot({ id: botId, name: "Trigger test Bot", type: "built_in" });
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
  await database.delete(users).where(inArray(users.id, [ownerId, strangerId]));
  await removeBots([botId]);
  // Every trigger secret this file stored is the owner's, revoked ones included.
  const { secrets } = await (await useTestVault()).client.secrets.all({
    ownerUserId: ownerId,
    includeRevoked: true,
  });
  await purgeSecrets(secrets.map((secret) => secret.id));
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
  const runs = await responsibilityRunsOf(responsibility.id);
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
  const skipped = await storedResponsibilityRun(accepted.runIds[0] ?? "");
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
  const [revoked, ...more] = await secretsNamed({
    kind: "connector",
    provider: "linear-trigger",
    keyId: linear.trigger.id,
  });
  expect(more).toEqual([]);
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

test("a trigger paused on another replica records nothing, even while this one still holds it enabled", async () => {
  const responsibility = await goal();
  const created = await triggers.create(ownerId, responsibility.id, {
    config: { kind: "webhook" },
  });
  // Another replica pauses it: Intelligence changes, this instance has not heard yet.
  const elsewhere = testScheduleClient();
  const current = await elsewhere.get(
    "responsibility-triggers",
    created.trigger.id,
  );
  await elsewhere.update(
    "responsibility-triggers",
    created.trigger.id,
    current?.version ?? 0,
    { enabled: false },
  );
  const auth = {
    authorization: `Bearer ${created.secret}`,
    "idempotency-key": "k-stale",
  };
  const first = await post(created.trigger.id, "{}", auth);
  // Refused either from memory (the announcement arrived) or by the store's own read.
  expect([409, 503]).toContain(first.status);
  expect(
    await responsibilityEventsFor(ownerId, `${created.trigger.id}:k-stale`),
  ).toEqual([]);
  expect(await responsibilityRunsOf(responsibility.id)).toEqual([]);
  // That read put the pause into this instance's memory: the next delivery is answered from it.
  expect((await post(created.trigger.id, "{}", auth)).status).toBe(409);
});

test("a change this instance never heard of is picked up by the next full read", async () => {
  const responsibility = await goal();
  const created = await triggers.create(ownerId, responsibility.id, {
    config: { kind: "webhook", filter: { eventTypes: ["deploy"] } },
  });
  const elsewhere = testScheduleClient();
  const current = await elsewhere.get(
    "responsibility-triggers",
    created.trigger.id,
  );
  await elsewhere.update(
    "responsibility-triggers",
    created.trigger.id,
    current?.version ?? 0,
    { config: { kind: "webhook", filter: { eventTypes: ["incident"] } } },
  );
  await (await useTestSchedules()).resync();
  const resolved = await triggers.directory.resolve(created.trigger.id);
  expect(resolved?.config).toEqual({
    kind: "webhook",
    filter: { eventTypes: ["incident"] },
  });
});

test("a deleted trigger stays readable in Intelligence and its URL stops working", async () => {
  const responsibility = await goal();
  const created = await triggers.create(ownerId, responsibility.id, {
    config: { kind: "webhook" },
  });
  await triggers.remove(ownerId, created.trigger.id);
  expect(
    (
      await post(created.trigger.id, "{}", {
        authorization: `Bearer ${created.secret}`,
      })
    ).status,
  ).toBe(404);
  expect(await triggers.list(ownerId, responsibility.id)).toEqual([]);
  const kept = await testScheduleClient().get(
    "responsibility-triggers",
    created.trigger.id,
  );
  expect(kept?.deletedAt).toBeInstanceOf(Date);
  await expect(
    triggers.remove(ownerId, created.trigger.id),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
});

test("a rotation that stopped after the vault is finished by the next one", async () => {
  const responsibility = await goal();
  const created = await triggers.create(ownerId, responsibility.id, {
    config: { kind: "webhook" },
  });
  const trigger = await testScheduleClient().get(
    "responsibility-triggers",
    created.trigger.id,
  );
  // The vault swapped the key, and the process stopped before the trigger named the new one.
  await credentialStore.rotate({
    kind: "connector",
    provider: "webhook-trigger",
    keyId: created.trigger.id,
    metadata: { ownerUserId: ownerId, responsibilityId: responsibility.id },
    plaintext: "orphaned",
    previousCredentialId: trigger?.credentialRef ?? "",
  });
  expect((await post(created.trigger.id, "{}", {})).status).toBe(503);
  const rotated = await triggers.setSecret(ownerId, created.trigger.id);
  const live = await post(created.trigger.id, "{}", {
    authorization: `Bearer ${rotated.secret}`,
  });
  expect(live.status).toBe(200);
  runIds.push(...((await live.json()) as { runIds: string[] }).runIds);
});

test("Slack listeners for a workspace come from this instance's memory, with their Bot", async () => {
  const responsibility = await goal();
  const id = randomUUID();
  await (await useTestSchedules()).create("responsibility-triggers", {
    id,
    ownerUserId: ownerId,
    responsibilityId: responsibility.id,
    kind: "slack",
    config: {
      kind: "slack",
      teamId: "T0TRIGGERS",
      mode: "mention",
      phrases: [],
      reactions: [],
      channels: [],
    },
    credentialRef: null,
    enabled: true,
  });
  const listening = await triggers.directory.slackTriggers("T0TRIGGERS");
  expect(listening.filter((trigger) => trigger.id === id)).toEqual([
    expect.objectContaining({
      id,
      ownerUserId: ownerId,
      responsibilityId: responsibility.id,
      responsibilityStatus: "active",
      agentId: botId,
      secret: null,
    }),
  ]);
  expect(await triggers.directory.slackTriggers("T0ELSEWHERE")).toEqual([]);
});

test("a trigger changed on another replica reaches this one by its announcement, without a full read", async () => {
  const directory = await useTestSchedules();
  const deadline = Date.now() + 10_000;
  while (!directory.subscribed() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  expect(directory.subscribed()).toBe(true);
  const responsibility = await goal();
  const created = await triggers.create(ownerId, responsibility.id, {
    config: { kind: "webhook" },
  });
  const elsewhere = testScheduleClient();
  const current = await elsewhere.get(
    "responsibility-triggers",
    created.trigger.id,
  );
  const paused = await elsewhere.update(
    "responsibility-triggers",
    created.trigger.id,
    current?.version ?? 0,
    { enabled: false },
  );
  // Memory only: nothing here reads Intelligence, so only the announcement can bring the change.
  while (
    (directory.peek("responsibility-triggers", created.trigger.id)?.version ??
      0) < paused.version &&
    Date.now() < deadline + 10_000
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  expect(
    directory.peek("responsibility-triggers", created.trigger.id)?.enabled,
  ).toBe(false);
  const auth = {
    authorization: `Bearer ${created.secret}`,
    "idempotency-key": "k-announced",
  };
  expect((await post(created.trigger.id, "{}", auth)).status).toBe(409);
});
