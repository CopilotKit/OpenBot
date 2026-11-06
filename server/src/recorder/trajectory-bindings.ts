import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { recorderTrajectoryBindings } from "../db/schema/recorder";

/** A cursor that does not decode, or names a time the database cannot hold. */
export class InvalidCursorError extends RangeError {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidCursorError";
  }
}

/**
 * Which person each Recorder trajectory belongs to. The first capture pass for a trajectory binds it to the person whose
 * browser asked; a later pass for it must come from the same person. Nothing recorded is kept: the trajectory lives in
 * Intelligence, in that person's own Learning space.
 */
export function createTrajectoryBindingStore(database: Database) {
  /** Whether this trajectory is bound to this person. */
  const isBoundTo = async (
    trajectoryId: string,
    userId: string,
  ): Promise<boolean> => {
    const [bound] = await database
      .select({ userId: recorderTrajectoryBindings.userId })
      .from(recorderTrajectoryBindings)
      .where(
        and(
          eq(recorderTrajectoryBindings.trajectoryId, trajectoryId),
          eq(recorderTrajectoryBindings.userId, userId),
        ),
      )
      .limit(1);
    return bound !== undefined;
  };

  return {
    /** Which of these trajectories are bound to this person, in one query. Ids must be UUIDs (the column is one). */
    async boundTo(
      userId: string,
      trajectoryIds: string[],
    ): Promise<Set<string>> {
      if (trajectoryIds.length === 0) return new Set();
      const rows = await database
        .select({ trajectoryId: recorderTrajectoryBindings.trajectoryId })
        .from(recorderTrajectoryBindings)
        .where(
          and(
            eq(recorderTrajectoryBindings.userId, userId),
            inArray(recorderTrajectoryBindings.trajectoryId, trajectoryIds),
          ),
        );
      return new Set(rows.map((row) => row.trajectoryId));
    },
    /**
     * One page of this person's trajectories, newest first. Postgres keeps microseconds and a JS Date milliseconds, so
     * the order and the cursor both use the time cut to milliseconds: a cursor never skips or repeats a row.
     * Throws an InvalidCursorError (a RangeError) for a cursor that does not decode.
     */
    async pageForUser(
      userId: string,
      cursor: string | null,
      limit = 50,
    ): Promise<{
      ids: { trajectoryId: string; createdAt: Date }[];
      nextCursor: string | null;
    }> {
      const created = sql`date_trunc('milliseconds', ${recorderTrajectoryBindings.createdAt})`;
      const after = cursor === null ? undefined : decodeCursor(cursor);
      const rows = await database
        .select({
          trajectoryId: recorderTrajectoryBindings.trajectoryId,
          createdAt: sql<Date>`${created}`.mapWith(
            recorderTrajectoryBindings.createdAt,
          ),
        })
        .from(recorderTrajectoryBindings)
        .where(
          and(
            eq(recorderTrajectoryBindings.userId, userId),
            after &&
              sql`(${created}, ${recorderTrajectoryBindings.trajectoryId}) < (${after.createdAt.toISOString()}::timestamptz, ${after.trajectoryId}::uuid)`,
          ),
        )
        .orderBy(desc(created), desc(recorderTrajectoryBindings.trajectoryId))
        .limit(limit + 1);
      const ids = rows.slice(0, limit);
      const last = ids[ids.length - 1];
      return {
        ids,
        nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      };
    },
    /**
     * Binds the trajectory to this person, or finds it already bound to them. False when it is bound to anyone else.
     * `trajectoryId` must already be a UUID (the column is one).
     */
    async bind(input: {
      trajectoryId: string;
      userId: string;
    }): Promise<boolean> {
      const [inserted] = await database
        .insert(recorderTrajectoryBindings)
        .values(input)
        .onConflictDoNothing({
          target: recorderTrajectoryBindings.trajectoryId,
        })
        .returning({ trajectoryId: recorderTrajectoryBindings.trajectoryId });
      if (inserted) return true;
      return isBoundTo(input.trajectoryId, input.userId);
    },
    isBoundTo,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(row: { trajectoryId: string; createdAt: Date }): string {
  return Buffer.from(
    `${row.createdAt.toISOString()}|${row.trajectoryId}`,
  ).toString("base64url");
}

function decodeCursor(cursor: string): {
  createdAt: Date;
  trajectoryId: string;
} {
  const [iso, trajectoryId, ...rest] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  const createdAt = new Date(iso ?? "");
  if (
    rest.length > 0 ||
    Number.isNaN(createdAt.getTime()) ||
    // Postgres holds years 0001-9999 in this format; a wider year is a valid Date but fails the cast.
    createdAt.getUTCFullYear() < 1 ||
    createdAt.getUTCFullYear() > 9999 ||
    trajectoryId === undefined ||
    !UUID.test(trajectoryId)
  ) {
    throw new InvalidCursorError();
  }
  return { createdAt, trajectoryId };
}
