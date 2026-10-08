// server/src/db/schema/identity.ts
/**
 * Accounts at outside providers, linked to OpenBot users.
 *
 * Provider-neutral on purpose: Slack senders and GitHub users are the same question ("who is this
 * here?") asked in two places. See docs/superpowers/specs/2026-10-08-github-app-integration-design.md.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { credentials } from "./core";

const at = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

/** `user_id` is deliberately not a foreign key: a deleted user's link must not become a guest. */
export const identityLinks = pgTable(
  "identity_links",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    realm: text("realm").notNull(),
    subject: text("subject").notNull(),
    userId: text("user_id").notNull(),
    handle: text("handle"),
    verifiedBy: text("verified_by").$type<"challenge" | "oauth">().notNull(),
    credentialId: uuid("credential_id").references(() => credentials.id),
    status: text("status")
      .$type<"active" | "needs_reconnect">()
      .notNull()
      .default("active"),
    createdAt: at("created_at"),
    updatedAt: at("updated_at"),
  },
  (table) => [
    uniqueIndex("identity_links_identity_idx").on(
      table.provider,
      table.realm,
      table.subject,
    ),
    // Also serves (user_id, provider) lookups as its prefix.
    uniqueIndex("identity_links_user_realm_idx").on(
      table.userId,
      table.provider,
      table.realm,
    ),
    check(
      "identity_links_verified_by_check",
      sql`${table.verifiedBy} IN ('challenge', 'oauth')`,
    ),
    check(
      "identity_links_status_check",
      sql`${table.status} IN ('active', 'needs_reconnect')`,
    ),
  ],
);

/** Neither possession of the token nor the signed-in confirmation alone establishes a link. */
export const identityLinkChallenges = pgTable(
  "identity_link_challenges",
  {
    tokenHash: text("token_hash").primaryKey(),
    provider: text("provider").notNull(),
    realm: text("realm").notNull(),
    subject: text("subject").notNull(),
    handle: text("handle"),
    confirmedUserId: text("confirmed_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("identity_link_challenges_expiry_idx").on(table.expiresAt)],
);
