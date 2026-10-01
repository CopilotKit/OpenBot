import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema/core";
import {
  deliveryChallenges,
  deliveryInbox,
  deliveryOutbox,
} from "../src/db/schema/delivery";
import { workItems } from "../src/db/schema/work";
import { createDeliveryStore } from "../src/delivery/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createDeliveryStore(db);
const prefix = `delivery-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const bot = `${prefix}-bot`;
const channel = `${prefix}-channel`;
const scope = {
  ownerUserId: owner,
  agentId: bot,
  channelId: channel,
  threadId: `${prefix}-thread`,
};
const workKeys: string[] = [];
beforeAll(async () => {
  await db.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: stranger, email: `${stranger}@example.test` },
  ]);
  await db.insert(agents).values({
    id: bot,
    name: "Delivery test Bot",
    type: "built_in",
    configuration: {},
  });
  await db
    .insert(channels)
    .values({ id: channel, name: "Delivery test", description: "" });
});
afterAll(async () => {
  if (workKeys.length)
    await db
      .delete(workItems)
      .where(
        and(
          inArray(workItems.kind, ["delivery.inbound", "delivery.outbound"]),
          inArray(workItems.key, workKeys),
        ),
      );
  await db.delete(users).where(inArray(users.id, [owner, stranger]));
  await db.delete(channels).where(eq(channels.id, channel));
  await db.delete(agents).where(eq(agents.id, bot));
  await db.$client.end({ timeout: 5 });
});
test("verified provider identity cannot transfer between actors and disabled source stops matching", async () => {
  const input = {
    ...scope,
    transport: "slack" as const,
    identity: "U",
    realm: prefix,
    address: "D",
  };
  const binding = await store.bind(input);
  await expect(store.bind({ ...input, ownerUserId: stranger })).rejects.toThrow(
    "another person",
  );
  expect(
    (await store.findBinding("slack", prefix, "U", "D"))?.ownerUserId,
  ).toBe(owner);
  await expect(store.removeBinding(stranger, binding.id)).rejects.toThrow(
    "not found",
  );
  await store.removeBinding(owner, binding.id);
  expect(await store.findBinding("slack", prefix, "U", "D")).toBeNull();
});
test("one-use challenges compare expiry against database clock and refuse a different owner", async () => {
  const id = await store.challenge(scope, "sms", "+15551234567");
  expect(await store.readChallenge(id, stranger)).toBeNull();
  const consumed = await Promise.all([
    store.consumeChallenge(id, owner),
    store.consumeChallenge(id, owner),
  ]);
  expect(consumed.filter(Boolean)).toHaveLength(1);
  expect(await store.readChallenge(id, owner)).toBeNull();
  const expired = await store.challenge(scope, "slack", null);
  await db
    .update(deliveryChallenges)
    .set({ expiresAt: new Date(0) })
    .where(eq(deliveryChallenges.id, expired));
  expect(await store.consumeChallenge(expired, owner)).toBe(false);
});
test("duplicate inbound webhook inserts exactly one durable turn even under concurrency", async () => {
  const input = {
    ...scope,
    bindingId: null,
    source: "slack" as const,
    realm: prefix,
    externalId: "event-1",
    text: "Hi",
  };
  const results = await Promise.all([
    store.offerInbox(input),
    store.offerInbox(input),
  ]);
  expect(results.filter((result) => result.queued)).toHaveLength(1);
  const rows = await db
    .select()
    .from(deliveryInbox)
    .where(eq(deliveryInbox.ownerUserId, owner));
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error("Expected inbox row");
  workKeys.push(row.id);
  expect(
    await db
      .select()
      .from(workItems)
      .where(
        and(eq(workItems.kind, "delivery.inbound"), eq(workItems.key, row.id)),
      ),
  ).toHaveLength(1);
});
test("outbound dedupe and atomic send transition preserve provider id, errors and status", async () => {
  const input = {
    ...scope,
    dedupeKey: `${prefix}:reply`,
    bindingId: null,
    deviceId: null,
    transport: "slack" as const,
    text: "Reply",
    kind: "reply" as const,
    requestId: null,
  };
  const offered = await Promise.all([
    store.offerOutbox(input),
    store.offerOutbox(input),
  ]);
  const row = offered.find((value) => value !== null);
  if (!row) throw new Error("Expected outbox row");
  workKeys.push(row.id);
  expect(offered.filter(Boolean)).toHaveLength(1);
  const started = await Promise.all([
    store.startOutbox(row.id),
    store.startOutbox(row.id),
  ]);
  expect(started.filter(Boolean)).toHaveLength(1);
  await store.setOutbox(
    row.id,
    "failed",
    "Provider unavailable",
    "provider-id",
  );
  expect(await store.outbox(row.id)).toMatchObject({
    state: "failed",
    error: "Provider unavailable",
    providerId: "provider-id",
  });
  expect(await store.startOutbox(row.id)).toBeNull();
  expect(
    await db
      .select()
      .from(deliveryOutbox)
      .where(eq(deliveryOutbox.ownerUserId, owner)),
  ).toHaveLength(1);
});
test("a paired chat turn is recorded once, running, and never queued", async () => {
  const binding = await store.bind({
    ...scope,
    transport: "slack",
    realm: `${prefix}-T`,
    identity: "UPAIR",
    address: "UPAIR",
  });
  const input = {
    ...scope,
    bindingId: binding.id,
    source: "slack" as const,
    realm: `${prefix}-T`,
    externalId: "opentag-thread:m1",
    text: "Hi",
  };
  const [first, second] = await Promise.all([
    store.recordInbox(input),
    store.recordInbox(input),
  ]);
  const recorded = first ?? second;
  expect([first, second].filter(Boolean)).toHaveLength(1);
  expect(recorded?.state).toBe("running");
  expect(
    await db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, "delivery.inbound"),
          eq(workItems.key, recorded?.id ?? ""),
        ),
      ),
  ).toHaveLength(0);
  expect(await store.botIdentity(bot)).toEqual({
    agentId: bot,
    name: "Delivery test Bot",
  });
});
test("SMS STOP keeps the binding connected but marked; START clears it", async () => {
  await store.bind({
    ...scope,
    transport: "sms",
    realm: `${prefix}-AC`,
    identity: "+15557654321",
    address: "+15557654321",
  });
  expect(
    await store.setSmsOptOut(`${prefix}-AC`, "+15557654321", true),
  ).toEqual([
    expect.objectContaining({ ownerUserId: owner, channelId: channel }),
  ]);
  const optedOut = await store.findBinding(
    "sms",
    `${prefix}-AC`,
    "+15557654321",
  );
  expect(optedOut?.optedOutAt).toBeInstanceOf(Date);
  expect(optedOut?.enabled).toBe(true);
  await store.setSmsOptOut(`${prefix}-AC`, "+15557654321", false);
  expect(
    (await store.findBinding("sms", `${prefix}-AC`, "+15557654321"))
      ?.optedOutAt,
  ).toBeNull();
});
test("a push token registered by one person cannot be moved to another person's account", async () => {
  const token = `ExponentPushToken[${prefix.replace(/[^A-Za-z0-9]/g, "")}]`;
  const projectId = randomUUID();
  const ownersDevice = randomUUID();
  await store.registerDevice({
    id: ownersDevice,
    ownerUserId: owner,
    token,
    projectId,
    platform: "ios",
  });
  await expect(
    store.registerDevice({
      id: randomUUID(),
      ownerUserId: stranger,
      token,
      projectId,
      platform: "ios",
    }),
  ).rejects.toThrow("already registered to another account");
  expect(await store.devices(owner)).toEqual([
    expect.objectContaining({ id: ownersDevice, token }),
  ]);
  expect(await store.devices(stranger)).toEqual([]);
  // The same person registering the same phone again keeps it.
  await store.registerDevice({
    id: ownersDevice,
    ownerUserId: owner,
    token,
    projectId,
    platform: "ios",
  });
  // After the owner signs out on the phone, the next person to sign in there takes the token.
  await store.removeDevice(owner, ownersDevice);
  const next = randomUUID();
  await store.registerDevice({
    id: next,
    ownerUserId: stranger,
    token,
    projectId,
    platform: "ios",
  });
  expect(await store.devices(stranger)).toEqual([
    expect.objectContaining({ id: next, token }),
  ]);
  expect(await store.devices(owner)).toEqual([]);
});
