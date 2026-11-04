import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app";
import type { AuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import {
  createCredential,
  createCredentialStore,
  decryptSecret,
  encryptSecret,
  revealCredentialForUse,
  resolveModelApiKey,
  revokeCredential,
  rotateCredential,
} from "../src/credentials";
import { SecretNameTakenError } from "../src/vault/client";
import type { ConnectionsDirectory } from "../src/vault/directory";
import { testEnvironment } from "./support/environment";
import {
  purgeSecrets,
  recordingCredentialStore,
  secretsNamed,
  secretValue,
  seedCredential,
  storedSecret,
  useTestVault,
} from "./support/vault";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const config = loadConfig(testEnvironment({ KEY_ENCRYPTION_KEY: key }));
// Every secret a test stores, in Intelligence's vault, purged when the file is done.
const secretIds: string[] = [];
let directory: ConnectionsDirectory;

beforeAll(async () => {
  directory = await useTestVault();
});

afterAll(async () => {
  await purgeSecrets(secretIds.splice(0));
});

/** The real store, recording which of its writes a caller made; what it stores is purged. */
function recordingStore(calls: string[]) {
  return recordingCredentialStore({ calls, created: secretIds });
}

function recordingAudit(audited: unknown[]): AuditStore {
  return {
    insert: async (event) => {
      audited.push(event);
    },
  } as AuditStore;
}

async function seeded(input: Parameters<typeof seedCredential>[0]) {
  const secret = await seedCredential(input);
  secretIds.push(secret.id);
  return secret;
}

describe("credential encryption", () => {
  test("stores a versioned AES-GCM envelope and restores it only server-side", async () => {
    const envelope = await encryptSecret(key, "openai-secret-value");

    expect(JSON.parse(envelope)).toEqual({
      version: 1,
      iv: expect.any(String),
      ciphertext: expect.any(String),
    });
    await expect(decryptSecret(key, envelope)).resolves.toBe(
      "openai-secret-value",
    );
  });

  test("creates a write-only credential and audits safe metadata", async () => {
    const calls: string[] = [];
    const audited: unknown[] = [];
    const keyId = `primary-${randomUUID()}`;

    const credential = await createCredential(
      {
        store: await recordingStore(calls),
        auditStore: recordingAudit(audited),
      },
      {
        kind: "model",
        provider: "openai",
        keyId,
        metadata: { label: "Production OpenAI" },
        plaintext: "openai-secret-value",
        actorUserId: "admin",
      },
    );

    expect(credential).toEqual({
      id: expect.any(String),
      kind: "model",
      provider: "openai",
      keyId,
      metadata: { label: "Production OpenAI" },
      revokedAt: null,
    });
    // Nothing live under the key, so this was an addition, never a replacement.
    expect(calls).toEqual(["create"]);
    // The vault holds the value; what it hands back about the secret never carries it.
    expect(JSON.stringify(await storedSecret(credential.id))).not.toContain(
      "openai-secret-value",
    );
    expect(await secretValue(credential.id)).toBe("openai-secret-value");
    expect(audited).toEqual([
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: credential.id,
        actorUserId: "admin",
        payload: {
          kind: "model",
          provider: "openai",
          keyId,
        },
      },
    ]);
  });

  test("rotates then revokes credentials without returning plaintext", async () => {
    const calls: string[] = [];
    const audited: unknown[] = [];
    const service = {
      store: await recordingStore(calls),
      auditStore: recordingAudit(audited),
    };
    const keyId = `secondary-${randomUUID()}`;
    const previous = await seeded({
      kind: "model",
      provider: "openai",
      keyId,
      plaintext: "old-openai-secret",
    });

    const rotated = await rotateCredential(service, {
      previousCredentialId: previous.id,
      kind: "model",
      provider: "openai",
      keyId,
      metadata: { label: "Rotated OpenAI" },
      plaintext: "new-openai-secret",
      actorUserId: "admin",
    });
    await revokeCredential(service, rotated.id, "admin");

    // The rotation retires the previous credential inside the vault's own step, so the service
    // makes no separate revoke call of its own.
    expect(calls).toEqual([`rotate:${previous.id}`, `revoke:${rotated.id}`]);
    expect((await storedSecret(previous.id))?.revokedAt).not.toBeNull();
    expect((await storedSecret(rotated.id))?.replaces).toBe(previous.id);
    expect((await storedSecret(rotated.id))?.revokedAt).not.toBeNull();
    expect(JSON.stringify(rotated)).not.toContain("new-openai-secret");
    expect(JSON.stringify(audited)).not.toContain("new-openai-secret");
    expect(
      audited.map((event) => (event as { eventType: string }).eventType),
    ).toEqual(["credential.rotated", "credential.revoked"]);
  });

  test("records the refusal when the rotation fails, and never a success", async () => {
    // The vault's rotation is one step, so a failure stores nothing and no row may say a rotation
    // happened. The refusal itself is recorded though: a rotation aimed at a revoked credential, at
    // one that does not exist, or at a key other than the credential's own is either a caller with
    // a bug or an attempt to retire somebody else's key, and it used to leave nothing behind. The
    // caller still sees the original cause.
    const calls: string[] = [];
    const audited: unknown[] = [];
    const keyId = `primary-${randomUUID()}`;
    const previous = await seeded({
      kind: "model",
      provider: "openai",
      keyId,
      plaintext: "old-openai-secret",
      revoked: true,
    });

    await expect(
      rotateCredential(
        {
          store: await recordingStore(calls),
          auditStore: recordingAudit(audited),
        },
        {
          previousCredentialId: previous.id,
          kind: "model",
          provider: "openai",
          keyId,
          metadata: {},
          plaintext: "new-openai-secret",
          actorUserId: "admin",
        },
      ),
    ).rejects.toThrow("Previous credential is already revoked");

    expect(audited).toEqual([
      {
        eventType: "credential.rotation_refused",
        targetType: "credential",
        targetId: previous.id,
        actorUserId: "admin",
        payload: {
          kind: "model",
          provider: "openai",
          keyId,
          reason: "Previous credential is already revoked",
        },
      },
    ]);
    expect(
      (await secretsNamed({ kind: "model", keyId })).map((s) => s.id),
    ).toEqual([previous.id]);
  });

  test("reveals only an active credential for server-side use", async () => {
    const store = createCredentialStore(directory);
    const accessor = { purpose: "connector_call" };
    const live = await seeded({
      kind: "connector",
      provider: `connector-${randomUUID()}`,
      keyId: "token",
      plaintext: "connector-secret",
    });
    const revoked = await seeded({
      kind: "connector",
      provider: `connector-${randomUUID()}`,
      keyId: "token",
      plaintext: "connector-secret",
      revoked: true,
    });

    await expect(
      revealCredentialForUse(store, live.id, accessor),
    ).resolves.toBe("connector-secret");
    await expect(
      revealCredentialForUse(store, revoked.id, accessor),
    ).rejects.toThrow("Credential is revoked");
  });
});

describe("model credential resolution", () => {
  const accessor = { purpose: "model_run" };

  test("prefers a stored model credential over the environment", async () => {
    const keyId = `openai-api-key-${randomUUID()}`;
    await seeded({
      kind: "model",
      provider: "openai",
      keyId,
      plaintext: "stored-openai-key",
    });

    await expect(
      resolveModelApiKey({
        reader: createCredentialStore(directory),
        provider: "openai",
        keyId,
        environment: { OPENAI_API_KEY: "environment-openai-key" },
        accessor,
      }),
    ).resolves.toBe("stored-openai-key");
  });

  test("uses OPENAI_API_KEY when no stored credential exists", async () => {
    await expect(
      resolveModelApiKey({
        reader: createCredentialStore(directory),
        provider: "openai",
        keyId: `openai-api-key-${randomUUID()}`,
        environment: { OPENAI_API_KEY: " environment-openai-key " },
        accessor,
      }),
    ).resolves.toBe("environment-openai-key");
  });

  test("returns null when neither credential source is configured", async () => {
    await expect(
      resolveModelApiKey({
        reader: createCredentialStore(directory),
        provider: "openai",
        keyId: `openai-api-key-${randomUUID()}`,
        environment: {},
        accessor,
      }),
    ).resolves.toBeNull();
  });

  test("rejects a stored key the vault refuses to reveal instead of falling back to the environment", async () => {
    // The vault holds a key under this name and will not hand it over: a fault, not "no key". An
    // empty purpose is a request the vault refuses as invalid, which is that fault, from the real
    // vault. Answering with the environment's key here would run a Bot on a key nobody chose.
    const keyId = `openai-api-key-${randomUUID()}`;
    await seeded({
      kind: "model",
      provider: "openai",
      keyId,
      plaintext: "stored-openai-key",
    });

    await expect(
      resolveModelApiKey({
        reader: createCredentialStore(directory),
        provider: "openai",
        keyId,
        environment: { OPENAI_API_KEY: "environment-openai-key" },
        accessor: { purpose: "" },
      }),
    ).rejects.toThrow("VAULT_VALIDATION_ERROR");
  });
});

describe("model credential store lookup", () => {
  test("selects the live matching model credential and ignores the rest", async () => {
    // A key holds one live credential, which the vault enforces, so the lookup never has more than
    // one candidate to choose between. What is under test is the filter: the secrets that do not
    // match on kind, provider or keyId, and the revoked one for this very key, all have to be passed
    // over.
    const keyId = `openai-api-key-${randomUUID()}`;
    await seeded({
      kind: "model",
      provider: "openai",
      keyId,
      plaintext: "revoked-value",
      revoked: true,
    });
    await seeded({
      kind: "model",
      provider: "openai",
      keyId,
      plaintext: "active-value",
    });
    await seeded({
      kind: "connector",
      provider: "openai",
      keyId,
      plaintext: "wrong-kind-value",
    });
    await seeded({
      kind: "model",
      provider: "other",
      keyId,
      plaintext: "wrong-provider-value",
    });
    await seeded({
      kind: "model",
      provider: "openai",
      keyId: `other-api-key-${randomUUID()}`,
      plaintext: "wrong-key-value",
    });

    await expect(
      createCredentialStore(directory).revealModelSecret(
        { provider: "openai", keyId },
        { purpose: "model_run" },
      ),
    ).resolves.toBe("active-value");
  });
});

describe("credential store rotation", () => {
  test("retires the previous credential and stores the new one together", async () => {
    const store = createCredentialStore(directory);
    const keyId = `rotation-atomic-${randomUUID()}`;
    const previous = await seeded({
      kind: "model",
      provider: "openai",
      keyId,
      plaintext: "initial",
    });

    const rotated = await store.rotate({
      previousCredentialId: previous.id,
      kind: "model",
      provider: "openai",
      keyId,
      metadata: {},
      plaintext: "rotated",
    });
    secretIds.push(rotated.id);

    const byId = Object.fromEntries(
      (await secretsNamed({ kind: "model", provider: "openai", keyId })).map(
        (secret) => [secret.id, secret],
      ),
    );

    expect(byId[previous.id]?.revokedAt).not.toBeNull();
    expect(byId[rotated.id]?.revokedAt).toBeNull();
    expect(await secretValue(rotated.id)).toBe("rotated");
  });

  test("refuses a previous credential that is already revoked, and stores nothing", async () => {
    const store = createCredentialStore(directory);
    const keyId = `rotation-revoked-${randomUUID()}`;
    const previous = await seeded({
      kind: "model",
      provider: "openai",
      keyId,
      plaintext: "initial",
      revoked: true,
    });

    await expect(
      store.rotate({
        previousCredentialId: previous.id,
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        plaintext: "rotated",
      }),
    ).rejects.toThrow("already revoked");

    expect(
      (await secretsNamed({ kind: "model", provider: "openai", keyId })).map(
        (secret) => secret.id,
      ),
    ).toEqual([previous.id]);
  });

  test("refuses a previous credential that does not exist, and stores nothing", async () => {
    const store = createCredentialStore(directory);
    const missing = randomUUID();
    const keyId = `rotation-missing-${missing}`;

    await expect(
      store.rotate({
        previousCredentialId: missing,
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        plaintext: "orphan-if-broken",
      }),
    ).rejects.toThrow("not found");

    // Nothing was written, so the failed rotation left no credential behind for this key at all.
    expect(
      await secretsNamed({ kind: "model", provider: "openai", keyId }),
    ).toEqual([]);
  });

  test("refuses a rotation aimed at a different kind, provider or keyId", async () => {
    // Rotating one credential with another's identity would retire a secret the caller never named
    // and leave its key with nothing live, which is a worse outcome than a raised error.
    const store = createCredentialStore(directory);
    const suffix = randomUUID();
    const previous = await seeded({
      kind: "model",
      provider: "openai",
      keyId: `mismatch-previous-${suffix}`,
      plaintext: "previous",
    });

    await expect(
      store.rotate({
        previousCredentialId: previous.id,
        kind: "model",
        provider: "openai",
        keyId: `mismatch-input-${suffix}`,
        metadata: {},
        plaintext: "would-retire-the-wrong-secret",
      }),
    ).rejects.toThrow("does not match");

    expect((await storedSecret(previous.id))?.revokedAt).toBeNull();
  });

  test("refuses to revoke a credential that is already revoked", async () => {
    const store = createCredentialStore(directory);
    const { id } = await seeded({
      kind: "model",
      provider: "openai",
      keyId: `revoke-guard-${randomUUID()}`,
      plaintext: "one",
      revoked: true,
    });

    await expect(store.revoke(id)).rejects.toThrow("already revoked");
    // As a refusal the route can answer with a status, not an error it can only pass on as a 500.
    await expect(store.revoke(id)).rejects.toMatchObject({
      name: "CredentialRefusedError",
      status: 404,
    });
  });
});

describe("one live credential per key", () => {
  test("the vault refuses a second live credential for the same key", async () => {
    const keyId = `unique-active-${randomUUID()}`;
    await seeded({
      kind: "model",
      provider: "openai",
      keyId,
      plaintext: "first",
    });

    const second = randomUUID();
    secretIds.push(second);
    await expect(
      directory.createSecret({
        id: second,
        kind: "model",
        provider: "openai",
        keyId,
        ownerUserId: null,
        metadata: {},
        plaintext: "second",
      }),
    ).rejects.toBeInstanceOf(SecretNameTakenError);
    expect(
      (await secretsNamed({ kind: "model", provider: "openai", keyId })).filter(
        (secret) => secret.revokedAt === null,
      ),
    ).toHaveLength(1);
  });

  test("storing a credential for a key that has one replaces it", async () => {
    // The Credentials page offers Add and Revoke and no rotate control, so replacing a key is done
    // by adding one for the same provider and keyId. That has to retire what is there rather than
    // be refused because the name is taken.
    const audited: { eventType: string; targetId?: string }[] = [];
    const service = {
      store: await recordingStore([]),
      auditStore: {
        insert: async (event: { eventType: string; targetId?: string }) => {
          audited.push(event);
        },
      },
    };
    const keyId = `replace-on-add-${randomUUID()}`;

    const first = await createCredential(service, {
      kind: "model",
      provider: "openai",
      keyId,
      metadata: {},
      plaintext: "first-secret",
      actorUserId: "admin",
    });

    const second = await createCredential(service, {
      kind: "model",
      provider: "openai",
      keyId,
      metadata: {},
      plaintext: "second-secret",
      actorUserId: "admin",
    });

    expect(second.id).not.toBe(first.id);
    const byId = Object.fromEntries(
      (await secretsNamed({ kind: "model", provider: "openai", keyId })).map(
        (secret) => [secret.id, secret],
      ),
    );
    expect(byId[first.id]?.revokedAt).not.toBeNull();
    expect(byId[second.id]?.revokedAt).toBeNull();

    // The trail says what happened: an addition, then a replacement naming it.
    expect(audited.map((event) => event.eventType)).toEqual([
      "credential.created",
      "credential.rotated",
    ]);
  });
});

/**
 * The in-place write, which exists for one caller: a connector whose vendor rotates its refresh
 * token on every exchange. Everything else replaces a credential by storing a new one and revoking
 * the old one, because that is the act that has an old grant to withdraw.
 */
describe("credential secret update", () => {
  /** A live `mcp_user_token` secret, which is the only kind this write is for. */
  async function liveCredential(plaintext: string, revoked = false) {
    const secret = await seeded({
      kind: "mcp_user_token",
      provider: "notion",
      keyId: `user-${randomUUID()}`,
      plaintext,
      revoked,
    });
    return secret;
  }

  test("replaces a live secret's value without moving it", async () => {
    const store = createCredentialStore(directory);
    const { id } = await liveCredential("rt-1");

    await store.updateSecret(id, "rt-2");

    // The same secret, addressed by the same id everything else already holds, now carrying the new
    // token — and still live, because nothing about the grant changed.
    expect((await storedSecret(id))?.revokedAt).toBeNull();
    expect(await secretValue(id)).toBe("rt-2");
  });

  test("refuses a revoked secret rather than bringing it back to life", async () => {
    const store = createCredentialStore(directory);
    const seededSecret = await liveCredential("rt-1", true);

    await expect(store.updateSecret(seededSecret.id, "rt-2")).rejects.toThrow(
      "Credential was not found or is revoked",
    );
    // Untouched: a withdrawn grant must not become usable again by being written through.
    const after = await storedSecret(seededSecret.id);
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.version).toBe(seededSecret.version);
  });

  test("refuses a secret that is not there", async () => {
    await expect(
      createCredentialStore(directory).updateSecret(randomUUID(), "rt-2"),
    ).rejects.toThrow("Credential was not found or is revoked");
  });

  /**
   * A write carrying the version its caller read is refused when the secret changed since.
   *
   * A rotating vendor's token used to be written inside the caller's transaction, under a row lock,
   * so two writers could not both believe their token was the current one. No OpenBot transaction
   * can hold the vault, so the guarantee is the version: the second writer, holding what it read
   * before the first one wrote, is refused and the first one's token stands.
   */
  test("refuses a write from a caller holding a version that is no longer current", async () => {
    const store = createCredentialStore(directory);
    const seededSecret = await liveCredential("rt-1");

    const first = await store.updateSecret(
      seededSecret.id,
      "rt-2",
      seededSecret.version,
    );
    await expect(
      store.updateSecret(seededSecret.id, "rt-3", seededSecret.version),
    ).rejects.toThrow();

    expect(await secretValue(seededSecret.id)).toBe("rt-2");
    expect((await storedSecret(seededSecret.id))?.version).toBe(first.version);
  });
});

describe("admin credential API", () => {
  test("returns only credential status and metadata", async () => {
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@openbot.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      {
        list: async () => [
          {
            id: "credential-1",
            kind: "model",
            provider: "openai",
            keyId: "primary",
            metadata: { label: "Production OpenAI" },
            revokedAt: null,
          },
        ],
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/credentials",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credentials: [
        {
          id: "credential-1",
          kind: "model",
          provider: "openai",
          keyId: "primary",
          metadata: { label: "Production OpenAI" },
          revokedAt: null,
        },
      ],
    });
  });

  test("accepts plaintext only on credential creation and returns safe status", async () => {
    const created: unknown[] = [];
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@openbot.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      {
        list: async () => [],
        create: async (input) => {
          created.push(input);
          return {
            id: "credential-1",
            kind: input.kind,
            provider: input.provider,
            keyId: input.keyId,
            metadata: input.metadata,
            revokedAt: null,
          };
        },
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/credentials",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "model",
          provider: "openai",
          keyId: "primary",
          metadata: { label: "Production OpenAI" },
          plaintext: "openai-secret-value",
        }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      credential: {
        id: "credential-1",
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: { label: "Production OpenAI" },
        revokedAt: null,
      },
    });
    expect(created).toEqual([
      {
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: { label: "Production OpenAI" },
        plaintext: "openai-secret-value",
        actorUserId: "admin",
      },
    ]);
  });

  test("rotates and revokes through write-only administrator operations", async () => {
    const calls: string[] = [];
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: "admin", email: "admin@openbot.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      {
        list: async () => [],
        create: async () => {
          throw new Error("not used");
        },
        rotate: async (input) => {
          calls.push(`rotate:${input.previousCredentialId}`);
          return {
            id: "credential-new",
            kind: input.kind,
            provider: input.provider,
            keyId: input.keyId,
            metadata: input.metadata,
            revokedAt: null,
          };
        },
        revoke: async (id) => {
          calls.push(`revoke:${id}`);
          return { id, revokedAt: new Date("2026-08-13T12:00:00.000Z") };
        },
      },
    );

    const rotate = await app.request(
      "http://openbot.local/api/admin/credentials/credential-old/rotate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "model",
          provider: "openai",
          keyId: "secondary",
          metadata: {},
          plaintext: "rotated-secret",
        }),
      },
    );
    const revoke = await app.request(
      "http://openbot.local/api/admin/credentials/credential-new/revoke",
      { method: "POST" },
    );

    expect(rotate.status).toBe(200);
    expect(revoke.status).toBe(200);
    expect(calls).toEqual(["rotate:credential-old", "revoke:credential-new"]);
    expect(await rotate.text()).not.toContain("rotated-secret");
  });
});
