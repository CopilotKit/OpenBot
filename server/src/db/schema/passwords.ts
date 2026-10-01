import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { SignInMethod, SignInStatus } from "../../passwords/types";
import { users } from "./core";
import { jsonb } from "./json";

/**
 * One person's saved logins, for the private sign-in form.
 *
 * The password is the same AES-GCM envelope `credentials.encrypted_value` holds (credentials.ts,
 * `encryptSecret`), under the deployment's KEY_ENCRYPTION_KEY. It is decrypted only on the path that
 * types it into a Bot's browser after the person confirmed that sign-in, and it is never returned by
 * any route: the list says which site and which username, nothing more.
 */
export const savedLogins = pgTable(
  "saved_logins",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Scheme, host and port, e.g. `https://example.com`. Never a path. */
    origin: text("origin").notNull(),
    username: text("username").notNull(),
    encryptedPassword: text("encrypted_password").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("saved_logins_owner_origin_username_idx").on(
      t.ownerUserId,
      t.origin,
      t.username,
    ),
    index("saved_logins_owner_idx").on(t.ownerUserId),
  ],
);

/**
 * A Bot asking its owner to sign it in to a website.
 *
 * Holds no credential at any point: the form posts the username and password to the server, the
 * server hands them to the Bot's computer, and only the outcome is written here. `continuation` is
 * the interrupted headless turn, the same shape an approval keeps, so an unattended turn can resume
 * with the outcome once the person has answered.
 */
export const signInRequests = pgTable(
  "sign_in_requests",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    botId: text("bot_id").notNull(),
    origin: text("origin").notNull(),
    reason: text("reason"),
    status: text("status").$type<SignInStatus>().notNull().default("pending"),
    method: text("method").$type<SignInMethod>(),
    /** What the Bot is told, never containing a credential. */
    outcome: text("outcome"),
    threadId: text("thread_id"),
    toolCallId: text("tool_call_id"),
    /** The takeover request, when the person chose to sign in by hand. */
    controlRequestId: text("control_request_id"),
    continuation: jsonb("continuation"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("sign_in_requests_owner_idx").on(t.ownerUserId, t.status),
    check(
      "sign_in_requests_status_check",
      sql`${t.status} IN ('pending', 'filling', 'taken_over', 'signed_in', 'failed', 'cancelled', 'expired')`,
    ),
    check(
      "sign_in_requests_method_check",
      sql`${t.method} IS NULL OR ${t.method} IN ('typed', 'saved', 'takeover')`,
    ),
  ],
);
