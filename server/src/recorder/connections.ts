import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type ConnectCodeResponse,
  RECORDER_CODE_PREFIX,
  RECORDER_CONNECT_CODE_TTL_MS,
  RECORDER_TOKEN_PREFIX,
  type RecorderActivity,
  type RecorderConnection,
  type RecorderConnectVia,
} from "@openbot/shared/recorder-api";
import { and, asc, count, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  recorderConnectCodes,
  recorderConnections,
} from "../db/schema/recorder";

/** A live connection's last use is written at most this often. */
const LAST_USED_INTERVAL_MS = 60_000;
/** Unexpired connect codes one person may hold at once. A person mints one per click, so more than this is a script. */
const LIVE_CODES_PER_PERSON = 10;

export type RecorderConnectionStore = ReturnType<
  typeof createRecorderConnectionStore
>;

/** A live connection with what its Recorder last said it was doing, and when that arrived; both null until it has said. */
export type ReportingConnection = RecorderConnection & {
  activity: RecorderActivity | null;
  activityAt: Date | null;
};

const digest = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
const secretWithPrefix = (prefix: string) =>
  `${prefix}${randomBytes(32).toString("base64url")}`;

type ConnectionRow = typeof recorderConnections.$inferSelect;
function connectionView(row: ConnectionRow): RecorderConnection {
  return {
    id: row.id,
    label: row.label,
    via: row.via,
    extensionId: row.extensionId,
    installId: row.installId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

export function createRecorderConnectionStore(
  database: Database,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  return {
    /** Null when this person already holds {@link LIVE_CODES_PER_PERSON} unexpired codes. Every expired code, and the
     * sealed organization session it held, is deleted first. */
    async mintCode(
      userId: string,
      via: RecorderConnectVia,
      organizationSession: string | null = null,
    ): Promise<ConnectCodeResponse | null> {
      const created = now();
      await database
        .delete(recorderConnectCodes)
        .where(lte(recorderConnectCodes.expiresAt, created));
      const [live] = await database
        .select({ codes: count() })
        .from(recorderConnectCodes)
        .where(eq(recorderConnectCodes.userId, userId));
      if ((live?.codes ?? 0) >= LIVE_CODES_PER_PERSON) return null;
      const code = secretWithPrefix(RECORDER_CODE_PREFIX);
      const expiresAt = new Date(
        created.getTime() + RECORDER_CONNECT_CODE_TTL_MS,
      );
      await database.insert(recorderConnectCodes).values({
        codeHash: digest(code),
        userId,
        via,
        organizationSession,
        createdAt: created,
        expiresAt,
      });
      return { code, expiresAt: expiresAt.toISOString() };
    },

    /** Consumes the code atomically (it is deleted, with the sealed organization session it held) and, in the same
     * transaction, revokes this person's older live connection with the same `installId` (the same copy connecting again,
     * Decision 18). Null when the code is unknown, expired or already used. */
    async exchange(input: {
      code: string;
      label: string;
      extensionId: string;
      installId: string;
    }) {
      const at = now();
      return database.transaction(async (transaction) => {
        const [consumed] = await transaction
          .delete(recorderConnectCodes)
          .where(
            and(
              eq(recorderConnectCodes.codeHash, digest(input.code)),
              gt(recorderConnectCodes.expiresAt, at),
            ),
          )
          .returning();
        if (!consumed) return null;
        const [replaced] = await transaction
          .update(recorderConnections)
          .set({ revokedAt: at, organizationSession: null })
          .where(
            and(
              eq(recorderConnections.userId, consumed.userId),
              eq(recorderConnections.installId, input.installId),
              isNull(recorderConnections.revokedAt),
            ),
          )
          .returning({ id: recorderConnections.id });
        const token = secretWithPrefix(RECORDER_TOKEN_PREFIX);
        const [connection] = await transaction
          .insert(recorderConnections)
          .values({
            id: randomUUID(),
            userId: consumed.userId,
            tokenHash: digest(token),
            label: input.label,
            via: consumed.via,
            extensionId: input.extensionId,
            installId: input.installId,
            organizationSession: consumed.organizationSession,
            createdAt: at,
          })
          .returning();
        if (!connection) throw new Error("The connection was not stored.");
        return {
          token,
          connection: connectionView(connection),
          userId: consumed.userId,
          replaced: replaced?.id ?? null,
        };
      });
    },

    /** Live connections only, oldest first. */
    async list(userId: string): Promise<RecorderConnection[]> {
      const rows = await database
        .select()
        .from(recorderConnections)
        .where(
          and(
            eq(recorderConnections.userId, userId),
            isNull(recorderConnections.revokedAt),
          ),
        )
        .orderBy(asc(recorderConnections.createdAt));
      return rows.map(connectionView);
    },

    /**
     * This person's live connections, oldest first, each with what its Recorder last said it was doing: in one query, for
     * the Browser button, which asks every few seconds.
     */
    async reporting(userId: string): Promise<ReportingConnection[]> {
      const rows = await database
        .select()
        .from(recorderConnections)
        .where(
          and(
            eq(recorderConnections.userId, userId),
            isNull(recorderConnections.revokedAt),
          ),
        )
        .orderBy(asc(recorderConnections.createdAt));
      return rows.map((row) => ({
        ...connectionView(row),
        activity: row.activity,
        activityAt: row.activityAt,
      }));
    },

    /**
     * Keeps what a live connection's Recorder says it is doing now, in place of what it said before, with when it
     * arrived. False when the connection is not this person's live one: revoked since its token was read, say.
     */
    async reportActivity(
      userId: string,
      connectionId: string,
      activity: RecorderActivity,
    ): Promise<boolean> {
      const reported = await database
        .update(recorderConnections)
        .set({ activity, activityAt: now() })
        .where(
          and(
            eq(recorderConnections.id, connectionId),
            eq(recorderConnections.userId, userId),
            isNull(recorderConnections.revokedAt),
          ),
        )
        .returning({ id: recorderConnections.id });
      return reported.length > 0;
    },

    /** A revoked connection keeps no organization session: nothing may ask the organization for it again. */
    async revoke(userId: string, connectionId: string): Promise<boolean> {
      const revoked = await database
        .update(recorderConnections)
        .set({ revokedAt: now(), organizationSession: null })
        .where(
          and(
            eq(recorderConnections.id, connectionId),
            eq(recorderConnections.userId, userId),
            isNull(recorderConnections.revokedAt),
          ),
        )
        .returning({ id: recorderConnections.id });
      return revoked.length > 0;
    },

    /** sha256(token) lookup of a live connection; touches last_used_at at most once a minute. */
    async resolve(token: string) {
      const [row] = await database
        .select()
        .from(recorderConnections)
        .where(
          and(
            eq(recorderConnections.tokenHash, digest(token)),
            isNull(recorderConnections.revokedAt),
          ),
        )
        .limit(1);
      if (!row) return null;
      const at = now();
      await database
        .update(recorderConnections)
        .set({ lastUsedAt: at })
        .where(
          and(
            eq(recorderConnections.id, row.id),
            or(
              isNull(recorderConnections.lastUsedAt),
              lte(
                recorderConnections.lastUsedAt,
                new Date(at.getTime() - LAST_USED_INTERVAL_MS),
              ),
            ),
          ),
        );
      return {
        connectionId: row.id,
        userId: row.userId,
        organizationSession: row.organizationSession,
      };
    },
  };
}
