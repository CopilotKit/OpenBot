/** Content-free evidence for product analytics; local audit remains authoritative. */
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { jsonb } from "./json";

export const productTelemetryRuns = pgTable(
  "product_telemetry_runs",
  {
    runId: text("run_id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    threadId: text("thread_id").notNull(),
    context: jsonb("context").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    outcome: text("outcome"),
    failureCategory: text("failure_category"),
    resultMessageIds: text("result_message_ids").array().notNull().default([]),
  },
  (table) => [
    index("product_telemetry_runs_actor_thread_idx").on(
      table.actorUserId,
      table.threadId,
    ),
    index("product_telemetry_runs_accepted_idx").on(table.acceptedAt),
  ],
);

export const productTelemetryEvents = pgTable(
  "product_telemetry_events",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    properties: jsonb("properties").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    index("product_telemetry_events_pending_idx").on(
      table.attemptedAt,
      table.createdAt,
    ),
  ],
);
