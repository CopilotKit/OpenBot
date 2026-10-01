import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { savedLogins, signInRequests } from "../db/schema/passwords";
import type {
  PasswordStore,
  SavedLoginRecord,
  SignInRequestRecord,
} from "./types";

function requestRow(
  row: typeof signInRequests.$inferSelect,
): SignInRequestRecord {
  return {
    ...row,
    continuation: (row.continuation as Record<string, unknown> | null) ?? null,
  };
}

/** The Postgres store. Every read and write is scoped by the owner, so a request id alone is nothing. */
export function createPasswordStore(database: Database): PasswordStore {
  return {
    async createRequest(input) {
      const [row] = await database
        .insert(signInRequests)
        .values({
          ...input,
          continuation: input.continuation ?? null,
          status: "pending",
        })
        .returning();
      if (!row) throw new Error("The sign-in request was not recorded.");
      return requestRow(row);
    },
    async request(ownerUserId, id) {
      const [row] = await database
        .select()
        .from(signInRequests)
        .where(
          and(
            eq(signInRequests.ownerUserId, ownerUserId),
            eq(signInRequests.id, id),
          ),
        )
        .limit(1);
      return row ? requestRow(row) : null;
    },
    async pendingRequests(ownerUserId) {
      const rows = await database
        .select()
        .from(signInRequests)
        .where(
          and(
            eq(signInRequests.ownerUserId, ownerUserId),
            inArray(signInRequests.status, ["pending", "taken_over"]),
            sql`${signInRequests.expiresAt} > now()`,
          ),
        )
        .orderBy(desc(signInRequests.createdAt))
        .limit(50);
      return rows.map(requestRow);
    },
    async transition(ownerUserId, id, from, to) {
      const [row] = await database
        .update(signInRequests)
        .set(to)
        .where(
          and(
            eq(signInRequests.ownerUserId, ownerUserId),
            eq(signInRequests.id, id),
            inArray(signInRequests.status, [...from]),
          ),
        )
        .returning();
      return row ? requestRow(row) : null;
    },
    async logins(ownerUserId, origin) {
      return database
        .select()
        .from(savedLogins)
        .where(
          and(
            eq(savedLogins.ownerUserId, ownerUserId),
            ...(origin ? [eq(savedLogins.origin, origin)] : []),
          ),
        )
        .orderBy(asc(savedLogins.origin), asc(savedLogins.username));
    },
    async login(ownerUserId, id) {
      const [row] = await database
        .select()
        .from(savedLogins)
        .where(
          and(eq(savedLogins.ownerUserId, ownerUserId), eq(savedLogins.id, id)),
        )
        .limit(1);
      return row ?? null;
    },
    async saveLogin(input) {
      const now = new Date();
      const [row] = await database
        .insert(savedLogins)
        .values({ id: randomUUID(), ...input })
        .onConflictDoUpdate({
          target: [
            savedLogins.ownerUserId,
            savedLogins.origin,
            savedLogins.username,
          ],
          set: { encryptedPassword: input.encryptedPassword, updatedAt: now },
        })
        .returning();
      if (!row) throw new Error("The login was not saved.");
      return row;
    },
    async touchLogin(ownerUserId, id) {
      await database
        .update(savedLogins)
        .set({ lastUsedAt: new Date() })
        .where(
          and(eq(savedLogins.ownerUserId, ownerUserId), eq(savedLogins.id, id)),
        );
    },
    async deleteLogin(ownerUserId, id) {
      const rows = await database
        .delete(savedLogins)
        .where(
          and(eq(savedLogins.ownerUserId, ownerUserId), eq(savedLogins.id, id)),
        )
        .returning({ id: savedLogins.id });
      return rows.length > 0;
    },
  };
}

/** The same contract in memory, for tests and for a deployment wired without a database. */
export function createMemoryPasswordStore(): PasswordStore & {
  requests: Map<string, SignInRequestRecord>;
  saved: Map<string, SavedLoginRecord>;
} {
  const requests = new Map<string, SignInRequestRecord>();
  const saved = new Map<string, SavedLoginRecord>();
  return {
    requests,
    saved,
    async createRequest(input) {
      const record: SignInRequestRecord = {
        ...input,
        status: "pending",
        method: null,
        outcome: null,
        controlRequestId: null,
        createdAt: new Date(),
        resolvedAt: null,
      };
      requests.set(record.id, record);
      return { ...record };
    },
    async request(ownerUserId, id) {
      const row = requests.get(id);
      return row && row.ownerUserId === ownerUserId ? { ...row } : null;
    },
    async pendingRequests(ownerUserId) {
      return [...requests.values()].filter(
        (row) =>
          row.ownerUserId === ownerUserId &&
          (row.status === "pending" || row.status === "taken_over") &&
          row.expiresAt > new Date(),
      );
    },
    async transition(ownerUserId, id, from, to) {
      const row = requests.get(id);
      if (!row || row.ownerUserId !== ownerUserId || !from.includes(row.status))
        return null;
      Object.assign(row, to);
      return { ...row };
    },
    async logins(ownerUserId, origin) {
      return [...saved.values()].filter(
        (row) =>
          row.ownerUserId === ownerUserId && (!origin || row.origin === origin),
      );
    },
    async login(ownerUserId, id) {
      const row = saved.get(id);
      return row && row.ownerUserId === ownerUserId ? { ...row } : null;
    },
    async saveLogin(input) {
      const existing = [...saved.values()].find(
        (row) =>
          row.ownerUserId === input.ownerUserId &&
          row.origin === input.origin &&
          row.username === input.username,
      );
      if (existing) {
        existing.encryptedPassword = input.encryptedPassword;
        existing.updatedAt = new Date();
        return { ...existing };
      }
      const record: SavedLoginRecord = {
        id: randomUUID(),
        ...input,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUsedAt: null,
      };
      saved.set(record.id, record);
      return { ...record };
    },
    async touchLogin(ownerUserId, id) {
      const row = saved.get(id);
      if (row && row.ownerUserId === ownerUserId) row.lastUsedAt = new Date();
    },
    async deleteLogin(ownerUserId, id) {
      const row = saved.get(id);
      if (!row || row.ownerUserId !== ownerUserId) return false;
      saved.delete(id);
      return true;
    },
  };
}
