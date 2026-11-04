import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { signInRequests } from "../db/schema/passwords";
import {
  SecretMissingError,
  SecretNameTakenError,
  SecretRevokedError,
  SecretVersionConflictError,
  type StoredSecret,
} from "../vault/client";
import { vault } from "../vault/directory";
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

/** Code unit order, so two readings of the same list answer alike. */
const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function isLiveLoginOf(secret: StoredSecret, ownerUserId: string) {
  return (
    secret.kind === "website_login" &&
    secret.ownerUserId === ownerUserId &&
    secret.revokedAt === null
  );
}

function liveLogins(ownerUserId: string): StoredSecret[] {
  return vault()
    .secrets()
    .filter((secret) => isLiveLoginOf(secret, ownerUserId));
}

function dateIn(metadata: Record<string, unknown>, key: string): Date | null {
  const value = metadata[key];
  return typeof value === "string" ? new Date(value) : null;
}

function loginRecord(secret: StoredSecret): SavedLoginRecord {
  return {
    id: secret.id,
    ownerUserId: secret.ownerUserId ?? "",
    origin: secret.provider,
    username: secret.keyId,
    createdAt: secret.createdAt,
    updatedAt: dateIn(secret.metadata, "passwordChangedAt") ?? secret.createdAt,
    lastUsedAt: dateIn(secret.metadata, "lastUsedAt"),
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
            inArray(signInRequests.status, [
              "pending",
              "code_required",
              "taken_over",
            ]),
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
    /*
     * SAVED LOGINS ARE THE VAULT'S. Each is a `website_login` secret in Intelligence, owned by the
     * person, named by the site's origin (`provider`) and the username (`keyId`), with the password
     * as its value; the list reads from this instance's vault directory, in memory, and only
     * `revealPassword` ever reads a password, through a reveal the vault records. `lastUsedAt` and
     * when the password was last changed ride in the secret's metadata.
     */
    async logins(ownerUserId, origin) {
      return liveLogins(ownerUserId)
        .filter((secret) => !origin || secret.provider === origin)
        .sort(
          (left, right) =>
            compare(left.provider, right.provider) ||
            compare(left.keyId, right.keyId),
        )
        .map(loginRecord);
    },
    async login(ownerUserId, id) {
      const secret = await vault().findSecret(id);
      return secret && isLiveLoginOf(secret, ownerUserId)
        ? loginRecord(secret)
        : null;
    },
    async saveLogin(input) {
      const directory = vault();
      for (let attempt = 1; ; attempt++) {
        // One login per person, site and username: a second save replaces the password, keeping
        // the id the person's list already shows.
        const existing = liveLogins(input.ownerUserId).find(
          (secret) =>
            secret.provider === input.origin && secret.keyId === input.username,
        );
        const changedAt = new Date().toISOString();
        try {
          const saved = existing
            ? await directory.updateSecret(existing.id, existing.version, {
                plaintext: input.password,
                metadata: {
                  ...existing.metadata,
                  passwordChangedAt: changedAt,
                },
              })
            : await directory.createSecret({
                id: randomUUID(),
                kind: "website_login",
                provider: input.origin,
                keyId: input.username,
                ownerUserId: input.ownerUserId,
                metadata: { lastUsedAt: null, passwordChangedAt: changedAt },
                plaintext: input.password,
              });
          return loginRecord(saved);
        } catch (error) {
          // Another save of the same login landed first, here or on another server: save over it.
          const raced =
            error instanceof SecretNameTakenError ||
            error instanceof SecretVersionConflictError;
          if (!raced || attempt >= 3) throw error;
          await directory.resync();
        }
      }
    },
    async revealPassword(ownerUserId, id, botId) {
      const secret = await vault().findSecret(id);
      if (!secret || !isLiveLoginOf(secret, ownerUserId)) return null;
      try {
        return (
          await vault().reveal(id, {
            purpose: "website_sign_in",
            userId: ownerUserId,
            botId,
          })
        ).value;
      } catch (error) {
        if (
          error instanceof SecretMissingError ||
          error instanceof SecretRevokedError
        )
          return null;
        throw error;
      }
    },
    async touchLogin(ownerUserId, id) {
      const directory = vault();
      for (let attempt = 1; attempt <= 3; attempt++) {
        const secret = await directory.findSecret(id);
        if (!secret || !isLiveLoginOf(secret, ownerUserId)) return;
        try {
          await directory.updateSecret(id, secret.version, {
            metadata: {
              ...secret.metadata,
              lastUsedAt: new Date().toISOString(),
            },
          });
          return;
        } catch (error) {
          if (!(error instanceof SecretVersionConflictError)) throw error;
          await directory.findSecret(id);
        }
      }
    },
    async deleteLogin(ownerUserId, id) {
      const secret = await vault().findSecret(id);
      if (!secret || !isLiveLoginOf(secret, ownerUserId)) return false;
      await vault().purgeSecret(id);
      return true;
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
  const passwords = new Map<string, string>();
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
        fillingUntil: null,
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
          ["pending", "code_required", "taken_over"].includes(row.status) &&
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
        passwords.set(existing.id, input.password);
        existing.updatedAt = new Date();
        return { ...existing };
      }
      const { password, ...login } = input;
      const record: SavedLoginRecord = {
        id: randomUUID(),
        ...login,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUsedAt: null,
      };
      saved.set(record.id, record);
      passwords.set(record.id, password);
      return { ...record };
    },
    async revealPassword(ownerUserId, id) {
      const row = saved.get(id);
      return row && row.ownerUserId === ownerUserId
        ? (passwords.get(id) ?? null)
        : null;
    },
    async touchLogin(ownerUserId, id) {
      const row = saved.get(id);
      if (row && row.ownerUserId === ownerUserId) row.lastUsedAt = new Date();
    },
    async deleteLogin(ownerUserId, id) {
      const row = saved.get(id);
      if (!row || row.ownerUserId !== ownerUserId) return false;
      saved.delete(id);
      passwords.delete(id);
      return true;
    },
  };
}
