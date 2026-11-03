import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";

/**
 * One person's own mailbox, for the Email tools (`plugins/builtin-mail.ts`).
 *
 * The password is an app password, sealed in the same AES-GCM envelope `credentials.encrypted_value`
 * holds (credentials.ts, `encryptSecret`), under the deployment's KEY_ENCRYPTION_KEY. It is opened
 * only on the path that logs in to the mailbox for its owner, and no route ever returns it.
 *
 * One mailbox per person for now: the tools act on "your email", never somebody else's.
 */
export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    imapHost: text("imap_host").notNull(),
    imapPort: integer("imap_port").notNull(),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    username: text("username").notNull(),
    encryptedPassword: text("encrypted_password").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("mail_accounts_owner_idx").on(t.ownerUserId)],
);
