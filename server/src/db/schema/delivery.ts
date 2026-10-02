import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  BindingTransport,
  DeliveryScope,
  DeliveryState,
} from "../../delivery/types";
import { agents, channels, users } from "./core";

const at = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const scope = () => ({
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull(),
});
export const deliveryBindings = pgTable(
  "delivery_bindings",
  {
    id: text("id").primaryKey(),
    ...scope(),
    transport: text("transport").$type<BindingTransport>().notNull(),
    identity: text("identity").notNull(),
    realm: text("realm").notNull(),
    address: text("address").notNull(),
    mentionId: text("mention_id"),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * When an SMS recipient replied STOP (Twilio Advanced Opt-Out); null while they may be texted.
     * Separate from `enabled`: the person stays connected and START clears it.
     */
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
    createdAt: at(),
  },
  (t) => [
    uniqueIndex("delivery_binding_identity_idx").on(
      t.transport,
      t.realm,
      t.identity,
    ),
    index("delivery_bindings_owner_idx").on(t.ownerUserId),
  ],
);
export const deliveryChallenges = pgTable("delivery_challenges", {
  id: text("id").primaryKey(),
  ...scope(),
  transport: text("transport").$type<BindingTransport>().notNull(),
  address: text("address"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: at(),
});
export const pushDevices = pgTable(
  "push_devices",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    projectId: text("project_id").notNull(),
    platform: text("platform").$type<"ios" | "android">().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: at(),
  },
  (t) => [index("push_devices_owner_idx").on(t.ownerUserId)],
);
export const deliveryInbox = pgTable(
  "delivery_inbox",
  {
    id: text("id").primaryKey(),
    ...scope(),
    bindingId: text("binding_id"),
    source: text("source").$type<BindingTransport | "native">().notNull(),
    realm: text("realm").notNull(),
    externalId: text("external_id").notNull(),
    text: text("text").notNull(),
    state: text("state").$type<DeliveryState>().notNull().default("queued"),
    error: text("error"),
    createdAt: at(),
  },
  (t) => [
    uniqueIndex("delivery_inbox_dedupe_idx").on(
      t.source,
      t.realm,
      t.externalId,
    ),
    index("delivery_inbox_owner_idx").on(t.ownerUserId, t.createdAt),
  ],
);
export const deliveryOutbox = pgTable(
  "delivery_outbox",
  {
    id: text("id").primaryKey(),
    ...scope(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    bindingId: text("binding_id"),
    deviceId: text("device_id"),
    transport: text("transport").$type<BindingTransport | "push">().notNull(),
    text: text("text").notNull(),
    kind: text("kind").$type<"reply" | "question" | "approval">().notNull(),
    requestId: text("request_id"),
    state: text("state").$type<DeliveryState>().notNull().default("queued"),
    providerId: text("provider_id"),
    error: text("error"),
    createdAt: at(),
  },
  (t) => [
    index("delivery_outbox_owner_idx").on(t.ownerUserId, t.createdAt),
    index("delivery_outbox_provider_idx").on(t.transport, t.providerId),
  ],
);
// Stored scope is intentionally canonical; requests cannot supply a different thread when confirming.
export type DeliveryChallenge = DeliveryScope & {
  id: string;
  transport: BindingTransport;
  address: string | null;
};
