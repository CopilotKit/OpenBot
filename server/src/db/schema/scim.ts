/**
 * The tables `@better-auth/scim` keeps, declared here so a generated migration creates them.
 *
 * Better Auth's drizzle adapter finds a model by its plural key in the schema object handed to it
 * (`scimUser` -> `scimUsers`) and a column by its JavaScript property name, so every property below is
 * spelled exactly as the plugin's own schema spells the field. The SQL names are ours and snake_case,
 * like every other table. Field list and flags copied from the plugin's `schema` block in
 * `@better-auth/scim@1.7.1` (`dist/index.mjs`); `returned: false` there has no storage meaning.
 *
 * Owned by the plugin: nothing in OpenBot writes these directly. Deprovisioning is reacted to through
 * the plugin's `identity.reconcileUser` hook in `auth/scim.ts`, never by reading these rows.
 */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";

const at = (name: string) => timestamp(name, { withTimezone: true });

export const scimConnectionBindings = pgTable(
  "scim_connection_bindings",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    connectionKey: text("connection_key").notNull().unique(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    createdAt: at("created_at").notNull(),
    decommissionedAt: at("decommissioned_at"),
    decommissionStatus: text("decommission_status").notNull().default("active"),
    decommissionCursorUserId: text("decommission_cursor_user_id"),
    decommissionReconciledUserCount: integer(
      "decommission_reconciled_user_count",
    )
      .notNull()
      .default(0),
    decommissionBatchCount: integer("decommission_batch_count")
      .notNull()
      .default(0),
    decommissionRevision: integer("decommission_revision").notNull().default(0),
    decommissionCompletedAt: at("decommission_completed_at"),
    decommissionLeaseId: text("decommission_lease_id"),
    decommissionLeaseExpiresAt: at("decommission_lease_expires_at"),
  },
  (table) => [
    index("scim_connection_bindings_connection_idx").on(table.connectionId),
  ],
);

export const scimIdentityTombstones = pgTable(
  "scim_identity_tombstones",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    externalId: text("external_id").notNull(),
    externalIdKey: text("external_id_key").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    profile: text("profile").notNull(),
    deletedAt: at("deleted_at").notNull(),
  },
  (table) => [
    index("scim_identity_tombstones_connection_idx").on(table.connectionId),
    index("scim_identity_tombstones_domain_idx").on(table.provisioningDomainId),
    index("scim_identity_tombstones_user_idx").on(table.userId),
  ],
);

export const scimSubjects = pgTable(
  "scim_subjects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    profileSourceId: text("profile_source_id"),
    revision: integer("revision").notNull(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [
    index("scim_subjects_profile_source_idx").on(table.profileSourceId),
  ],
);

export const scimUsers = pgTable(
  "scim_users",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionUserKey: text("connection_user_key").notNull().unique(),
    userName: text("user_name").notNull(),
    userNameKey: text("user_name_key").notNull().unique(),
    primaryEmail: text("primary_email").notNull(),
    workEmailValueIndex: text("work_email_value_index").notNull(),
    emailValueIndex: text("email_value_index").notNull(),
    displayName: text("display_name").notNull(),
    formattedName: text("formatted_name").notNull(),
    givenName: text("given_name"),
    familyName: text("family_name"),
    serializedEmails: text("serialized_emails").notNull(),
    serializedAttributes: text("serialized_attributes"),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key").unique(),
    active: boolean("active").notNull(),
    orderKey: text("order_key").notNull().unique(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [
    index("scim_users_connection_idx").on(table.connectionId),
    index("scim_users_domain_idx").on(table.provisioningDomainId),
    index("scim_users_user_idx").on(table.userId),
  ],
);

export const scimProjectionGrants = pgTable(
  "scim_projection_grants",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    scimUserId: text("scim_user_id")
      .notNull()
      .references(() => scimUsers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceValue: text("source_value"),
    role: text("role").notNull(),
    grantKey: text("grant_key").notNull().unique(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [
    index("scim_projection_grants_connection_idx").on(table.connectionId),
    index("scim_projection_grants_domain_idx").on(table.provisioningDomainId),
    index("scim_projection_grants_scim_user_idx").on(table.scimUserId),
    index("scim_projection_grants_user_idx").on(table.userId),
  ],
);

export const scimGroups = pgTable(
  "scim_groups",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    provisioningDomainId: text("provisioning_domain_id").notNull(),
    revision: integer("revision").notNull().default(0),
    displayName: text("display_name").notNull(),
    displayNameKey: text("display_name_key").notNull().unique(),
    externalId: text("external_id"),
    externalIdKey: text("external_id_key").unique(),
    orderKey: text("order_key").notNull().unique(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [
    index("scim_groups_connection_idx").on(table.connectionId),
    index("scim_groups_domain_idx").on(table.provisioningDomainId),
  ],
);

export const scimGroupMembers = pgTable(
  "scim_group_members",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => scimGroups.id, { onDelete: "cascade" }),
    scimUserId: text("scim_user_id")
      .notNull()
      .references(() => scimUsers.id, { onDelete: "cascade" }),
    membershipKey: text("membership_key").notNull().unique(),
    createdAt: at("created_at").notNull(),
  },
  (table) => [
    index("scim_group_members_connection_idx").on(table.connectionId),
    index("scim_group_members_group_idx").on(table.groupId),
    index("scim_group_members_scim_user_idx").on(table.scimUserId),
  ],
);
