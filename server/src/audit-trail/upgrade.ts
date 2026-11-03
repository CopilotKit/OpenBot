/**
 * Moving an existing deployment's audit trail, action records and model usage into Intelligence, once.
 *
 * A deployment that ran before this release holds them in `audit_events`, `action_records` and
 * `model_usage`. This copies every row into Intelligence with the id and timestamp it had, through the
 * same batch endpoints the drainer uses, then checks the count, and only then records the copy in
 * `intelligence_copies` so it never runs again. The tables stay, unwritten, for this release.
 *
 * IN THE BACKGROUND, NEVER IN THE WAY. The trail can be millions of rows, so the server starts without
 * waiting for it. It walks each table in `(created_at, id)` order and records where it got to
 * (`intelligence_copy_progress`) after every batch Intelligence stored, so a restart resumes rather
 * than starting over.
 *
 * SAFE FROM ANY NUMBER OF REPLICAS. One copies each table at a time, under a named lock in
 * `local_locks` renewed after every batch; another finds it held and tries again later. Even two that
 * overlapped would store each row once: Intelligence keys every record by the id it already had.
 *
 * VERIFIED BY COUNT, LOUD ON A MISMATCH. Intelligence answers each batch with how many of its ids it
 * now holds. The copy is recorded only when the sum equals the table's row count. Short, it walks the
 * table again from the start once (resending is harmless), and still short it says so with the ids
 * Intelligence refused, does not record itself, and tries again at the next boot.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { intelligenceCopies, intelligenceCopyProgress } from "../db/schema";
import {
  extendLocalLock,
  releaseLocalLock,
  tryLocalLock,
} from "../work/local-lock";
import {
  type AuditTrailClient,
  AuditTrailClientError,
  type RecordKind,
} from "./client";

type CopiedTable = {
  /** The local table, and the name the copy is recorded under. */
  table: "audit_events" | "action_records" | "model_usage";
  kind: RecordKind;
  /** The columns, selected as the record Intelligence takes. Constant SQL, never input. */
  columns: string;
};

const MICROS = `to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const AUDIT_COPIES: readonly CopiedTable[] = [
  {
    table: "audit_events",
    kind: "event",
    columns: `json_build_object(
      'id', id::text,
      'occurredAt', ${MICROS},
      'eventType', event_type,
      'actorUserId', nullif(actor_user_id, ''),
      'initiator', json_build_object('kind', initiator_kind, 'id', nullif(initiator_id, '')),
      'target', json_build_object('type', target_type, 'id', nullif(target_id, '')),
      'payload', payload
    )`,
  },
  {
    table: "action_records",
    kind: "action",
    columns: `json_build_object(
      'id', id::text,
      'occurredAt', ${MICROS},
      'surface', surface,
      'agentId', nullif(bot_id, ''),
      'actorUserId', nullif(actor_user_id, ''),
      'toolName', tool_name,
      'command', command,
      'outcome', outcome
    )`,
  },
  {
    table: "model_usage",
    kind: "usage",
    columns: `json_build_object(
      'id', id::text,
      'occurredAt', ${MICROS},
      'userId', nullif(user_id, ''),
      'agentId', agent_id,
      'threadId', nullif(thread_id, ''),
      'runId', nullif(run_id, ''),
      'model', model,
      'source', source,
      'allowed', allowed
    )`,
  },
];

const BATCH = 500;
const LOCK_TTL_MS = 60_000;

export type TableCopyOutcome =
  | { kind: "done-before" }
  | { kind: "busy" }
  | { kind: "copied"; local: number; stored: number }
  | { kind: "short"; local: number; stored: number; refused: string[] };

export class AuditCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditCopyMismatchError";
  }
}

type Row = { createdAt: string; id: string; record: Record<string, unknown> };

function rowsOf(result: unknown): Row[] {
  const rows = (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Row[];
  // A `json` column may come back as its text, depending on the driver.
  return rows.map((row) =>
    typeof row.record === "string"
      ? { ...row, record: JSON.parse(row.record) as Record<string, unknown> }
      : row,
  );
}

/**
 * Send rows Intelligence may refuse one of: a refused batch is split until each refused row is alone,
 * and those are returned rather than retried.
 */
async function store(
  client: Pick<AuditTrailClient, "store">,
  kind: RecordKind,
  rows: Row[],
): Promise<{ stored: number; refused: string[] }> {
  try {
    return {
      stored: await client.store(
        kind,
        rows.map((row) => row.record) as unknown as Parameters<
          AuditTrailClient["store"]
        >[1],
      ),
      refused: [],
    };
  } catch (error) {
    if (!(error instanceof AuditTrailClientError) || !error.refused)
      throw error;
    if (rows.length === 1)
      return {
        stored: 0,
        refused: [`${rows[0]?.id}: ${error.message}`],
      };
    const half = Math.ceil(rows.length / 2);
    const first = await store(client, kind, rows.slice(0, half));
    const second = await store(client, kind, rows.slice(half));
    return {
      stored: first.stored + second.stored,
      refused: [...first.refused, ...second.refused],
    };
  }
}

async function walk(
  database: Database,
  client: Pick<AuditTrailClient, "store">,
  copy: CopiedTable,
  holder: string,
  batchSize: number,
): Promise<{ stored: number; refused: string[] }> {
  const lockName = `intelligence-copy:${copy.table}`;
  const refused: string[] = [];
  for (;;) {
    const [progress] = await database
      .select({
        afterCreatedAt: sql<
          string | null
        >`to_char(${intelligenceCopyProgress.afterCreatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        afterId: sql<string | null>`${intelligenceCopyProgress.afterId}::text`,
        copied: intelligenceCopyProgress.copied,
      })
      .from(intelligenceCopyProgress)
      .where(eq(intelligenceCopyProgress.name, copy.table));
    const after =
      progress?.afterCreatedAt && progress.afterId
        ? sql`where (created_at, id) > (${progress.afterCreatedAt}::timestamptz, ${progress.afterId}::uuid)`
        : sql``;
    const rows = rowsOf(
      await database.execute(sql`
        select ${sql.raw(MICROS)} as "createdAt", id::text as id, ${sql.raw(copy.columns)} as record
        from ${sql.raw(copy.table)} ${after}
        order by created_at, id
        limit ${batchSize}
      `),
    );
    const last = rows.at(-1);
    if (!last) return { stored: progress?.copied ?? 0, refused };
    const sent = await store(client, copy.kind, rows);
    refused.push(...sent.refused);
    await database
      .insert(intelligenceCopyProgress)
      .values({
        name: copy.table,
        afterCreatedAt: last.createdAt,
        afterId: last.id,
        copied: sent.stored,
      })
      .onConflictDoUpdate({
        target: intelligenceCopyProgress.name,
        set: {
          afterCreatedAt: last.createdAt,
          afterId: last.id,
          copied: sql`${intelligenceCopyProgress.copied} + ${sent.stored}`,
          updatedAt: new Date(),
        },
      });
    if (!(await extendLocalLock(database, lockName, holder, LOCK_TTL_MS))) {
      throw new Error(
        `The lock on copying ${copy.table} passed to another server mid-copy; it carries on from the bookmark.`,
      );
    }
  }
}

/** Copy one table, unless it is done or another replica holds it. */
export async function copyAuditTable(
  database: Database,
  client: Pick<AuditTrailClient, "store">,
  copy: CopiedTable,
  options: { batchSize?: number } = {},
): Promise<TableCopyOutcome> {
  const batchSize = options.batchSize ?? BATCH;
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, copy.table))
    .limit(1);
  if (done) return { kind: "done-before" };

  const lockName = `intelligence-copy:${copy.table}`;
  const holder = crypto.randomUUID();
  if (!(await tryLocalLock(database, lockName, holder, LOCK_TTL_MS)))
    return { kind: "busy" };
  try {
    let pass = await walk(database, client, copy, holder, batchSize);
    let local = await countRows(database, copy.table);
    if (pass.stored !== local && pass.stored + pass.refused.length !== local) {
      // Not explained by refusals: rows changed under an earlier walk, or a bookmark outlived its
      // rows. Walk again from the start; resending is harmless.
      await database
        .delete(intelligenceCopyProgress)
        .where(eq(intelligenceCopyProgress.name, copy.table));
      pass = await walk(database, client, copy, holder, batchSize);
      local = await countRows(database, copy.table);
    }
    if (pass.stored !== local) {
      console.error(
        JSON.stringify({
          type: "audit-copy-short",
          note: "Not every row of this table is in Intelligence, so the copy is not recorded as done and runs again at the next start. Rows Intelligence refused are listed.",
          table: copy.table,
          local,
          stored: pass.stored,
          refused: pass.refused.slice(0, 50),
        }),
      );
      return {
        kind: "short",
        local,
        stored: pass.stored,
        refused: pass.refused,
      };
    }
    await database
      .insert(intelligenceCopies)
      .values({ name: copy.table, copied: local })
      .onConflictDoNothing();
    console.info(
      JSON.stringify({
        type: "audit-copied-to-intelligence",
        table: copy.table,
        local,
        stored: pass.stored,
      }),
    );
    return { kind: "copied", local, stored: pass.stored };
  } finally {
    await releaseLocalLock(database, lockName, holder).catch(() => undefined);
  }
}

async function countRows(database: Database, table: string): Promise<number> {
  const [row] = rowsOf(
    await database.execute(
      sql`select count(*)::int as n from ${sql.raw(table)}`,
    ),
  ) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

/** Copy every table that is not done. Answers each table's outcome. */
export async function copyAuditHistory(
  database: Database,
  client: Pick<AuditTrailClient, "store">,
): Promise<Record<CopiedTable["table"], TableCopyOutcome>> {
  const outcomes = {} as Record<CopiedTable["table"], TableCopyOutcome>;
  for (const copy of AUDIT_COPIES) {
    outcomes[copy.table] = await copyAuditTable(database, client, copy);
  }
  return outcomes;
}

/**
 * The copy, in the background: now, and again every `retryMs` while a table is held by another
 * replica or the copy failed, until every table is done or short. Never throws into the caller.
 */
export function startAuditHistoryCopy(
  database: Database,
  client: Pick<AuditTrailClient, "store">,
  options: { retryMs?: number } = {},
): { stop: () => void; finished: Promise<void> } {
  const retryMs = options.retryMs ?? 60_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run = () => {
    if (stopped) return finish();
    copyAuditHistory(database, client)
      .then((outcomes) => {
        if (Object.values(outcomes).some((outcome) => outcome.kind === "busy"))
          return retry();
        finish();
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            type: "audit-copy-failed",
            note: "Copying this deployment's earlier audit trail into Intelligence stopped; it resumes from where it got to.",
            error: error instanceof Error ? error.message : String(error),
            retryInMs: retryMs,
          }),
        );
        retry();
      });
  };
  const retry = () => {
    if (stopped) return finish();
    timer = setTimeout(run, retryMs);
    timer.unref?.();
  };
  run();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      finish();
    },
    finished,
  };
}
