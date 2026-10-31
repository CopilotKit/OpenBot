import type {
  LearningSettings,
  LearningSharingMode,
} from "@openbot/shared/learning";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";

export const learningSettings = pgTable("learning_settings", {
  id: text("id").primaryKey(),
  settings: jsonb("settings").$type<LearningSettings>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** A Thread cannot move containers. Null records an explicit unassigned first run. */
export const learningThreadBindings = pgTable(
  "learning_thread_bindings",
  {
    userId: text("user_id").notNull(),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    containerId: text("container_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.threadId] })],
);

/**
 * A person's own Learning space: the Intelligence Learning container every recording they make joins
 * (learning/personal-space.ts). A row means OpenBot saw the container exist, because it created it, Intelligence said
 * the id was already taken, or the runtime key read it. The id is derived from the person's, so the row only remembers
 * that it exists. It goes with its person; the container stays in Intelligence.
 */
export const learningPersonSpaces = pgTable("learning_person_spaces", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  containerId: text("container_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Who else's Bots use the Skills learned in a person's own space: `closed` (only their own Bots, and the meaning of no
 * row), `open` (every Bot in the deployment) or `choose` (every Bot, for the Skills listed in learning_open_skills).
 */
export const learningSkillSharing = pgTable(
  "learning_skill_sharing",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    mode: text("mode").$type<LearningSharingMode>().notNull().default("closed"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "learning_skill_sharing_mode_check",
      sql`${table.mode} IN ('closed', 'open', 'choose')`,
    ),
    // Delivery reads only the people who opened something.
    index("learning_skill_sharing_open_idx")
      .on(table.userId)
      .where(sql`${table.mode} <> 'closed'`),
  ],
);

/**
 * The Skills a person in `choose` opened to every Bot, by name. Kept when they switch to another mode, so switching back
 * opens the same ones again.
 */
export const learningOpenSkills = pgTable(
  "learning_open_skills",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillName: text("skill_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.skillName] })],
);
