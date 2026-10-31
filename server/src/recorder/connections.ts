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
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
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

/**
 * How long a connection lasts, taken from the session it stands in for (recorder/wiring.ts decides which):
 *
 * - `idle`: until it has gone this long unused, as a Better Auth session does. Better Auth moves a session's expiry to
 *   `expiresIn` from now each time it is used, so a session ends that long after its last use; a connection's last use
 *   is `last_used_at`, written at most once a minute.
 * - `organization`: until the organization session cookie it carries a sealed copy of expires, whatever its use: the
 *   copy must not outlive the cookie it was taken from. That expiry is kept with the copy
 *   (`organization_session_expires_at`). A connection made before it was kept has none, and lasts `ms` (the cookie's
 *   Max-Age) from when it was made, which no cookie it could have copied outlived.
 * - `null`: never, where there is no session to take a lifetime from. A single-user OpenBot has no sign-in: every
 *   request to it is already its one person.
 */
export type RecorderConnectionLifetime =
  | { kind: "idle"; ms: number }
  | { kind: "organization"; ms: number }
  | null;

/** A sealed copy of the person's organization session cookie, and when that cookie expires (recorder/wiring.ts). */
export type SealedOrganizationSession = { sealed: string; expiresAt: Date };

/**
 * Why a connection ended, as its `recorder.revoked` row says: `replaced` (the same copy connected again), `disconnected`
 * (its own Recorder's Disconnect), `revoked` (the person, from Settings, Browsers), `signed_out` (the person's sign-in
 * here ended: they signed out, their sessions were ended, they were removed; the row's `ending` says how) or `expired`
 * (its lifetime ran out). A Bot's browser's connection, which lasts one recording (browser/bot-browser.ts), ends
 * `stopped` (the person's Stop), `ended` (the recording ended without one, and the connection was found left behind)
 * or `not-started` (the start it was minted for did not happen). The person's own OpenBot browser's ends `cleared` when
 * they clear that browser (browser/routes.ts): its token was in the profile the clear deleted.
 */
export type RecorderRevokeReason =
  | "replaced"
  | "disconnected"
  | "revoked"
  | "signed_out"
  | "expired"
  | "cleared"
  | BotBrowserRevokeReason;

/** Why a Bot's browser's connection ended (`RecorderRevokeReason`). */
export type BotBrowserRevokeReason = "stopped" | "ended" | "not-started";

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

/** A transaction, for the statements that take a lock or write their audit row inside it. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A transaction-scoped advisory lock, so the writes it guards take turns on every replica: Postgres holds it, and
 * releases it when the transaction ends, committed or not. Keyed as identity/store.ts keys its own.
 */
async function lock(transaction: Transaction, key: string) {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

export function createRecorderConnectionStore(
  database: Database,
  options: {
    now?: () => Date;
    /** How long a connection lasts; absent, as `null`. */
    lifetime?: RecorderConnectionLifetime;
    /**
     * Where a connection's `recorder.connected` and `recorder.revoked` rows go, given the transaction that makes the
     * change: index.ts passes `createAuditStore` over it, so a connection is made, or ended, exactly when its row is
     * written, and a row that cannot be written undoes the change and fails the request (as approvals and identity
     * links are written). Absent, no rows are written: a test of the store alone.
     */
    auditFor?: (executor: Database) => AuditStore;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const lifetime = options.lifetime ?? null;
  const auditFor = options.auditFor;

  /** The condition a connection must meet at `at` to be within its lifetime; undefined when it has none. */
  const withinLifetime = (at: Date): SQL | undefined => {
    if (!lifetime) return undefined;
    const since = new Date(at.getTime() - lifetime.ms);
    if (lifetime.kind === "idle")
      return gt(
        sql`coalesce(${recorderConnections.lastUsedAt}, ${recorderConnections.createdAt})`,
        since,
      );
    return or(
      gt(recorderConnections.organizationSessionExpiresAt, at),
      and(
        isNull(recorderConnections.organizationSessionExpiresAt),
        gt(recorderConnections.createdAt, since),
      ),
    );
  };
  /** Not revoked, and within its lifetime. */
  const live = (at: Date) =>
    and(isNull(recorderConnections.revokedAt), withinLifetime(at));

  /** One `recorder.revoked` row for each connection ended, in the transaction that ended them, saying how it was made as
   * its `recorder.connected` row did. */
  async function auditRevoked(
    transaction: Transaction,
    ended: Array<{ id: string; userId: string; via: RecorderConnectVia }>,
    reason: RecorderRevokeReason,
    /** How the person's sign-in ended, for `signed_out`. */
    ending?: string,
  ) {
    if (!auditFor || ended.length === 0) return;
    const auditStore = auditFor(transaction as unknown as Database);
    for (const connection of ended) {
      await recordAuditEvent(auditStore, {
        eventType: "recorder.revoked",
        targetType: "recorder_connection",
        targetId: connection.id,
        // An expiry is the deployment ending it; every other reason is something the person did.
        ...(reason === "expired"
          ? { initiator: DEPLOYMENT_INITIATOR }
          : { actorUserId: connection.userId }),
        payload: {
          connectionId: connection.id,
          via: connection.via,
          reason,
          ...(ending ? { ending } : {}),
          ...(reason === "expired" ? { owner: connection.userId } : {}),
        },
      });
    }
  }

  return {
    /**
     * Null when this person already holds {@link LIVE_CODES_PER_PERSON} unexpired codes. Every expired code, and the
     * sealed organization session it held, is deleted first.
     *
     * One person's mints take turns, on every replica, behind a lock on that person: counting and then inserting is a
     * cap only when nobody else of theirs can count between the two.
     */
    async mintCode(
      userId: string,
      via: RecorderConnectVia,
      organizationSession: SealedOrganizationSession | null = null,
    ): Promise<ConnectCodeResponse | null> {
      const created = now();
      // Outside the lock, which is one person's: these rows are everybody's.
      await database
        .delete(recorderConnectCodes)
        .where(lte(recorderConnectCodes.expiresAt, created));
      return database.transaction(async (transaction) => {
        await lock(transaction, `recorder-codes\u001f${userId}`);
        const [live] = await transaction
          .select({ codes: count() })
          .from(recorderConnectCodes)
          .where(
            and(
              eq(recorderConnectCodes.userId, userId),
              gt(recorderConnectCodes.expiresAt, created),
            ),
          );
        if ((live?.codes ?? 0) >= LIVE_CODES_PER_PERSON) return null;
        const code = secretWithPrefix(RECORDER_CODE_PREFIX);
        const expiresAt = new Date(
          created.getTime() + RECORDER_CONNECT_CODE_TTL_MS,
        );
        await transaction.insert(recorderConnectCodes).values({
          codeHash: digest(code),
          userId,
          via,
          organizationSession: organizationSession?.sealed ?? null,
          organizationSessionExpiresAt: organizationSession?.expiresAt ?? null,
          createdAt: created,
          expiresAt,
        });
        return { code, expiresAt: expiresAt.toISOString() };
      });
    },

    /**
     * Consumes the code atomically (it is deleted, with the sealed organization session it held) and, in the same
     * transaction, revokes this person's older live connection with the same `installId` (the same copy connecting
     * again, Decision 18) and writes `recorder.connected`, with `recorder.revoked` for the one it replaced. Null when the
     * code is unknown, expired or already used. Throws when the connection or its row could not be written; then nothing
     * changed, the code included, and it can be tried again.
     *
     * Two exchanges for the same person and copy at once (a double click, a retry, two replicas) take turns behind a lock
     * on that pair, so the second sees the first's connection and replaces it, as the same copy connecting again. Without
     * the turn both found no older connection and both inserted, and the second broke
     * `recorder_connections_live_install_idx` (one live connection per person and copy) and answered a 500.
     */
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
        await lock(
          transaction,
          `recorder-install\u001f${consumed.userId}\u001f${input.installId}`,
        );
        const replaced = await transaction
          .update(recorderConnections)
          .set({
            revokedAt: at,
            organizationSession: null,
            organizationSessionExpiresAt: null,
          })
          .where(
            and(
              eq(recorderConnections.userId, consumed.userId),
              eq(recorderConnections.installId, input.installId),
              isNull(recorderConnections.revokedAt),
            ),
          )
          .returning({
            id: recorderConnections.id,
            userId: recorderConnections.userId,
            via: recorderConnections.via,
          });
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
            organizationSessionExpiresAt: consumed.organizationSessionExpiresAt,
            createdAt: at,
          })
          .returning();
        if (!connection) throw new Error("The connection was not stored.");
        const made = connectionView(connection);
        if (auditFor) {
          await recordAuditEvent(auditFor(transaction as unknown as Database), {
            eventType: "recorder.connected",
            targetType: "recorder_connection",
            targetId: made.id,
            actorUserId: consumed.userId,
            payload: {
              connectionId: made.id,
              via: made.via,
              extensionId: made.extensionId,
              installId: made.installId,
              label: made.label,
            },
          });
        }
        await auditRevoked(transaction, replaced, "replaced");
        return {
          token,
          connection: made,
          userId: consumed.userId,
          replaced: replaced[0]?.id ?? null,
        };
      });
    },

    /** Live connections only, oldest first. */
    async list(userId: string): Promise<RecorderConnection[]> {
      const rows = await database
        .select()
        .from(recorderConnections)
        .where(and(eq(recorderConnections.userId, userId), live(now())))
        .orderBy(asc(recorderConnections.createdAt));
      return rows.map(connectionView);
    },

    /**
     * The live connections stored under one install id and made `via` this, whoever they belong to, oldest first: a Bot's
     * browser holds one for each person recording in it (browser/bot-browser.ts), and the Bot's browser, not any one
     * person, is what is asked about.
     */
    async atInstall(
      installId: string,
      via: RecorderConnectVia,
    ): Promise<(RecorderConnection & { userId: string })[]> {
      const rows = await database
        .select()
        .from(recorderConnections)
        .where(
          and(
            eq(recorderConnections.installId, installId),
            eq(recorderConnections.via, via),
            live(now()),
          ),
        )
        .orderBy(asc(recorderConnections.createdAt));
      return rows.map((row) => ({
        ...connectionView(row),
        userId: row.userId,
      }));
    },

    /**
     * This person's live connections, oldest first, each with what its Recorder last said it was doing: in one query, for
     * the Browser button, which asks every few seconds.
     */
    async reporting(userId: string): Promise<ReportingConnection[]> {
      const rows = await database
        .select()
        .from(recorderConnections)
        .where(and(eq(recorderConnections.userId, userId), live(now())))
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

    /**
     * Ends one of this person's live connections, with its `recorder.revoked` row in the same transaction. A revoked
     * connection keeps no organization session: nothing may ask the organization for it again. False when it is not
     * this person's live connection.
     */
    async revoke(
      userId: string,
      connectionId: string,
      reason:
        | "disconnected"
        | "revoked"
        | "signed_out"
        | "cleared"
        | BotBrowserRevokeReason,
      /** How the person's sign-in ended, for `signed_out`. */
      ending?: string,
    ): Promise<boolean> {
      return database.transaction(async (transaction) => {
        const revoked = await transaction
          .update(recorderConnections)
          .set({
            revokedAt: now(),
            organizationSession: null,
            organizationSessionExpiresAt: null,
          })
          .where(
            and(
              eq(recorderConnections.id, connectionId),
              eq(recorderConnections.userId, userId),
              isNull(recorderConnections.revokedAt),
            ),
          )
          .returning({
            id: recorderConnections.id,
            userId: recorderConnections.userId,
            via: recorderConnections.via,
          });
        await auditRevoked(transaction, revoked, reason, ending);
        return revoked.length > 0;
      });
    },

    /**
     * Ends every connection this person holds, as signing out of OpenBot does: each browser's Recorder is signed out
     * with them. Their unused connect codes go too, with any sealed organization session in them, so none minted before
     * the sign-out makes a connection after it. Returns the connections it ended.
     *
     * The codes first: an exchange already under way holds its code, so deleting the codes waits for it, and the
     * connection it made is then there to be ended with the rest.
     */
    async revokeAll(
      userId: string,
      reason: "signed_out",
      ending?: string,
    ): Promise<string[]> {
      return database.transaction(async (transaction) => {
        await transaction
          .delete(recorderConnectCodes)
          .where(eq(recorderConnectCodes.userId, userId));
        const revoked = await transaction
          .update(recorderConnections)
          .set({
            revokedAt: now(),
            organizationSession: null,
            organizationSessionExpiresAt: null,
          })
          .where(
            and(
              eq(recorderConnections.userId, userId),
              isNull(recorderConnections.revokedAt),
            ),
          )
          .returning({
            id: recorderConnections.id,
            userId: recorderConnections.userId,
            via: recorderConnections.via,
          });
        await auditRevoked(transaction, revoked, reason, ending);
        return revoked.map((connection) => connection.id);
      });
    },

    /** Everybody who holds a live connection now, each once: whose Recorders a sign-in ending for many people ends. */
    async holders(): Promise<string[]> {
      const rows = await database
        .selectDistinct({ userId: recorderConnections.userId })
        .from(recorderConnections)
        .where(live(now()));
      return rows.map((row) => row.userId);
    },

    /**
     * Ends every connection whose lifetime has run out, and the sealed organization session it held. A connection past
     * its lifetime already resolves to nobody (`resolve`); this is what removes the copy of a session that nothing will
     * ask for again, and says so in the trail. Returns how many it ended.
     *
     * It passes over a row somebody else holds (`skip locked`): a sign-out or a reconnect ending the same connection
     * gets it, and the sweep neither waits for them nor, taking its rows in another order, deadlocks with them. Two
     * replicas sweeping at once take different rows, so each is ended, and written, once.
     */
    async expire(): Promise<number> {
      const at = now();
      const within = withinLifetime(at);
      if (!within) return 0;
      return database.transaction(async (transaction) => {
        const due = transaction
          .select({ id: recorderConnections.id })
          .from(recorderConnections)
          .where(
            and(isNull(recorderConnections.revokedAt), sql`not (${within})`),
          )
          .for("update", { skipLocked: true });
        const expired = await transaction
          .update(recorderConnections)
          .set({
            revokedAt: at,
            organizationSession: null,
            organizationSessionExpiresAt: null,
          })
          .where(
            and(
              inArray(recorderConnections.id, due),
              isNull(recorderConnections.revokedAt),
            ),
          )
          .returning({
            id: recorderConnections.id,
            userId: recorderConnections.userId,
            via: recorderConnections.via,
          });
        await auditRevoked(transaction, expired, "expired");
        return expired.length;
      });
    },

    /**
     * sha256(token) lookup of a live connection within its lifetime; touches last_used_at at most once a minute, which is
     * what keeps an `idle` lifetime going while the Recorder is used.
     */
    async resolve(token: string) {
      const at = now();
      const [row] = await database
        .select()
        .from(recorderConnections)
        .where(and(eq(recorderConnections.tokenHash, digest(token)), live(at)))
        .limit(1);
      if (!row) return null;
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
