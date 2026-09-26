import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { LearningSettings } from "../../../../shared/learning";
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
