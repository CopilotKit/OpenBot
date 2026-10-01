import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import {
  type DeliveryChallenge,
  deliveryBindings,
  deliveryChallenges,
  deliveryInbox,
  deliveryOutbox,
  pushDevices,
} from "../db/schema/delivery";
import { workItems } from "../db/schema/work";
import {
  type BindingTransport,
  type DeliveryBinding,
  DeliveryNotFoundError,
  DeliveryRefusedError,
  type DeliveryScope,
  type DeliveryState,
  type PushDevice,
} from "./types";
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
    async listBindings(owner: string) {
      return database
        .select()
        .from(deliveryBindings)
        .where(eq(deliveryBindings.ownerUserId, owner));
    },
    async binding(id: string) {
      return (
        (
          await database
            .select()
            .from(deliveryBindings)
            .where(eq(deliveryBindings.id, id))
        )[0] ?? null
      );
    },
    async findBinding(
      transport: BindingTransport,
      realm: string,
      identity: string,
      address?: string,
    ) {
      return (
        (
          await database
            .select()
            .from(deliveryBindings)
            .where(
              and(
                eq(deliveryBindings.transport, transport),
                eq(deliveryBindings.realm, realm),
                eq(deliveryBindings.identity, identity),
                eq(deliveryBindings.enabled, true),
                ...(address ? [eq(deliveryBindings.address, address)] : []),
              ),
            )
        )[0] ?? null
      );
    },
    async bindingsFor(scope: DeliveryScope) {
      return database
        .select()
        .from(deliveryBindings)
        .where(
          and(
            eq(deliveryBindings.ownerUserId, scope.ownerUserId),
            eq(deliveryBindings.channelId, scope.channelId),
            eq(deliveryBindings.agentId, scope.agentId),
            eq(deliveryBindings.threadId, scope.threadId),
            eq(deliveryBindings.enabled, true),
          ),
        );
    },
    async bind(input: Omit<DeliveryBinding, "id" | "enabled">) {
      return database.transaction(async (tx) => {
        const existing = (
          await tx
            .select()
            .from(deliveryBindings)
            .where(
              and(
                eq(deliveryBindings.transport, input.transport),
                eq(deliveryBindings.realm, input.realm),
                eq(deliveryBindings.identity, input.identity),
              ),
            )
            .for("update")
        )[0];
        if (existing && existing.ownerUserId !== input.ownerUserId)
          throw new DeliveryRefusedError(
            "That identity is already connected to another person.",
          );
        const row = {
          ...input,
          id: existing?.id ?? randomUUID(),
          enabled: true,
        };
        const [bound] = await tx
          .insert(deliveryBindings)
          .values(row)
          .onConflictDoUpdate({
            target: [
              deliveryBindings.transport,
              deliveryBindings.realm,
              deliveryBindings.identity,
            ],
            set: {
              channelId: row.channelId,
              agentId: row.agentId,
              threadId: row.threadId,
              address: row.address,
              mentionId: row.mentionId ?? null,
              enabled: true,
            },
            setWhere: eq(deliveryBindings.ownerUserId, input.ownerUserId),
          })
          .returning();
        if (!bound)
          throw new DeliveryRefusedError(
            "That identity is already connected to another person.",
          );
        return bound;
      });
    },
    async removeBinding(owner: string, id: string) {
      const rows = await database
        .update(deliveryBindings)
        .set({ enabled: false })
        .where(
          and(
            eq(deliveryBindings.ownerUserId, owner),
            eq(deliveryBindings.id, id),
          ),
        )
        .returning();
      if (!rows.length)
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
      const [device] = await database
        .insert(pushDevices)
        .values({ ...input, enabled: true })
        .onConflictDoUpdate({
          target: pushDevices.token,
          set: {
            id: input.id,
            ownerUserId: input.ownerUserId,
            projectId: input.projectId,
            platform: input.platform,
            enabled: true,
          },
        })
        .returning();
      return device;
    },
    async devices(owner: string) {
      return database
        .select()
        .from(pushDevices)
        .where(
          and(
            eq(pushDevices.ownerUserId, owner),
            eq(pushDevices.enabled, true),
          ),
        );
    },
    async device(id: string) {
      return (
        (
          await database
            .select()
            .from(pushDevices)
            .where(eq(pushDevices.id, id))
        )[0] ?? null
      );
    },
    async removeDevice(owner: string, id: string) {
      await database
        .update(pushDevices)
        .set({ enabled: false })
        .where(and(eq(pushDevices.id, id), eq(pushDevices.ownerUserId, owner)));
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
      return database
        .update(deliveryBindings)
        .set({ optedOutAt: optedOut ? sql`now()` : null })
        .where(
          and(
            eq(deliveryBindings.transport, "sms"),
            eq(deliveryBindings.realm, realm),
            eq(deliveryBindings.identity, identity),
            eq(deliveryBindings.enabled, true),
          ),
        )
        .returning({
          id: deliveryBindings.id,
          ownerUserId: deliveryBindings.ownerUserId,
          channelId: deliveryBindings.channelId,
        });
    },
    /** The Bot's display name and avatar seed, so a chat surface can post under its identity. */
    async botIdentity(agentId: string) {
      const [row] = await database
        .select({ name: agents.name, avatarSeed: agentProfiles.avatarSeed })
        .from(agents)
        .leftJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(eq(agents.id, agentId))
        .limit(1);
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
        kind: "reply" | "question" | "approval";
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
