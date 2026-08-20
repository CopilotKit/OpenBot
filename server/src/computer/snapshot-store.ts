/**
 * Where the gateway keeps the snapshot it resolves refs against.
 *
 * A ref an acting call carries is opaque, and the gateway turns it into the element it points at by
 * looking it up in the snapshot this server took. That lookup is the whole security model: a rule
 * that says "never click Submit" is only worth anything if the server, not the caller, decides what
 * a ref is. See the header of gateway.ts.
 *
 * It cannot be a `Map` in the process. OpenBot is several server processes behind a load balancer,
 * and the process that answered the snapshot is rarely the one that answers the click that uses its
 * refs. Held in memory, the mapping is missing on every other replica: the ref resolves to nothing,
 * the policy decides with no element in front of it, and the audit row cannot say what was acted on.
 * The boundary silently stops applying, which is the failure the pull request template is written to
 * catch and the one #21 flagged this cache as still having.
 *
 * So it goes through Postgres, like channel activity and the policy before it. The table holds one
 * live snapshot per computer, replaced whenever a newer one is taken.
 *
 * Staleness, the reason a persisted snapshot cache is rightly regarded with suspicion, is answered by
 * the generation the far-side computer stamps on every snapshot: `resolve` only accepts a ref whose
 * generation matches the stored one, so a ref from a superseded page resolves to nothing rather than
 * to whatever now holds that ref. The refs cannot "resolve to names that are no longer on screen"
 * because a ref from an old screen no longer matches. The computer itself makes the same generation
 * check when the action reaches it; this keeps the policy decision and the audit row honest in the
 * meantime, on whichever replica the action lands.
 *
 * Without a database it stays in memory. Tests that only exercise decision logic do not need
 * Postgres, exactly as the policy store does not.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { computerSnapshot } from "../db/schema";
import type { SnapshotElement } from "./schema";

/**
 * A snapshot as the gateway holds it: the generation, the page, and the elements keyed by ref.
 *
 * The elements are a `Map` here because a resolve is a single ref lookup; the table stores the same
 * thing as a JSON object keyed by ref, and the two conversions live in `save` and `load`.
 */
export type StoredSnapshot = {
  snapshotId: number;
  url: string;
  elements: Map<string, SnapshotElement>;
};

export type SnapshotStore = {
  /**
   * Record the snapshot a computer just produced, replacing any earlier one.
   *
   * Awaited on the snapshot path, which is already a round trip to the computer, so the row is on
   * record before the refs it describes are handed to the model and can come back on another replica.
   */
  save: (computerId: string, snapshot: StoredSnapshot) => Promise<void>;
  /** The live snapshot for a computer, or undefined when none has been taken. */
  load: (computerId: string) => Promise<StoredSnapshot | undefined>;
  /**
   * Forget a computer's snapshot, because the page it described is gone.
   *
   * Called when a computer is wiped. Leaving the row would be worse than leaving a stale `Map` was:
   * a fresh computer counts generations from one again, so a ref the model still holds from the
   * previous session's first snapshot would match the row a reset left behind, and the policy would
   * decide against an element from a page that no longer exists. The generation check only tells
   * snapshots apart within one session, so the row has to go when the session does.
   */
  clear: (computerId: string) => Promise<void>;
};

/**
 * The store the gateway uses in a real deployment, or an in-memory one when there is no database.
 *
 * The two behave the same within one process. The difference is only visible with a second one: the
 * memory store cannot be read from another replica, which is precisely why a deployment passes the
 * database-backed one and a single-process test does not have to.
 */
export function createSnapshotStore(database?: Database): SnapshotStore {
  if (!database) return createInMemorySnapshotStore();

  return {
    save: async (computerId, snapshot) => {
      const elements = objectFromElements(snapshot.elements);
      const values = {
        computerId,
        snapshotId: snapshot.snapshotId,
        url: snapshot.url,
        elements,
        takenAt: new Date(),
      };
      await database
        .insert(computerSnapshot)
        .values(values)
        // One row per computer. A newer snapshot supersedes the last, because a ref is only ever
        // resolved against the current one; keeping the old rows would be a page history the boundary
        // has no use for.
        .onConflictDoUpdate({
          target: computerSnapshot.computerId,
          set: {
            snapshotId: values.snapshotId,
            url: values.url,
            elements: values.elements,
            takenAt: values.takenAt,
          },
        });
    },

    clear: async (computerId) => {
      await database
        .delete(computerSnapshot)
        .where(eq(computerSnapshot.computerId, computerId));
    },

    load: async (computerId) => {
      const [row] = await database
        .select()
        .from(computerSnapshot)
        .where(eq(computerSnapshot.computerId, computerId))
        .limit(1);
      if (!row) return undefined;
      return {
        snapshotId: row.snapshotId,
        url: row.url,
        elements: elementsFromObject(
          row.elements as Record<string, SnapshotElement>,
        ),
      };
    },
  };
}

/**
 * A snapshot store that lives in one process.
 *
 * The gateway's default when a deployment does not pass a database, and what its unit tests use. It
 * is not a fallback anybody should reach for in production: with a second replica it is the exact
 * bug the database-backed store exists to fix.
 */
export function createInMemorySnapshotStore(): SnapshotStore {
  const snapshots = new Map<string, StoredSnapshot>();
  return {
    save: async (computerId, snapshot) => {
      snapshots.set(computerId, snapshot);
    },
    load: async (computerId) => snapshots.get(computerId),
    clear: async (computerId) => {
      snapshots.delete(computerId);
    },
  };
}

function objectFromElements(
  elements: Map<string, SnapshotElement>,
): Record<string, SnapshotElement> {
  const object: Record<string, SnapshotElement> = {};
  for (const [ref, element] of elements) object[ref] = element;
  return object;
}

function elementsFromObject(
  object: Record<string, SnapshotElement>,
): Map<string, SnapshotElement> {
  return new Map(Object.entries(object));
}
