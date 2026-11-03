import { type AuditStore, recordAuditEvent } from "./audit";
import { reasonWithoutStatement } from "./db/query-failure";
import type { credentialKind } from "./db/schema";
import {
  SecretMissingError,
  SecretNameTakenError,
  SecretRevokedError,
  SecretVersionConflictError,
  type StoredSecret,
} from "./vault/client";
import type { ConnectionsDirectory } from "./vault/directory";

/*
 * THE VAULT IS INTELLIGENCE'S. Every credential this deployment holds — model keys, connector keys,
 * remote Bots' keys, app tokens, OAuth clients, each person's OAuth tokens, webhook secrets — is a
 * secret in Intelligence's vault (`docs/contracts/vault.md` there), encrypted under a key that
 * belongs to the organization and read back only through a reveal the vault records: who asked, for
 * which person and which Bot, and why. This module is OpenBot's view of it, kept in the shape the rest
 * of the server always called, so a credential is still created, rotated, revoked and spent through
 * one place.
 *
 * NO TRANSACTION OF OURS CAN HOLD IT. A write here is a call to Intelligence. It never joins an
 * OpenBot transaction, and a caller must never make one with a transaction open: the old `executor`
 * argument is gone for that reason. What used to be atomic with a credential write is now ordered
 * around it (store the secret, then point at it; revoke what was replaced last), and a rotation that
 * must not lose the name is one call (`replaces`), atomic inside the vault.
 *
 * The local `credentials` table is kept for one release, unwritten, for the upgrade copy
 * (`vault/upgrade.ts`). `KEY_ENCRYPTION_KEY` no longer encrypts any credential; it still signs and
 * seals OAuth state and other values elsewhere.
 */

type SealedEnvelope = {
  version: 1;
  iv: string;
  ciphertext: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function aesKey(encodedKey: string) {
  return crypto.subtle.importKey(
    "raw",
    Buffer.from(encodedKey, "base64"),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function parseEnvelope(value: string): SealedEnvelope {
  try {
    const envelope = JSON.parse(value) as SealedEnvelope;
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

/**
 * AES-256-GCM under a local key, as `{version, iv, ciphertext}` JSON.
 *
 * No longer how a credential is stored (the vault is Intelligence's). Still how this deployment seals
 * values it keeps itself under `KEY_ENCRYPTION_KEY` (OAuth state, SSO configuration, the Recorder's
 * session), and how the upgrade copy reads the rows the local vault wrote before this release.
 */
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
  } satisfies SealedEnvelope);
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

/** OpenBot's credential kinds, from the enum the local table was created with. */
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
  plaintext: string;
  /**
   * The person whose secret this is, when it is a person's. Derived from the kind's own conventions
   * when not given (see {@link credentialOwner}).
   */
  ownerUserId?: string | null;
};

/** Who reads a credential's value and why: the vault records it with every reveal. */
export type CredentialAccessor = {
  purpose: string;
  userId?: string | null;
  botId?: string | null;
};

export type CredentialStore = {
  create: (value: CredentialStoreValue) => Promise<StoredCredential>;
  /**
   * Replace a live credential's value in place, keeping the id everything already points at.
   *
   * A vendor whose refresh token ROTATES is the one caller: it has already killed the old token at
   * its end by the time it answers, so there is no second grant to withdraw, only a new value to keep.
   * A person RECONNECTING still goes through `rotate`, because that leaves a live grant behind for us
   * to withdraw at our side too.
   *
   * A revoked or missing credential is refused rather than written through: a grant somebody
   * withdrew must not come back to life by being handed a fresh secret. `version`, when given, is the
   * version the caller read; a credential changed since is refused too, so two writers cannot both
   * believe their token is the current one.
   */
  updateSecret: (
    id: string,
    plaintext: string,
    version?: number,
  ) => Promise<{ version: number }>;
  /**
   * Replace one credential with another, atomically: the vault revokes the previous one and stores
   * the new one in one step, so the key never has two live credentials and never has none.
   */
  rotate: (
    input: CredentialStoreValue & { previousCredentialId: string },
  ) => Promise<StoredCredential>;
  revoke: (id: string) => Promise<Date>;
  /** Whether this credential exists and has not been revoked. */
  isLive: (id: string) => Promise<boolean>;
  /** The live credential for a key, if this deployment holds one. At most one can exist. */
  findLiveByKey: (key: {
    kind: CredentialKind;
    provider: string;
    keyId: string;
  }) => Promise<{ id: string } | null>;
};

export type CredentialSecretReader = {
  /**
   * The value of a live credential, for this reader.
   *
   * @throws CredentialUnusableError when it is missing or revoked; any other throw is a fault.
   */
  reveal: (
    id: string,
    accessor: CredentialAccessor,
  ) => Promise<{ value: string; version: number }>;
};

export type CredentialStatusReader = {
  list: () => Promise<CredentialStatus[]>;
};

export type ModelCredentialSecretReader = {
  /** The newest live model key under a name, or null when the vault holds none. */
  revealModelSecret: (
    input: { provider: "openai" | "anthropic"; keyId: string },
    accessor: CredentialAccessor,
  ) => Promise<string | null>;
};

/**
 * The vault answered, and what it holds cannot be spent: the secret is gone, or it is revoked.
 *
 * CRITERION. This is the ONLY thing {@link revealCredentialForUse} raises that means "access was
 * withdrawn". Everything else it can raise — Intelligence unreachable, a refused request, a key the
 * vault could not unwrap — is a fault, and a caller must be able to tell the two apart without
 * reading either message. A class cannot be produced by accident, and it survives a reworded
 * sentence, which is the same argument `TokenRefusedError` carries a `code` for.
 *
 * ONE CLASS FOR BOTH STATES, because no caller acts on the difference: the secret being absent and
 * being retired are both "this credential is not available and will not become available". The
 * messages stay distinct for whoever is reading a log.
 */
export class CredentialUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialUnusableError";
  }
}

/**
 * An administrator asked to revoke or rotate a credential that cannot be revoked or rotated as asked.
 *
 * The id names no credential, or one already revoked, or one that is not what the input describes.
 * It carries the status the route answers with. As a plain `Error` it left the route as a bare 500,
 * so a second click on Revoke read as the deployment being broken rather than the credential being
 * gone already.
 */
export class CredentialRefusedError extends Error {
  readonly status: 404 | 409;

  constructor(message: string, status: 404 | 409) {
    super(message);
    this.name = "CredentialRefusedError";
    this.status = status;
  }
}

/**
 * Whose secret a credential is, from the conventions each kind already keeps: a person's MCP token is
 * named by their id, a GitHub link's name starts with it, and a responsibility's secrets carry it in
 * their metadata. Everything else is the deployment's.
 */
export function credentialOwner(value: {
  kind: CredentialKind;
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  ownerUserId?: string | null;
}): string | null {
  if (value.ownerUserId !== undefined) return value.ownerUserId;
  if (value.kind === "mcp_user_token") return value.keyId;
  if (value.provider === "github-user-token") {
    const [userId] = value.keyId.split(":");
    return userId || null;
  }
  const owner = value.metadata.ownerUserId;
  return typeof owner === "string" && owner.length > 0 ? owner : null;
}

function credentialKindOf(secret: StoredSecret): CredentialKind {
  if (secret.kind === "website_login")
    throw new Error(`Secret ${secret.id} is a saved login, not a credential.`);
  return secret.kind;
}

function statusOf(secret: StoredSecret): CredentialStatus {
  return {
    id: secret.id,
    kind: credentialKindOf(secret),
    provider: secret.provider,
    keyId: secret.keyId,
    metadata: secret.metadata,
    revokedAt: secret.revokedAt,
  };
}

/**
 * Spend a credential: its value, for this reader, or {@link CredentialUnusableError} when the vault
 * holds it no longer or holds it revoked.
 */
export async function revealCredentialForUse(
  reader: CredentialSecretReader,
  credentialId: string,
  accessor: CredentialAccessor,
): Promise<string> {
  return (await reader.reveal(credentialId, accessor)).value;
}

export async function resolveModelApiKey(input: {
  reader: ModelCredentialSecretReader;
  provider: "openai" | "anthropic";
  keyId: string;
  environment: Record<string, string | undefined>;
  accessor: CredentialAccessor;
}) {
  const stored = await input.reader.revealModelSecret(
    { provider: input.provider, keyId: input.keyId },
    input.accessor,
  );
  if (stored) return stored;

  const environmentKey =
    input.environment[
      input.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
    ]?.trim();
  return environmentKey || null;
}

/** The credential kinds; a secret of any other kind (a saved login) is not one. */
const CREDENTIAL_KINDS = new Set<string>([
  "model",
  "connector",
  "agent",
  "mcp",
  "mcp_oauth_client",
  "mcp_user_token",
]);

export function createCredentialStore(
  directory: ConnectionsDirectory,
): CredentialStore &
  CredentialSecretReader &
  CredentialStatusReader &
  ModelCredentialSecretReader {
  const draftOf = (value: CredentialStoreValue) => ({
    id: crypto.randomUUID(),
    kind: value.kind,
    provider: value.provider,
    keyId: value.keyId,
    ownerUserId: credentialOwner(value),
    metadata: value.metadata,
    plaintext: value.plaintext,
  });

  return {
    create: async (value) => {
      const secret = await directory.createSecret(draftOf(value));
      return { id: secret.id, revokedAt: secret.revokedAt };
    },

    updateSecret: async (id, plaintext, version) => {
      const current =
        version === undefined ? await directory.findSecret(id) : undefined;
      if (version === undefined && (!current || current.revokedAt)) {
        throw new Error("Credential was not found or is revoked");
      }
      try {
        const updated = await directory.updateSecret(
          id,
          version ?? (current as StoredSecret).version,
          { plaintext },
        );
        return { version: updated.version };
      } catch (error) {
        if (
          error instanceof SecretMissingError ||
          error instanceof SecretRevokedError
        ) {
          throw new Error("Credential was not found or is revoked");
        }
        throw error;
      }
    },

    rotate: async (input) => {
      const previous = await directory.findSecret(input.previousCredentialId);
      if (!previous || !CREDENTIAL_KINDS.has(previous.kind)) {
        throw new CredentialRefusedError(
          "Previous credential was not found",
          404,
        );
      }
      if (previous.revokedAt) {
        throw new CredentialRefusedError(
          "Previous credential is already revoked",
          409,
        );
      }
      const draft = draftOf(input);
      if (
        previous.kind !== input.kind ||
        previous.provider !== input.provider ||
        previous.keyId !== input.keyId ||
        previous.ownerUserId !== draft.ownerUserId
      ) {
        throw new CredentialRefusedError(
          "Previous credential does not match the input's kind, provider or keyId",
          409,
        );
      }
      try {
        const secret = await directory.createSecret({
          ...draft,
          replaces: input.previousCredentialId,
        });
        return { id: secret.id, revokedAt: secret.revokedAt };
      } catch (error) {
        // Another replica rotated or revoked it between the read above and the vault's own check.
        if (error instanceof SecretRevokedError)
          throw new CredentialRefusedError(
            "Previous credential is already revoked",
            409,
          );
        if (error instanceof SecretMissingError)
          throw new CredentialRefusedError(
            "Previous credential was not found",
            404,
          );
        throw error;
      }
    },

    revoke: async (id) => {
      try {
        const secret = await directory.revokeSecret(id);
        if (!secret.revokedAt) throw new Error("The vault did not revoke it.");
        return secret.revokedAt;
      } catch (error) {
        // Only a live secret is revoked. A second revoke would otherwise report success, so a caller
        // could not tell retiring a credential from finding it already gone.
        if (
          error instanceof SecretMissingError ||
          error instanceof SecretRevokedError ||
          error instanceof SecretVersionConflictError
        ) {
          throw new CredentialRefusedError(
            "Credential was not found or already revoked",
            404,
          );
        }
        throw error;
      }
    },

    isLive: async (id) => {
      const secret = await directory.findSecret(id);
      return (
        secret !== null &&
        secret.revokedAt === null &&
        CREDENTIAL_KINDS.has(secret.kind)
      );
    },

    findLiveByKey: async (key) => {
      const secret = directory.liveSecretByKey(key);
      return secret ? { id: secret.id } : null;
    },

    reveal: async (id, accessor) => {
      try {
        const revealed = await directory.reveal(id, accessor);
        return { value: revealed.value, version: revealed.version };
      } catch (error) {
        if (error instanceof SecretMissingError)
          throw new CredentialUnusableError("Credential was not found");
        if (error instanceof SecretRevokedError)
          throw new CredentialUnusableError("Credential is revoked");
        throw error;
      }
    },

    revealModelSecret: async ({ provider, keyId }, accessor) => {
      const secret = directory.liveSecretByKey({
        kind: "model",
        provider,
        keyId,
      });
      if (!secret) return null;
      try {
        return (await directory.reveal(secret.id, accessor)).value;
      } catch (error) {
        // Revoked or removed a moment ago, on another instance: no stored key, as the read used to say.
        if (
          error instanceof SecretMissingError ||
          error instanceof SecretRevokedError
        )
          return null;
        throw error;
      }
    },

    list: async () =>
      directory
        .secrets()
        .filter((secret) => CREDENTIAL_KINDS.has(secret.kind))
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        )
        .map(statusOf),
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

type CredentialService = {
  store: CredentialStore;
  auditStore: AuditStore;
};

/**
 * Store a credential for a key.
 *
 * A key holds one live credential, so storing a second one for a key that already has one is a
 * replacement rather than an addition, and it is carried out as a rotation: the vault revokes the old
 * one and stores the new one in one step, and the trail records `credential.rotated` naming what was
 * replaced.
 *
 * This is the shape the product asks for. The Credentials page offers Add and Revoke and has no
 * rotate control, so replacing a model key is done by adding one for the same provider and keyId.
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

  let stored: StoredCredential;
  try {
    stored = await service.store.create({
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
      metadata: input.metadata,
      plaintext: input.plaintext,
    });
  } catch (error) {
    // Another replica stored one for this key between the lookup and here: replace it instead.
    if (!(error instanceof SecretNameTakenError)) throw error;
    const winner = await service.store.findLiveByKey({
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
    });
    if (!winner) throw error;
    return rotateCredential(service, {
      ...input,
      previousCredentialId: winner.id,
    });
  }

  await recordAuditEvent(service.auditStore, {
    eventType: "credential.created",
    targetType: "credential",
    targetId: stored.id,
    actorUserId: input.actorUserId,
    payload: {
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

export async function rotateCredential(
  service: CredentialService,
  input: CredentialInput & { previousCredentialId: string },
): Promise<CredentialStatus> {
  let stored: StoredCredential;
  try {
    stored = await service.store.rotate({
      previousCredentialId: input.previousCredentialId,
      kind: input.kind,
      provider: input.provider,
      keyId: input.keyId,
      metadata: input.metadata,
      plaintext: input.plaintext,
    });
  } catch (error) {
    /*
     * A refused rotation is worth a row of its own: one aimed at a revoked or missing credential, or
     * one whose key does not match, is either a caller with a bug or an attempt to retire a key the
     * caller was not asked to retire.
     *
     * The reason is asked for through {@link reasonWithoutStatement}, so a failure that quotes what it
     * was sending can never carry the plaintext into `audit_events`, which is append-only and kept for
     * the deployment's whole retention window. The vault's own refusals never carry a value.
     */
    await recordAuditEvent(service.auditStore, {
      eventType: "credential.rotation_refused",
      targetType: "credential",
      targetId: input.previousCredentialId,
      actorUserId: input.actorUserId,
      payload: {
        kind: input.kind,
        provider: input.provider,
        keyId: input.keyId,
        reason: reasonWithoutStatement(error),
      },
    });
    throw error;
  }

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
  store: CredentialStore & CredentialStatusReader,
  auditStore: AuditStore,
): CredentialAdminService {
  const service = { store, auditStore };

  return {
    list: store.list,
    create: (input) => createCredential(service, input),
    rotate: (input) => rotateCredential(service, input),
    revoke: (credentialId, actorUserId) =>
      revokeCredential(service, credentialId, actorUserId),
  };
}
