import { and, desc, eq, isNull } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "./audit";
import type { Database } from "./db/client";
import { type credentialKind, credentials } from "./db/schema";

type CredentialEnvelope = {
  version: 1;
  iv: string;
  ciphertext: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derived from the enum rather than written out again.
 *
 * These were two lists that had to agree, and nothing made them. A kind added to the schema and not
 * here fails at the point of use with a type error about an unrelated call site; a kind removed from
 * the schema and left here compiles and then violates a check constraint at runtime. One source now.
 */
export type CredentialKind = (typeof credentialKind.enumValues)[number];

export type CredentialStatus = {
  id: string;
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  revokedAt: Date | null;
};

type StoredCredential = {
  id: string;
  revokedAt: Date | null;
};

export type CredentialStoreValue = {
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  encryptedValue: string;
};

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Where a credential write runs.
 *
 * A caller already inside a transaction passes it here, so the write joins that
 * transaction rather than opening one of its own on a second pooled connection.
 * Two connections would mean the credential committing separately from the
 * change that asked for it, and, since the caller is usually holding row locks
 * by then, a pool with nothing spare to hand out deadlocks instead. See the
 * note on `max` in `db/client.ts`.
 */
export type CredentialExecutor =
  | Pick<Database, "select" | "insert" | "update">
  | Pick<Transaction, "select" | "insert" | "update">;

export type CredentialStore = {
  create: (
    value: CredentialStoreValue,
    executor?: CredentialExecutor,
  ) => Promise<StoredCredential>;
  /**
   * Replace one credential with another, atomically.
   *
   * Retiring the old secret and storing the new one are one decision, so they
   * are one write. Two separate calls cannot be made safe from the outside:
   * an `UPDATE` can commit and still throw on the way back, and no compensating
   * revoke survives the process being killed between them.
   *
   * Without an executor this opens its own transaction. With one it runs inside
   * the caller's, and is atomic with whatever else that transaction is doing.
   */
  rotate: (
    input: CredentialStoreValue & { previousCredentialId: string },
    executor?: CredentialExecutor,
  ) => Promise<StoredCredential>;
  revoke: (id: string, executor?: CredentialExecutor) => Promise<Date>;
  /** Whether this credential exists and has not been revoked. */
  isLive: (id: string, executor?: CredentialExecutor) => Promise<boolean>;
  /**
   * The live credential for a key, if this deployment holds one.
   *
   * At most one can exist, which is what `credentials_active_key_idx`
   * enforces, so a caller about to store a secret for a key can ask whether it
   * is replacing something rather than finding out from a failed insert.
   */
  findLiveByKey: (
    key: { kind: CredentialKind; provider: string; keyId: string },
    executor?: CredentialExecutor,
  ) => Promise<{ id: string } | null>;
};

export type CredentialSecretReader = {
  readSecret: (id: string) => Promise<{
    encryptedValue: string;
    revokedAt: Date | null;
  } | null>;
};

export type CredentialStatusReader = {
  list: () => Promise<CredentialStatus[]>;
};

export type ModelCredentialSecretReader = {
  readModelSecret: (input: {
    provider: "openai";
    keyId: string;
  }) => Promise<{ encryptedValue: string } | null>;
};

type CredentialService = {
  encryptionKey: string;
  store: CredentialStore;
  auditStore: AuditStore;
};

async function aesKey(encodedKey: string) {
  return crypto.subtle.importKey(
    "raw",
    Buffer.from(encodedKey, "base64"),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function parseEnvelope(value: string): CredentialEnvelope {
  try {
    const envelope = JSON.parse(value) as CredentialEnvelope;
    if (
      envelope.version !== 1 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new Error("invalid envelope");
    }
    return envelope;
  } catch {
    throw new Error("Credential envelope is invalid");
  }
}

export async function encryptSecret(encodedKey: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(encodedKey),
    encoder.encode(plaintext),
  );

  return JSON.stringify({
    version: 1,
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  } satisfies CredentialEnvelope);
}

export async function decryptSecret(encodedKey: string, value: string) {
  const envelope = parseEnvelope(value);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64") },
    await aesKey(encodedKey),
    Buffer.from(envelope.ciphertext, "base64"),
  );

  return decoder.decode(plaintext);
}

export async function decryptCredentialForUse(
  encodedKey: string,
  reader: CredentialSecretReader,
  credentialId: string,
) {
  const credential = await reader.readSecret(credentialId);
  if (!credential) {
    throw new Error("Credential was not found");
  }
  if (credential.revokedAt) {
    throw new Error("Credential is revoked");
  }

  return decryptSecret(encodedKey, credential.encryptedValue);
}

export async function resolveModelApiKey(input: {
  encryptionKey: string;
  reader: ModelCredentialSecretReader;
  provider: "openai";
  keyId: string;
  environment: Record<string, string | undefined>;
}) {
  const stored = await input.reader.readModelSecret({
    provider: input.provider,
    keyId: input.keyId,
  });
  if (stored) {
    return decryptSecret(input.encryptionKey, stored.encryptedValue);
  }

  const environmentKey = input.environment.OPENAI_API_KEY?.trim();
  return environmentKey || null;
}

export function createCredentialStore(
  database: Database,
): CredentialStore &
  CredentialSecretReader &
  CredentialStatusReader &
  ModelCredentialSecretReader {
  return {
    create: async (value, executor = database) => {
      const [credential] = await executor
        .insert(credentials)
        .values(value)
        .returning({ id: credentials.id, revokedAt: credentials.revokedAt });

      if (!credential) {
        throw new Error("Credential could not be stored");
      }
      return credential;
    },
    rotate: async (input, executor) => {
      const write = async (transaction: CredentialExecutor) => {
        /**
         * The previous credential, locked for the rest of the transaction.
         *
         * Two replicas rotating the same secret would otherwise both read it
         * as live and both act; the second waits here and then finds it
         * revoked. Its identity is read alongside its state so a rotation
         * aimed at the wrong id is refused rather than silently retiring a
         * secret the caller never named.
         */
        const [previous] = await transaction
          .select({
            revokedAt: credentials.revokedAt,
            kind: credentials.kind,
            provider: credentials.provider,
            keyId: credentials.keyId,
          })
          .from(credentials)
          .where(eq(credentials.id, input.previousCredentialId))
          .for("update");
        if (!previous) {
          throw new Error("Previous credential was not found");
        }
        if (previous.revokedAt) {
          throw new Error("Previous credential is already revoked");
        }
        if (
          previous.kind !== input.kind ||
          previous.provider !== input.provider ||
          previous.keyId !== input.keyId
        ) {
          throw new Error(
            "Previous credential does not match the input's kind, provider or keyId",
          );
        }

        // Revoke, then insert. Both orders are invisible from outside the
        // transaction, and this one never holds two live rows for one key even
        // in the middle of it, which is the invariant a uniqueness constraint
        // on live credentials would later depend on.
        const revokedAt = new Date();
        const [revoked] = await transaction
          .update(credentials)
          .set({ revokedAt, updatedAt: revokedAt })
          .where(
            and(
              eq(credentials.id, input.previousCredentialId),
              isNull(credentials.revokedAt),
            ),
          )
          .returning({ revokedAt: credentials.revokedAt });
        if (!revoked?.revokedAt) {
          // Ruled out by the lock above under contention; reaching here means
          // the row was deleted outright between the two statements, which
          // aborts the transaction and leaves nothing committed.
          throw new Error("Previous credential was not found");
        }

        const [inserted] = await transaction
          .insert(credentials)
          .values({
            kind: input.kind,
            provider: input.provider,
            keyId: input.keyId,
            metadata: input.metadata,
            encryptedValue: input.encryptedValue,
          })
          .returning({
            id: credentials.id,
            revokedAt: credentials.revokedAt,
          });
        if (!inserted) {
          throw new Error("Credential could not be stored");
        }

        return inserted;
      };

      // A caller already in a transaction has its own atomicity to keep, and
      // the credential belongs to it rather than to a transaction of its own.
      return executor ? write(executor) : database.transaction(write);
    },
    revoke: async (id, executor = database) => {
      const revokedAt = new Date();
      const [credential] = await executor
        .update(credentials)
        .set({ revokedAt, updatedAt: revokedAt })
        // Only a live row is stamped. Without the guard a second revoke would
        // overwrite the first one's timestamp and report success, so a caller
        // could not tell retiring a credential from finding it already gone.
        .where(and(eq(credentials.id, id), isNull(credentials.revokedAt)))
        .returning({ revokedAt: credentials.revokedAt });

      if (!credential?.revokedAt) {
        throw new Error("Credential was not found or already revoked");
      }
      return credential.revokedAt;
    },
    isLive: async (id, executor = database) => {
      const [credential] = await executor
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.id, id), isNull(credentials.revokedAt)));

      return credential !== undefined;
    },
    findLiveByKey: async ({ kind, provider, keyId }, executor = database) => {
      const [credential] = await executor
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.kind, kind),
            eq(credentials.provider, provider),
            eq(credentials.keyId, keyId),
            isNull(credentials.revokedAt),
          ),
        );

      return credential ?? null;
    },
    readSecret: async (id) => {
      const [credential] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.id, id));

      return credential ?? null;
    },
    readModelSecret: async ({ provider, keyId }) => {
      const [credential] = await database
        .select({ encryptedValue: credentials.encryptedValue })
        .from(credentials)
        .where(
          and(
            eq(credentials.kind, "model"),
            eq(credentials.provider, provider),
            eq(credentials.keyId, keyId),
            isNull(credentials.revokedAt),
          ),
        )
        .orderBy(
          desc(credentials.createdAt),
          // UUID descending selects the lexicographically greatest ID on a timestamp tie.
          desc(credentials.id),
        )
        .limit(1);

      return credential ?? null;
    },
    list: async () => {
      const records = await database
        .select({
          id: credentials.id,
          kind: credentials.kind,
          provider: credentials.provider,
          keyId: credentials.keyId,
          metadata: credentials.metadata,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .orderBy(credentials.createdAt);

      return records.map((credential) => ({
        ...credential,
        metadata: credential.metadata as Record<string, unknown>,
      }));
    },
  };
}

export type CredentialInput = {
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  plaintext: string;
  actorUserId?: string;
};

export type CredentialAdminService = CredentialStatusReader & {
  create: (input: CredentialInput) => Promise<CredentialStatus>;
  rotate: (
    input: CredentialInput & { previousCredentialId: string },
  ) => Promise<CredentialStatus>;
  revoke: (
    credentialId: string,
    actorUserId?: string,
  ) => Promise<{
    id: string;
    revokedAt: Date;
  }>;
};

async function persistCredential(
  service: CredentialService,
  input: CredentialInput,
): Promise<CredentialStatus> {
  const stored = await service.store.create({
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    encryptedValue: await encryptSecret(service.encryptionKey, input.plaintext),
  });

  return {
    id: stored.id,
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    revokedAt: stored.revokedAt,
  };
}

/**
 * Store a credential for a key.
 *
 * A key holds one live credential, so storing a second one for a key that
 * already has one is a replacement rather than an addition, and it is carried
 * out as a rotation: the two writes are atomic and the trail records
 * `credential.rotated` naming what was replaced.
 *
 * This is the shape the product asks for. The Credentials page offers Add and
 * Revoke and has no rotate control, so replacing a model key is done by adding
 * one for the same provider and keyId. Refusing that would leave no way to
 * replace a key at all, and inserting it would raise a bare unique violation
 * from `credentials_active_key_idx`.
 */
export async function createCredential(
  service: CredentialService,
  input: CredentialInput,
): Promise<CredentialStatus> {
  const existing = await service.store.findLiveByKey({
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
  });
  if (existing) {
    return rotateCredential(service, {
      ...input,
      previousCredentialId: existing.id,
    });
  }

  const credential = await persistCredential(service, input);

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.created",
    targetType: "credential",
    targetId: credential.id,
    actorUserId: input.actorUserId,
    payload: {
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
    },
  });

  return credential;
}

export async function rotateCredential(
  service: CredentialService,
  input: CredentialInput & { previousCredentialId: string },
): Promise<CredentialStatus> {
  // Encryption happens before the transaction opens, so no database connection
  // is held while it runs. The store then performs both writes atomically, and
  // a failure leaves the vault as it was, which is why the audit event below is
  // written only once that has returned.
  const stored = await service.store.rotate({
    previousCredentialId: input.previousCredentialId,
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    encryptedValue: await encryptSecret(service.encryptionKey, input.plaintext),
  });

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.rotated",
    targetType: "credential",
    targetId: stored.id,
    actorUserId: input.actorUserId,
    payload: {
      previousCredentialId: input.previousCredentialId,
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
    },
  });

  return {
    id: stored.id,
    kind: input.kind,
    provider: input.provider,
    keyId: input.keyId,
    metadata: input.metadata,
    revokedAt: stored.revokedAt,
  };
}

export async function revokeCredential(
  service: CredentialService,
  credentialId: string,
  actorUserId?: string,
) {
  const revokedAt = await service.store.revoke(credentialId);

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.revoked",
    targetType: "credential",
    targetId: credentialId,
    actorUserId,
    payload: {},
  });

  return { id: credentialId, revokedAt };
}

export function createCredentialAdminService(
  encryptionKey: string,
  store: CredentialStore & CredentialStatusReader,
  auditStore: AuditStore,
): CredentialAdminService {
  const service = { encryptionKey, store, auditStore };

  return {
    list: store.list,
    create: (input) => createCredential(service, input),
    rotate: (input) => rotateCredential(service, input),
    revoke: (credentialId, actorUserId) =>
      revokeCredential(service, credentialId, actorUserId),
  };
}
