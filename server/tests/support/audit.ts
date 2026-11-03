// server/tests/support/audit.ts
//
// The audit trail for the tests, in a real Intelligence.
//
// The trail, action records and model usage live in Intelligence. The server writes each row to the
// local outbox in its own transaction and the drainer carries it there, so a test that wants to see
// what the code under test recorded flushes the outbox and reads Intelligence, the way the Admin
// page does. There is no stand-in: a fake trail that answered while the real one refused would be the
// test that lies.
//
// WHICH INTELLIGENCE: `TEST_INTELLIGENCE_API_URL` and `TEST_INTELLIGENCE_API_KEY` (see bots.ts).
// Missing, every test that touches the trail fails here and says so.
//
// FILTER BY SOMETHING UNIQUE. Intelligence's trail is append-only and every run of every file writes
// to the same project, so a test reads the rows it made by an id it made (a target, an actor, a run),
// never "everything of this type".
import { createAuditTrailClient } from "../../src/audit-trail/client";
import { createAuditDrainer } from "../../src/audit-trail/drainer";
import {
  type AuditTrail,
  installAuditTrail,
} from "../../src/audit-trail/trail";
import { createDatabase } from "../../src/db/client";
import { testIntelligence } from "./bots";
import { testDatabaseUrl } from "./database";

let installed: AuditTrail | undefined;

/**
 * The process's audit trail against the test Intelligence, installed so `createAuditReader`, the
 * enterprise store and the check-in store read it. Once per process. Its drainer is not started: a
 * test flushes when it reads, so nothing races the assertion.
 */
export function useTestAuditTrail(): AuditTrail {
  if (installed) return installed;
  const intelligence = testIntelligence();
  const client = createAuditTrailClient({
    apiUrl: intelligence.apiUrl,
    apiKey: intelligence.apiKey,
  });
  const database = createDatabase(testDatabaseUrl(), { max: 2 });
  installed = installAuditTrail({
    client,
    drainer: createAuditDrainer({ database, client }),
  });
  return installed;
}

/** Send everything in the outbox to Intelligence now. Throws when Intelligence will not take it. */
export async function flushAuditTrail(): Promise<void> {
  const { drainer } = useTestAuditTrail();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await drainer.flush({ waitMs: 15_000, budgetMs: 60_000 });
    if (!result.busy) return;
  }
  throw new Error("Another drainer held the audit outbox for too long.");
}

/** One audit row as the tests read it: the old `audit_events` row's shape, from Intelligence. */
export type AuditRow = {
  id: string;
  occurredAt: string;
  createdAt: Date;
  eventType: string;
  actorUserId: string | null;
  agentId: string | null;
  initiatorKind: string;
  initiatorId: string | null;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
};

export type AuditRowFilter = {
  eventType?: string | readonly string[];
  eventTypePrefix?: string;
  actorUserId?: string;
  agentId?: string;
  initiatorKind?: string | readonly string[];
  initiatorId?: string;
  targetType?: string;
  targetId?: string;
  /** Only rows after this moment (exclusive). */
  from?: Date | string;
};

const asSet = (value: string | readonly string[] | undefined) =>
  value === undefined ? undefined : typeof value === "string" ? [value] : value;

/**
 * Every row matching the filter, newest first, after flushing the outbox. Walks every page.
 *
 * At least one filter is required, so no test reads the whole shared trail by accident.
 */
export async function auditRows(filter: AuditRowFilter): Promise<AuditRow[]> {
  if (Object.values(filter).every((value) => value === undefined)) {
    throw new Error(
      "auditRows needs a filter: the trail is shared by every test run.",
    );
  }
  await flushAuditTrail();
  const { client } = useTestAuditTrail();
  const rows: AuditRow[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.events({
      limit: 500,
      ...(cursor ? { cursor } : {}),
      ...(filter.eventType ? { eventType: asSet(filter.eventType) } : {}),
      ...(filter.eventTypePrefix
        ? { eventTypePrefix: filter.eventTypePrefix }
        : {}),
      ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
      ...(filter.initiatorKind
        ? { initiatorKind: asSet(filter.initiatorKind) }
        : {}),
      ...(filter.initiatorId ? { initiatorId: filter.initiatorId } : {}),
      ...(filter.targetType ? { targetType: filter.targetType } : {}),
      ...(filter.targetId ? { targetId: filter.targetId } : {}),
      ...(filter.from ? { from: new Date(filter.from).toISOString() } : {}),
    });
    for (const event of page.events) {
      rows.push({
        id: event.id,
        occurredAt: event.occurredAt,
        createdAt: new Date(event.occurredAt.replace(/\.(\d{3})\d*Z$/, ".$1Z")),
        eventType: event.eventType,
        actorUserId: event.actorUserId,
        agentId: event.agentId,
        initiatorKind: event.initiator.kind,
        initiatorId: event.initiator.id,
        targetType: event.target.type,
        targetId: event.target.id,
        payload: event.payload,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

/** One row past the old shape: an event to put straight into Intelligence's trail. */
export type SeedAuditEvent = {
  id?: string;
  occurredAt?: Date | string;
  eventType: string;
  actorUserId?: string | null;
  /** The Bot that acted. Defaults to the payload's `bot`, as the audit store records it. */
  agentId?: string | null;
  initiatorKind?: string;
  initiatorId?: string | null;
  targetType: string;
  targetId?: string | null;
  payload?: Record<string, unknown>;
};

/**
 * Put events straight into Intelligence, with the moments a test needs (an hour ago, microseconds
 * apart), the way the upgrade copy does. Answers their ids, in the order given.
 */
export async function seedAuditEvents(
  events: readonly SeedAuditEvent[],
): Promise<string[]> {
  const { client } = useTestAuditTrail();
  const wire = events.map((event) => ({
    id: event.id ?? crypto.randomUUID(),
    occurredAt:
      typeof event.occurredAt === "string"
        ? event.occurredAt
        : (event.occurredAt ?? new Date()).toISOString(),
    eventType: event.eventType,
    actorUserId: event.actorUserId ?? null,
    agentId:
      event.agentId !== undefined
        ? event.agentId
        : typeof event.payload?.bot === "string"
          ? event.payload.bot
          : null,
    initiator: {
      kind: event.initiatorKind ?? "person",
      id: event.initiatorId ?? null,
    },
    target: { type: event.targetType, id: event.targetId ?? null },
    payload: event.payload ?? {},
  }));
  const stored = await client.store("event", wire);
  if (stored !== wire.length) {
    throw new Error(`Intelligence stored ${stored} of ${wire.length} events.`);
  }
  return wire.map((event) => event.id);
}

/** Action records for one Bot, newest first, from Intelligence after a flush. */
export async function actionRows(agentId: string) {
  await flushAuditTrail();
  const { client } = useTestAuditTrail();
  const rows: Awaited<ReturnType<typeof client.actions>>["actions"] = [];
  let cursor: string | null = null;
  do {
    const page = await client.actions({
      limit: 500,
      agentId,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.actions);
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

/** Model usage for one Bot, newest first, from Intelligence after a flush. */
export async function modelUsageRows(agentId: string) {
  await flushAuditTrail();
  const { client } = useTestAuditTrail();
  const rows: Awaited<ReturnType<typeof client.usage>>["records"] = [];
  let cursor: string | null = null;
  do {
    const page = await client.usage({
      limit: 500,
      agentId,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}
