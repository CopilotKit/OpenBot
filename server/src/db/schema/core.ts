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
  /*
   * A deployment's OAuth client for an MCP server: the id and the secret an administrator registered
   * with the vendor.
   *
   * Its own kind rather than another `mcp`, because it is a different thing with different reach. A
   * client identifies this deployment to a vendor and can read nobody's data on its own; it is the
   * thing you must have before anybody can consent, and the thing you rotate when it leaks.
   */
  "mcp_oauth_client",
  /*
   * One person's refresh token for one MCP server.
   *
   * The far end of the same flow and the opposite risk: this reaches everything that person can see.
   * Distinct from the client so that "what does this deployment hold" stays answerable — one row
   * that speaks for the deployment, and one row per person that speaks for them.
   */
  "mcp_user_token",
]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  /**
   * The image this person chose in OpenBot.
   *
   * Separate from Better Auth's `image`: an identity provider owns that field and may refresh it on
   * sign-in. A person choosing a picture here must not have it quietly replaced the next morning.
   */
  avatarImage: text("avatar_image"),
  emailVerified: boolean("email_verified").notNull().default(false),
  /**
   * The person's groups, for a group-based rule to be evaluated against.
   *
   * Empty on every row: no sign-in path, claim mapping or admin screen writes this, and nothing
   * reads it. It is the other half of `channels.allowedGroups`, and #82 is about the pair. Anything
   * that starts deciding access on a group has to populate this first, or it decides on an empty
   * list for everybody.
   */
  groups: text("groups").array().notNull().default([]),
  /**
   * Where this person is in first-run onboarding.
   *
   * The step is where the wizard resumes if they leave halfway; the null completion timestamp is
   * what gates the app into /onboarding. Set once — finishing again keeps the first timestamp.
   */
  onboardingStep: integer("onboarding_step").notNull().default(0),
  onboardingCompletedAt: timestamp("onboarding_completed_at", {
    withTimezone: true,
  }),
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
    /*
     * Who vouched for this account, as the identity provider names itself.
     *
     * Required by Better Auth from 1.7. A real OIDC provider supplies its own
     * (`https://accounts.google.com`), and one without gets a synthetic
     * `local:oauth:<providerId>`, so nothing this deployment writes leaves it empty. It exists
     * because `providerId` alone stopped being enough once a deployment can register more than one
     * OIDC provider: two companies' Okta tenants are both "okta" and are not the same directory.
     *
     * Nullable in the database, deliberately, even though every write fills it. A rolling deploy runs
     * the migrations and then serves from old and new replicas at once, and an old replica inserts an
     * account without this column. Under `NOT NULL` that insert fails, so the release that adds the
     * column would break the first sign-in of everybody who landed on a replica that had not been
     * replaced yet. The constraint belongs to a later release, once no replica predates the column.
     */
    issuer: text("issuer"),
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

/**
 * An enterprise identity provider this deployment has been told about.
 *
 * The other three providers are configuration: one Google, one Entra, one Okta, named in the
 * environment. These are not, because a company's own IdP is not something a deployment can be
 * built knowing. It is registered while running, by an administrator holding the metadata their
 * identity team gave them, and there can be several.
 *
 * `oidcConfig` and `samlConfig` are JSON held as text because Better Auth writes them that way. They
 * carry a client secret or a signing certificate, so nothing here is ever projected to a browser.
 *
 * `domain` is what routes somebody to the right one: they type an email address, and the part after
 * the @ decides which identity provider is asked about them.
 */
export const ssoProviders = pgTable("sso_providers", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  /**
   * Who registered it, as a note rather than as an owner.
   *
   * Better Auth writes this and then scopes its own listing and delete routes to it, which is the
   * right model for a personal integration and the wrong one here: a company's Okta tenant does not
   * belong to whichever administrator pasted the metadata in. Reads and removals go through
   * identity-provider-store.ts instead, against the whole table.
   *
   * `set null` and not `cascade`. Under cascade, removing the person who set sign-in up deleted the
   * deployment's sign-in with them, which is a bad afternoon for a company whose IT lead has left.
   */
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
});

/**
 * People an administrator has removed, by email address.
 *
 * Keyed on the address rather than the user id, because deleting the user row is not removal: the
 * next sign-in through the identity provider creates it again, with a fresh id and no memory of
 * having been removed. The address is the only thing that survives that.
 *
 * Lower-cased on the way in, since a provider is free to return whatever case it likes and two rows
 * differing only in case would be one person with one of them enforced.
 */
export const revokedAccess = pgTable("revoked_access", {
  email: text("email").primaryKey(),
  revokedAt: timestamp("revoked_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Who did it, for the trail. Not a foreign key: an administrator may later be removed too. */
  revokedBy: text("revoked_by").notNull(),
});

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
    /**
     * Which groups the tenant package says this channel is for.
     *
     * Written by `synchronizeTenantPackage` and read by nothing. Channel access is membership: every
     * route resolves the caller in `channelMemberships` and refuses without a row, and this column is
     * not consulted on the way. It is not currently a hole, because package channels get no
     * membership rows either and so are unreachable rather than open, but it is a control the name
     * promises and nothing keeps. See #82, and `users.groups`, which is the half that has to arrive
     * from the identity provider before this one can decide anything.
     */
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
    /**
     * When this channel was deleted, or null. Soft: the row, the transcript, and the Intelligence
     * thread stay intact, and every read path filters on this instead. Channel grain, because
     * deleting is for everyone — per-member hiding would be a membership fact instead.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
    /**
     * When this member pinned the channel, or null. On the membership, not the channel: a pin is
     * one person's marker, and the membership row is already the per-member half of a channel.
     */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    /**
     * When this member last had the channel open, or null for never. On the membership like the
     * pin: reading is one person's act, and the unread marker it feeds is that person's alone.
     */
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
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

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: credentialKind("kind").notNull(),
    provider: text("provider").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    keyId: text("key_id").notNull(),
    metadata: jsonb("metadata").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // At most one live credential per (kind, provider, key_id). Revoked rows are
    // excluded so history is preserved, and two replicas racing to rotate the
    // same secret cannot both insert a live row.
    uniqueIndex("credentials_active_key_idx")
      .on(table.kind, table.provider, table.keyId)
      .where(sql`${table.revokedAt} IS NULL`),
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
  /*
   * The trail becomes the largest table in the deployment within weeks of real use: every click,
   * keystroke, scroll, tool call, refusal, command and sign-in is a row.
   *
   * One index on `created_at` served the unfiltered screen and nothing else. The audit screen filters
   * by event type, by who did it, and by what it was done to, and every one of those was a sequential
   * scan over the biggest table there is. Each filter therefore leads its own index and carries the
   * sort, so the filtered read is one index scan rather than a scan plus a sort.
   *
   * `id` is in each of them because the keyset pages on `(created_at, id)`: two rows written in the
   * same millisecond are ordered by id, and an index that stopped at the timestamp would leave the
   * tie to be broken by a sort.
   */
  (table) => [
    index("audit_events_created_at_idx").on(table.createdAt),
    index("audit_events_type_time_idx").on(
      table.eventType,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("audit_events_actor_time_idx").on(
      table.actorUserId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("audit_events_target_time_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
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
