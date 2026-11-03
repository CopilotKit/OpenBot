/**
 * Writing a record for Intelligence's audit trail or model usage: one row in `audit_outbox`.
 *
 * IN THE CALLER'S OWN TRANSACTION, WHERE THE OLD INSERT WAS. A caller that wrote its audit row inside
 * the transaction making the change (`proactive/store.ts`, `plugins/plugin-store/connections.ts`,
 * approvals, identity links) still does: the row commits or rolls back with the change, and nothing
 * here touches the network. The drainer (`drainer.ts`) carries it to Intelligence afterwards.
 *
 * The id is chosen here, at write time, and is the record's id in Intelligence, so however many times
 * the drainer sends it, it is one record.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import type { RecordKind } from "./client";

type Executor = Pick<Database, "execute">;

const written = new Set<() => void>();

/** Hear every outbox write in this process, to drain promptly. Returns the way to stop hearing. */
export function onOutboxWritten(listener: () => void): () => void {
  written.add(listener);
  return () => written.delete(listener);
}

function announce() {
  for (const listener of written) {
    try {
      listener();
    } catch {
      // A drainer's wake-up is an optimisation; its interval still runs.
    }
  }
}

/**
 * Write one record to the outbox. `computer`, for a `computer.*` audit event, also moves that
 * computer's last-activity bookmark forward in the same statement (see `computerActivity`).
 *
 * The record goes in as text and is cast, not as a value typed `jsonb`: handed a string for a `jsonb`
 * parameter, Bun's driver encodes it again and stores a JSON string rather than the object (the bug
 * `db/schema/json.ts` describes), which Intelligence then refuses.
 */
export async function writeOutbox(
  executor: Executor,
  kind: RecordKind,
  record: Record<string, unknown>,
  options: { computer?: string | null } = {},
): Promise<void> {
  const id = crypto.randomUUID();
  const computer = options.computer ?? null;
  await executor.execute(sql`
    with written as (
      insert into audit_outbox (kind, id, record)
      values (${kind}, ${id}::uuid, ${JSON.stringify(record)}::text::jsonb)
      returning occurred_at
    )
    insert into computer_activity (computer, last_active_at)
    select ${computer}::text, occurred_at from written where ${computer}::text is not null
    on conflict (computer) do update
      set last_active_at = greatest(computer_activity.last_active_at, excluded.last_active_at)
  `);
  announce();
}
