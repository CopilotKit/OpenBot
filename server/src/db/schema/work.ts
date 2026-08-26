import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Durable work, claimed by whichever replica gets there first, leased so a dead one's work comes
 * back.
 *
 * ONE MECHANISM, THREE FEATURES. Suspending idle computers needs it, scheduled routines need it, and
 * a hop from one Bot to another needs it. Written once with all three in view rather than three
 * times slightly differently, because the parts that are easy to get wrong are the same every time:
 * who owns an item, what happens when the owner dies, and whether a recovery can run something
 * twice.
 *
 * POSTGRES, NOT A QUEUE. It is already the thing every replica shares, and `for update skip locked`
 * is exactly this problem: each replica takes rows nobody else holds, no coordinator, no leader
 * election, no single point of failure, and adding a replica adds throughput rather than contention.
 *
 * NOT `setInterval`. The audit-retention sweep uses one and is safe only because deleting old rows
 * twice is the same as deleting them once. Anything that spends money, calls a tool or posts a
 * message is not that: fired by every replica it happens N times, and on a cluster that is Tuesday.
 */
export const workItems = pgTable(
  "work_items",
  {
    /** What kind of work. `computer.suspend` today; routines and bot-to-bot hops later. */
    kind: text("kind").notNull(),
    /**
     * What the work is about, unique within its kind.
     *
     * The Bot id for a computer to suspend, and for a routine the routine and the minute it was due,
     * because IDEMPOTENCE LIVES HERE. A routine due at 07:00 must run once even if three replicas
     * wake together and a lease is reclaimed mid-flight; making the key carry the scheduled time is
     * what turns "fire it again" into "insert that already exists" rather than a second run. Without
     * it every recovery path is also a duplicate-run path.
     */
    key: text("key").notNull(),
    /** When this becomes eligible. A claim never sees an item before its time. */
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Which replica holds it, and until when.
     *
     * Null owner means nobody has it. A lease in the past means whoever had it stopped renewing, and
     * the row is free again: that is the whole recovery story, and it needs no process to notice a
     * death, only the next claim to look at the clock.
     */
    claimedBy: text("claimed_by"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /**
     * How many times this has been handed out.
     *
     * A RECLAIMED ITEM IS NOT A FRESH ONE, and the difference matters enough to count rather than
     * infer. An item on its first attempt has certainly not run; one on its second may already have
     * called a tool and spent money before its owner died. Whatever picks it up has to be able to
     * tell those apart, so it is a number here rather than a state folded into failure.
     */
    attempts: integer("attempts").notNull().default(0),
    /**
     * When it was done, or null while it still wants doing.
     *
     * KEPT RATHER THAN DELETED, because the idempotence this table promises has to survive
     * completion. Finishing used to remove the row, so a routine due at 07:00 that ran and finished
     * was re-offered cleanly by the next replica to wake late and ran a second time: the insert that
     * was supposed to collide had nothing left to collide with. A finished row is the collision.
     *
     * Swept on a retention window rather than kept forever, because a queue is not an archive.
     */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * Why the last attempt gave up.
     *
     * An item that has run out of attempts stops being handed out and stays here with its count and
     * its reason. That is the terminal state: visible in the table somebody can query rather than a
     * row that quietly retries until the end of time.
     */
    lastError: text("last_error"),
    /** Anything the work needs that is not in the key. */
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.key] }),
    // The claim's own query: due, unclaimed or expired, not yet finished, oldest first.
    index("work_items_claimable_idx").on(table.kind, table.runAt),
  ],
);
