import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
// NOT drizzle's `jsonb`: that one serialises, and so does the driver, so every object landed as a
// JSON string and nothing in this database could be queried by a JSON field. See ./json.ts.
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const role = pgEnum("role", ["admin", "user"]);
export const agentType = pgEnum("agent_type", ["built_in", "remote_ag_ui"]);
export const credentialKind = pgEnum("credential_kind", [
  "model",
  "connector",
  // A customer's own agent behind a key. Its own kind so "what does this deployment hold" stays true.
  "agent",
  // A token for an MCP server. Same vault and same revocation as everything else, so the server row
  // holds a pointer and never the secret.
  "mcp",
]);
export const connectorType = pgEnum("connector_type", [
  "google_drive",
  "onedrive",
]);
export const syncStatus = pgEnum("sync_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export const aclEffect = pgEnum("acl_effect", ["allow", "deny"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  emailVerified: boolean("email_verified").notNull().default(false),
  groups: text("groups").array().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("accounts_provider_account_idx").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: role("role").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

export const deploymentPackages = pgTable("deployment_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull().unique(),
  sourcePath: text("source_path").notNull(),
  checksum: text("checksum").notNull(),
  loadedAt: timestamp("loaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: agentType("type").notNull(),
  configuration: jsonb("configuration").notNull(),
  packageId: uuid("package_id").references(() => deploymentPackages.id, {
    onDelete: "set null",
  }),
  override: jsonb("override"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    suggestedPrompts: text("suggested_prompts").array().notNull().default([]),
    allowedGroups: text("allowed_groups").array().notNull().default([]),
    packageId: uuid("package_id").references(() => deploymentPackages.id, {
      onDelete: "set null",
    }),
    override: jsonb("override"),
    /**
     * The last thing said in this channel, denormalised so a roster is one indexed read.
     *
     * Channel grain, not per-member: what was said last is a property of the conversation, and a copy
     * per member is the same fact stored N times, drifting. Per-member state, what somebody has read
     *, belongs on the membership instead.
     *
     * Written by whoever ran the agent, from the client that already received the reply, so it is a
     * cache of what a client observed rather than an authoritative mirror of the thread.
     */
    lastMessage: text("last_message"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Which agent spoke, so a channel with several can show the right one. Null for a person. */
    lastMessageAgentId: text("last_message_agent_id").references(
      () => agents.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * The order the channel list is drawn in.
     *
     * On the expression, not on the column, because the list sorts by the last thing said and falls
     * back to when the channel was made. An index on `last_message_at` alone does not serve that
     * ordering, so the sort would fall back to a scan on exactly the query drawn on every page.
     *
     * Declared here rather than only in a migration. An index that exists in the database and not in
     * the schema is invisible to `generate`, so the next generated migration proposes a schema
     * without it and it is silently dropped.
     */
    index("channels_recent_activity_idx").on(
      sql`COALESCE(${table.lastMessageAt}, ${table.createdAt}) DESC`,
    ),
  ],
);

export const channelMemberships = pgTable(
  "channel_memberships",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.userId] })],
);

export const channelAgents = pgTable(
  "channel_agents",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.agentId] })],
);

export const credentials = pgTable("credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: credentialKind("kind").notNull(),
  provider: text("provider").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  keyId: text("key_id").notNull(),
  metadata: jsonb("metadata").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const connectorInstances = pgTable("connector_instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: connectorType("type").notNull(),
  credentialId: uuid("credential_id").references(() => credentials.id, {
    onDelete: "set null",
  }),
  status: syncStatus("status").notNull().default("pending"),
  sourceMetadata: jsonb("source_metadata").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const connectorCursors = pgTable("connector_cursors", {
  connectorInstanceId: uuid("connector_instance_id")
    .primaryKey()
    .references(() => connectorInstances.id, { onDelete: "cascade" }),
  cursor: text("cursor"),
  updatedAt: updatedAt(),
});

export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  connectorInstanceId: uuid("connector_instance_id")
    .notNull()
    .references(() => connectorInstances.id, { onDelete: "cascade" }),
  providerSubscriptionId: text("provider_subscription_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorInstanceId: uuid("connector_instance_id")
      .notNull()
      .references(() => connectorInstances.id, { onDelete: "cascade" }),
    status: syncStatus("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    stats: jsonb("stats").notNull(),
  },
  (table) => [
    index("sync_runs_connector_started_at_idx").on(
      table.connectorInstanceId,
      table.startedAt,
    ),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorInstanceId: uuid("connector_instance_id")
      .notNull()
      .references(() => connectorInstances.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    metadata: jsonb("metadata").notNull(),
    contentHash: text("content_hash").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("documents_connector_source_idx").on(
      table.connectorInstanceId,
      table.sourceId,
    ),
    index("documents_connector_deleted_idx").on(
      table.connectorInstanceId,
      table.deletedAt,
    ),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("chunks_document_position_idx").on(
      table.documentId,
      table.position,
    ),
    index("chunks_document_idx").on(table.documentId),
  ],
);

export const documentAcls = pgTable(
  "document_acls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    principal: text("principal").notNull(),
    effect: aclEffect("effect").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("document_acls_document_principal_effect_idx").on(
      table.documentId,
      table.principal,
      table.effect,
    ),
    index("document_acls_principal_idx").on(table.principal),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Who did it, as an id rather than a reference. No foreign key: the trail is append-only, so any
     * cascade the database wanted to run against it would be an update the trigger refuses, and a
     * user who had done anything could never be deleted.
     */
    actorUserId: text("actor_user_id"),
    eventType: text("event_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("audit_events_created_at_idx").on(table.createdAt)],
);

export const intelligenceChannelMappings = pgTable(
  "intelligence_channel_mappings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.channelId] }),
    uniqueIndex("intelligence_channel_mappings_thread_idx").on(table.threadId),
  ],
);
