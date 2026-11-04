import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { bots } from "../agents/bot-registry/directory";
import type { Database } from "../db/client";
import {
  type DeliveryChallenge,
  deliveryChallenges,
  deliveryInbox,
  deliveryOutbox,
} from "../db/schema/delivery";
import {
  proactiveSettings,
  proactiveSuggestions,
} from "../db/schema/proactive";
import { workItems } from "../db/schema/work";
import { deliveryDirectory, type StoredBinding } from "./directory";
import {
  type BindingTransport,
  type DeliveryBinding,
  type DeliveryKind,
  DeliveryNotFoundError,
  type DeliveryScope,
  type DeliveryState,
  type PushDevice,
} from "./types";

/**
 * Delivery, as the router and routes use it.
 *
 * WHERE EACH PART LIVES. A person's bindings and push devices are theirs to keep and live in
 * Intelligence (delivery/directory.ts, held in memory on every instance). The inbound and outbound
 * queues and the pairing codes in flight are operational: a queued message is already in its
 * conversation's thread in Intelligence, and a pairing code lasts ten minutes. They stay in this
 * deployment's database, beside the work queue that runs them, so a send and the work item that
 * carries it still commit together.
 */
export function createDeliveryStore(database: Database) {
  async function enqueue(
    db: Pick<Database, "insert" | "execute">,
    kind: string,
    key: string,
    runAt?: Date,
  ) {
    await db
      .insert(workItems)
      .values({ kind, key, payload: {}, ...(runAt ? { runAt } : {}) })
      .onConflictDoNothing();
    await db.execute(sql`select pg_notify('openbot_work_offered', ${kind})`);
  }
  return {
    async listBindings(owner: string): Promise<StoredBinding[]> {
      return deliveryDirectory()
        .bindings()
        .filter((binding) => binding.ownerUserId === owner);
    },
    async binding(id: string) {
      return deliveryDirectory().binding(id);
    },
    async findBinding(
      transport: BindingTransport,
      realm: string,
      identity: string,
      address?: string,
    ) {
      return (
        deliveryDirectory()
          .bindings()
          .find(
            (binding) =>
              binding.transport === transport &&
              binding.realm === realm &&
              binding.identity === identity &&
              binding.enabled &&
              (address === undefined || binding.address === address),
          ) ?? null
      );
    },
    async bindingsFor(scope: DeliveryScope) {
      return deliveryDirectory()
        .bindings()
        .filter(
          (binding) =>
            binding.ownerUserId === scope.ownerUserId &&
            binding.channelId === scope.channelId &&
            binding.agentId === scope.agentId &&
            binding.threadId === scope.threadId &&
            binding.enabled,
        );
    },
    /**
     * The person's connected chat and SMS accounts, most recently used first: by the last message
     * they sent through one, or when it was connected if they never have. A ping goes into the first
     * one on each platform, the conversation they are most likely looking at.
     */
    async bindingsByUse(owner: string): Promise<DeliveryBinding[]> {
      const mine = deliveryDirectory()
        .bindings()
        .filter((binding) => binding.ownerUserId === owner && binding.enabled);
      if (mine.length === 0) return [];
      // The last message through each binding is in this deployment's own inbound queue.
      const lastUse = await database
        .select({
          bindingId: deliveryInbox.bindingId,
          at: max(deliveryInbox.createdAt),
        })
        .from(deliveryInbox)
        .where(
          and(
            eq(deliveryInbox.ownerUserId, owner),
            inArray(
              deliveryInbox.bindingId,
              mine.map((binding) => binding.id),
            ),
          ),
        )
        .groupBy(deliveryInbox.bindingId);
      const usedAt = new Map(
        lastUse.map((row) => [row.bindingId, row.at?.getTime() ?? 0]),
      );
      const recency = (binding: StoredBinding) =>
        Math.max(binding.createdAt.getTime(), usedAt.get(binding.id) ?? 0);
      return mine.sort(
        (left, right) =>
          recency(right) - recency(left) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
    },
    /**
     * Where the items a ping carries were found: each one's check-in conversation with its Bot,
     * newest item first. A ping's push is filed under the first of these the person can still reach.
     */
    async checkInConversations(
      owner: string,
      suggestionIds: string[],
    ): Promise<{ agentId: string; channelId: string }[]> {
      if (suggestionIds.length === 0) return [];
      return database
        .select({
          agentId: proactiveSuggestions.agentId,
          channelId: proactiveSettings.channelId,
        })
        .from(proactiveSuggestions)
        .innerJoin(
          proactiveSettings,
          eq(proactiveSettings.id, proactiveSuggestions.settingId),
        )
        .where(
          and(
            eq(proactiveSuggestions.ownerUserId, owner),
            inArray(proactiveSuggestions.id, suggestionIds),
          ),
        )
        .orderBy(
          desc(proactiveSuggestions.createdAt),
          desc(proactiveSuggestions.id),
        );
    },
    async bind(input: Omit<DeliveryBinding, "id" | "enabled">) {
      // An identity already bound to this person is pointed at the new conversation and keeps its
      // id; one bound to somebody else is refused. Intelligence decides both, in one step.
      return deliveryDirectory().bind({ ...input, id: randomUUID() });
    },
    async removeBinding(owner: string, id: string) {
      const binding = await deliveryDirectory().binding(id);
      if (!binding || binding.ownerUserId !== owner)
        throw new DeliveryNotFoundError("Connection not found.");
      if (!(await deliveryDirectory().changeBinding(id, { enabled: false })))
        throw new DeliveryNotFoundError("Connection not found.");
    },
    async challenge(
      scope: DeliveryScope,
      transport: BindingTransport,
      address: string | null,
    ) {
      const id = randomUUID();
      await database.insert(deliveryChallenges).values({
        id,
        ...scope,
        transport,
        address,
        expiresAt: sql`now() + interval '10 minutes'`,
      });
      return id;
    },
    async readChallenge(
      id: string,
      owner?: string,
    ): Promise<DeliveryChallenge | null> {
      return (
        (
          await database
            .select()
            .from(deliveryChallenges)
            .where(
              and(
                eq(deliveryChallenges.id, id),
                isNull(deliveryChallenges.consumedAt),
                sql`${deliveryChallenges.expiresAt} > now()`,
                ...(owner ? [eq(deliveryChallenges.ownerUserId, owner)] : []),
              ),
            )
        )[0] ?? null
      );
    },
    async consumeChallenge(id: string, owner: string) {
      const rows = await database
        .update(deliveryChallenges)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(deliveryChallenges.id, id),
            eq(deliveryChallenges.ownerUserId, owner),
            isNull(deliveryChallenges.consumedAt),
            sql`${deliveryChallenges.expiresAt} > now()`,
          ),
        )
        .returning();
      return rows.length === 1;
    },
    async registerDevice(input: Omit<PushDevice, "enabled">) {
      // A token already held by someone else moves only once its owner has signed out on that phone
      // (which disables the registration). Otherwise anyone who learned a token could take over its
      // notifications, approval and sign-in links included. Intelligence holds that rule.
      return deliveryDirectory().register(input);
    },
    async devices(owner: string) {
      return deliveryDirectory()
        .devices()
        .filter((device) => device.ownerUserId === owner && device.enabled);
    },
    async device(id: string) {
      return deliveryDirectory().device(id);
    },
    async removeDevice(owner: string, id: string) {
      const device = await deliveryDirectory().device(id);
      if (!device || device.ownerUserId !== owner) return;
      await deliveryDirectory().changeDevice(id, false);
    },
    /**
     * A turn a paired chat surface is running right now, recorded for dedupe and visibility only.
     * Deliberately not enqueued: the caller runs it inline and streams the answer back, so a queued
     * copy would run the same message twice. Returns null when this provider message was seen before.
     */
    async recordInbox(
      input: DeliveryScope & {
        bindingId: string;
        source: BindingTransport;
        realm: string;
        externalId: string;
        text: string;
      },
    ) {
      const [row] = await database
        .insert(deliveryInbox)
        .values({ ...input, id: randomUUID(), state: "running" })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },
    /**
     * Twilio Advanced Opt-Out. The binding stays connected (START clears it); outbound sends see the
     * mark and record `opted_out`. A person who disconnects in OpenBot still disables it outright.
     */
    async setSmsOptOut(realm: string, identity: string, optedOut: boolean) {
      const matching = deliveryDirectory()
        .bindings()
        .filter(
          (binding) =>
            binding.transport === "sms" &&
            binding.realm === realm &&
            binding.identity === identity &&
            binding.enabled,
        );
      const changed: { id: string; ownerUserId: string; channelId: string }[] =
        [];
      for (const binding of matching) {
        const updated = await deliveryDirectory().changeBinding(binding.id, {
          optedOut,
        });
        if (updated)
          changed.push({
            id: updated.id,
            ownerUserId: updated.ownerUserId,
            channelId: updated.channelId,
          });
      }
      return changed;
    },
    /** The Bot's display name and avatar seed, so a chat surface can post under its identity. */
    async botIdentity(agentId: string) {
      const row = await bots().find(agentId);
      return row
        ? {
            agentId,
            name: row.name,
            ...(row.avatarSeed ? { avatarSeed: row.avatarSeed } : {}),
          }
        : null;
    },
    async inbox(id: string) {
      return (
        (
          await database
            .select()
            .from(deliveryInbox)
            .where(eq(deliveryInbox.id, id))
        )[0] ?? null
      );
    },
    async offerInbox(
      input: DeliveryScope & {
        bindingId: string | null;
        source: BindingTransport | "native";
        realm: string;
        externalId: string;
        text: string;
      },
    ) {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .insert(deliveryInbox)
          .values({ ...input, id: randomUUID() })
          .onConflictDoNothing()
          .returning();
        if (!row) return { queued: false };
        await enqueue(tx, "delivery.inbound", row.id);
        return { queued: true, id: row.id };
      });
    },
    async setInbox(
      id: string,
      state: DeliveryState,
      error: string | null = null,
    ) {
      await database
        .update(deliveryInbox)
        .set({ state, error })
        .where(eq(deliveryInbox.id, id));
    },
    async outbox(id: string) {
      return (
        (
          await database
            .select()
            .from(deliveryOutbox)
            .where(eq(deliveryOutbox.id, id))
        )[0] ?? null
      );
    },
    async offerOutbox(
      input: DeliveryScope & {
        dedupeKey: string;
        bindingId: string | null;
        deviceId: string | null;
        transport: BindingTransport | "push";
        text: string;
        kind: DeliveryKind;
        requestId: string | null;
      },
    ) {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .insert(deliveryOutbox)
          .values({ ...input, id: randomUUID() })
          .onConflictDoNothing()
          .returning();
        if (row) await enqueue(tx, "delivery.outbound", row.id);
        return row ?? null;
      });
    },
    async startOutbox(id: string) {
      return (
        (
          await database
            .update(deliveryOutbox)
            .set({ state: "running" })
            .where(
              and(
                eq(deliveryOutbox.id, id),
                eq(deliveryOutbox.state, "queued"),
              ),
            )
            .returning()
        )[0] ?? null
      );
    },
    async setOutbox(
      id: string,
      state: DeliveryState,
      error: string | null = null,
      providerId?: string,
    ) {
      await database
        .update(deliveryOutbox)
        .set({ state, error, ...(providerId ? { providerId } : {}) })
        .where(eq(deliveryOutbox.id, id));
    },
    async offerReceipt(id: string) {
      await enqueue(
        database,
        "delivery.push-receipt",
        id,
        new Date(Date.now() + 15 * 60_000),
      );
    },
    async updateSmsStatus(
      providerId: string,
      state: "delivered" | "failed" | "sent",
      error: string | null,
    ) {
      await database
        .update(deliveryOutbox)
        .set({ state, error })
        .where(
          and(
            eq(deliveryOutbox.transport, "sms"),
            eq(deliveryOutbox.providerId, providerId),
          ),
        );
    },
    async history(owner: string) {
      return database
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.ownerUserId, owner))
        .orderBy(desc(deliveryOutbox.createdAt))
        .limit(100);
    },
  };
}
export type DeliveryStore = ReturnType<typeof createDeliveryStore>;
