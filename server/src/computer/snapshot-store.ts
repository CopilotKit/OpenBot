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
import { eq, lt, ne, or, sql } from "drizzle-orm";
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
  /**
   * Which run of the computer took it, when the provider can say.
   *
   * The generation only orders snapshots within one session. This is what tells two sessions apart,
   * so a ref from a computer that has since been replaced resolves to nothing instead of to whatever
   * now holds that ref. Undefined only where the provider could not be asked at all, which leaves the
   * behaviour as it was: a null on either side skips the comparison, so a row written during an
   * outage stays unordered against the runs around it.
   */
  session?: string;
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
        session: snapshot.session ?? null,
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
            session: values.session,
          },
          // Only ever forward. The generation is stamped by the computer and increases by one per
          // snapshot, so a lower number is an older page. Two replicas snapshotting the same computer
          // at once is the case this exists for: without the guard, whichever write reached Postgres
          // last would win, so the older snapshot could overwrite the newer one and every ref the
          // model is holding would stop resolving. Timestamps cannot decide it, because they come
          // from two machines' clocks; the generation comes from one.
          /*
           * Forward within a session, and always across one.
           *
           * The generation guard is right while the computer is the same computer. It is wrong the
           * moment it is replaced: the new session counts from one, so every snapshot it takes looks
           * older than the dead row and none of them land. The row then describes a page nobody is
           * on until the counter climbs back past it, and the one that finally matches resolves refs
           * against the dead page.
           *
           * A different session is therefore not a stale write to be refused. It is the only write
           * that can be right.
           */
          setWhere: or(
            lt(computerSnapshot.snapshotId, values.snapshotId),
            values.session === null
              ? sql`${computerSnapshot.session} is not null`
              : or(
                  sql`${computerSnapshot.session} is null`,
                  ne(computerSnapshot.session, values.session),
                ),
          ),
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
        ...(row.session ? { session: row.session } : {}),
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
      // Only ever forward, the same rule the table's `setWhere` applies, because the two stores have
      // to agree about when a save wins. Two snapshots of one computer can complete out of order in a
      // single process as easily as across two, and a test that reaches for this store because it has
      // no database would otherwise be told a different story about what the gateway resolves
      // against: the older page here, the newer one in a deployment.
      const held = snapshots.get(computerId);
      // Same rule as the table: forward within a session, and always across one. A replaced computer
      // counts from one again, so refusing its snapshots for being "older" leaves the dead page in
      // place until the counter climbs back past it.
      const sameSession = held?.session === snapshot.session;
      if (held && sameSession && held.snapshotId >= snapshot.snapshotId) return;
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
