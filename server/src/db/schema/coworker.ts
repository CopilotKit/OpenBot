/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import {
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const agentVisibility = pgEnum("agent_visibility", [
  "public",
  "private",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    visibility: agentVisibility("visibility").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
  ],
);

/**
 * What one person has decided about one Bot.
 *
 * Per person and per Bot, because both of the things kept here are opinions rather than facts about
 * the Bot: hiding it from a roster changes nothing for anybody else, and neither does silencing it.
 * A row exists only once somebody has said something, so the absence of a row is the default answer
 * to every column, which is why every column is nullable.
 */
export const agentPreferences = pgTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    /**
     * When this person silenced this Bot's notifications, or null.
     *
     * A timestamp rather than a boolean, matching `hiddenAt`, because "when did this stop telling me
     * anything" is the question somebody asks after a Bot has been quiet for a week and they cannot
     * remember doing it.
     *
     * Silences the notification only. The Bot still asks for help, its screen still shows the
     * prompt, and the audit trail still records the handover, because a preference about being
     * interrupted must not be able to turn into a preference about being governed.
     */
    notificationsMutedAt: timestamp("notifications_muted_at", {
      withTimezone: true,
    }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);
