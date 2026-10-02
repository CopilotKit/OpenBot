import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { HeadlessWaiting } from "../../computer/headless-tools";
import type {
  TriggerConfig,
  TriggerKind,
} from "../../responsibilities/triggers";
import type {
  ResponsibilityContinuation,
  ResponsibilitySource,
  ResponsibilitySubscription,
} from "../../responsibilities/types";
import { agents, credentials, users } from "./core";
import { jsonb } from "./json";

export const responsibilityStatus = pgEnum("responsibility_status", [
  "active",
  "paused",
  "completed",
]);
export const responsibilityRunStatus = pgEnum("responsibility_run_status", [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
]);
export const responsibilities = pgTable(
  "responsibilities",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id").notNull(),
    title: text("title").notNull(),
    instruction: text("instruction").notNull(),
    successCriteria: text("success_criteria").notNull(),
    status: responsibilityStatus("status").notNull().default("active"),
    progress: text("progress").notNull().default(""),
    lastResult: text("last_result"),
    subscriptions: jsonb("subscriptions")
      .$type<ResponsibilitySubscription[]>()
      .notNull()
      .default([]),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("responsibilities_owner_status_idx").on(
      table.ownerUserId,
      table.status,
    ),
  ],
);

export const responsibilityEvents = pgTable(
  "responsibility_events",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").$type<ResponsibilitySource>().notNull(),
    externalId: text("external_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("responsibility_events_source_id_idx").on(
      table.ownerUserId,
      table.source,
      table.externalId,
    ),
  ],
);

export const responsibilityRuns = pgTable(
  "responsibility_runs",
  {
    id: text("id").primaryKey(),
    responsibilityId: text("responsibility_id")
      .notNull()
      .references(() => responsibilities.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => responsibilityEvents.id, { onDelete: "cascade" }),
    status: responsibilityRunStatus("status").notNull().default("queued"),
    replyText: text("reply_text"),
    error: text("error"),
    waiting: jsonb("waiting").$type<HeadlessWaiting>(),
    continuation: jsonb("continuation").$type<ResponsibilityContinuation>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("responsibility_runs_event_idx").on(
      table.responsibilityId,
      table.eventId,
    ),
    index("responsibility_runs_status_idx").on(table.status, table.createdAt),
  ],
);

export const responsibilitySourceBindings = pgTable(
  "responsibility_source_bindings",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").$type<"github">().notNull(),
    repository: text("repository").notNull(),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => credentials.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("responsibility_source_bindings_owner_idx").on(table.ownerUserId),
  ],
);

/**
 * One authenticated way for events to reach one responsibility: a generic webhook, a provider
 * webhook (GitHub, Linear, Sentry, PagerDuty), an inbound email address, or a Slack listener.
 *
 * The id is the unguessable path segment (and email local part) the sender addresses. The signing
 * or bearer secret lives in the encrypted credential vault; `credentialId` is null until a provider
 * secret has been pasted (Linear, Sentry and PagerDuty generate theirs after the URL exists) and for
 * kinds that authenticate another way (email: SNS signatures; Slack: the pairing's own signature).
 */
export const responsibilityTriggers = pgTable(
  "responsibility_triggers",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    responsibilityId: text("responsibility_id")
      .notNull()
      .references(() => responsibilities.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TriggerKind>().notNull(),
    config: jsonb("config").$type<TriggerConfig>().notNull(),
    credentialId: uuid("credential_id").references(() => credentials.id),
    /** Paused triggers acknowledge deliveries but never queue a run. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("responsibility_triggers_owner_idx").on(table.ownerUserId),
    index("responsibility_triggers_responsibility_idx").on(
      table.responsibilityId,
    ),
    index("responsibility_triggers_kind_idx").on(table.kind),
  ],
);
