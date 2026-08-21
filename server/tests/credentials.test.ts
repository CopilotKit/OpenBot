import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  createCredential,
  createCredentialStore,
  decryptCredentialForUse,
  decryptSecret,
  encryptSecret,
  resolveModelApiKey,
  revokeCredential,
  rotateCredential,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import { credentials } from "../src/db/schema";
import { testEnvironment } from "./support/environment";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const config = loadConfig(testEnvironment({ KEY_ENCRYPTION_KEY: key }));
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const credentialIds: string[] = [];

afterEach(async () => {
  for (const credentialId of credentialIds.splice(0)) {
    await database.delete(credentials).where(eq(credentials.id, credentialId));
  }
});

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
    const stored: unknown[] = [];
    const audited: unknown[] = [];

    const credential = await createCredential(
      {
        encryptionKey: key,
        store: {
          create: async (value) => {
            stored.push(value);
            return { id: "credential-1", revokedAt: null };
          },
          revoke: async () => new Date(),
        },
        auditStore: {
          insert: async (event) => {
            audited.push(event);
          },
        },
      },
      {
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: { label: "Production OpenAI" },
        plaintext: "openai-secret-value",
        actorUserId: "admin",
      },
    );

    expect(credential).toEqual({
      id: "credential-1",
      kind: "model",
      provider: "openai",
      keyId: "primary",
      metadata: { label: "Production OpenAI" },
      revokedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain("openai-secret-value");
    expect(audited).toEqual([
      {
        eventType: "credential.created",
        targetType: "credential",
        targetId: "credential-1",
        actorUserId: "admin",
        payload: {
          kind: "model",
          provider: "openai",
          keyId: "primary",
        },
      },
    ]);
  });

  test("rotates then revokes credentials without returning plaintext", async () => {
    const rotated: { previousCredentialId: string }[] = [];
    const revoked: string[] = [];
    const audited: unknown[] = [];
    const service = {
      encryptionKey: key,
      store: {
        create: async () => ({ id: "credential-unused", revokedAt: null }),
        rotate: async (input: { previousCredentialId: string }) => {
          rotated.push(input);
          return { id: "credential-new", revokedAt: null };
        },
        revoke: async (id: string) => {
          revoked.push(id);
          return new Date("2026-08-13T12:00:00.000Z");
        },
      },
      auditStore: {
        insert: async (event: unknown) => {
          audited.push(event);
        },
      },
    };

    await rotateCredential(service, {
      previousCredentialId: "credential-old",
      kind: "model",
      provider: "openai",
      keyId: "secondary",
      metadata: { label: "Rotated OpenAI" },
      plaintext: "new-openai-secret",
      actorUserId: "admin",
    });
    await revokeCredential(service, "credential-new", "admin");

    // The rotation retires the previous credential inside the store's own
    // transaction, so the service makes no separate revoke call of its own.
    expect(rotated.map((call) => call.previousCredentialId)).toEqual([
      "credential-old",
    ]);
    expect(revoked).toEqual(["credential-new"]);
    expect(JSON.stringify(rotated)).not.toContain("new-openai-secret");
    expect(JSON.stringify(audited)).not.toContain("new-openai-secret");
    expect(
      audited.map((event) => (event as { eventType: string }).eventType),
    ).toEqual(["credential.rotated", "credential.revoked"]);
  });

  test("writes no audit event when the rotation fails", async () => {
    // The store's rotate is one transaction, so a failure commits nothing. The
    // trail has to agree: a rotation that did not happen leaves no row saying
    // it did, and the caller sees the original cause rather than a later one.
    const audited: unknown[] = [];
    const service = {
      encryptionKey: key,
      store: {
        create: async () => {
          throw new Error("create is not part of a rotation");
        },
        rotate: async () => {
          throw new Error("Previous credential is already revoked");
        },
        revoke: async () => {
          throw new Error("revoke is not part of a failed rotation");
        },
      },
      auditStore: {
        insert: async (event: unknown) => {
          audited.push(event);
        },
      },
    };

    await expect(
      rotateCredential(service, {
        previousCredentialId: "credential-old",
        kind: "model",
        provider: "openai",
        keyId: "primary",
        metadata: {},
        plaintext: "new-openai-secret",
        actorUserId: "admin",
      }),
    ).rejects.toThrow("Previous credential is already revoked");

    expect(audited).toEqual([]);
  });

  test("decrypts only an active credential for server-side use", async () => {
    const encryptedValue = await encryptSecret(key, "connector-secret");

    await expect(
      decryptCredentialForUse(
        key,
        { readSecret: async () => ({ encryptedValue, revokedAt: null }) },
        "credential-1",
      ),
    ).resolves.toBe("connector-secret");
    await expect(
      decryptCredentialForUse(
        key,
        { readSecret: async () => ({ encryptedValue, revokedAt: new Date() }) },
        "credential-1",
      ),
    ).rejects.toThrow("Credential is revoked");
  });
});

describe("model credential resolution", () => {
  test("prefers a stored model credential over the environment", async () => {
    const encryptedValue = await encryptSecret(key, "stored-openai-key");

    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: {
          readModelSecret: async () => ({ encryptedValue }),
        },
        provider: "openai",
        keyId: "openai-api-key",
        environment: { OPENAI_API_KEY: "environment-openai-key" },
      }),
    ).resolves.toBe("stored-openai-key");
  });

  test("uses OPENAI_API_KEY when no stored credential exists", async () => {
    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: { readModelSecret: async () => null },
        provider: "openai",
        keyId: "openai-api-key",
        environment: { OPENAI_API_KEY: " environment-openai-key " },
      }),
    ).resolves.toBe("environment-openai-key");
  });

  test("returns null when neither credential source is configured", async () => {
    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: { readModelSecret: async () => null },
        provider: "openai",
        keyId: "openai-api-key",
        environment: {},
      }),
    ).resolves.toBeNull();
  });

  test("rejects corrupt stored ciphertext instead of falling back to the environment", async () => {
    await expect(
      resolveModelApiKey({
        encryptionKey: key,
        reader: {
          readModelSecret: async () => ({ encryptedValue: "corrupt" }),
        },
        provider: "openai",
        keyId: "openai-api-key",
        environment: { OPENAI_API_KEY: "environment-openai-key" },
      }),
    ).rejects.toThrow("Credential envelope is invalid");
  });
});

describe("model credential store lookup", () => {
  test("selects the newest active matching model credential with id as the timestamp tie-breaker", async () => {
    const matchingOldId = randomUUID();
    const matchingLowerId = "00000000-0000-4000-8000-000000000001";
    const matchingHigherId = "00000000-0000-4000-8000-000000000002";
    const ignoredIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const allIds = [
      matchingOldId,
      matchingLowerId,
      matchingHigherId,
      ...ignoredIds,
    ];
    credentialIds.push(...allIds);

    await database.insert(credentials).values([
      {
        id: matchingOldId,
        kind: "model",
        provider: "openai",
        keyId: "openai-api-key",
        encryptedValue: "old-matching-value",
        metadata: {},
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: matchingLowerId,
        kind: "model",
        provider: "openai",
        keyId: "openai-api-key",
        encryptedValue: "lower-id-value",
        metadata: {},
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
      {
        id: matchingHigherId,
        kind: "model",
        provider: "openai",
        keyId: "openai-api-key",
        encryptedValue: "higher-id-value",
        metadata: {},
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
      {
        id: ignoredIds[0]!,
        kind: "connector",
        provider: "openai",
        keyId: "openai-api-key",
        encryptedValue: "wrong-kind-value",
        metadata: {},
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        id: ignoredIds[1]!,
        kind: "model",
        provider: "other",
        keyId: "openai-api-key",
        encryptedValue: "wrong-provider-value",
        metadata: {},
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        id: ignoredIds[2]!,
        kind: "model",
        provider: "openai",
        keyId: "other-api-key",
        encryptedValue: "wrong-key-value",
        metadata: {},
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        id: ignoredIds[3]!,
        kind: "model",
        provider: "openai",
        keyId: "openai-api-key",
        encryptedValue: "revoked-value",
        metadata: {},
        revokedAt: new Date("2026-03-01T00:00:00.000Z"),
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);

    await expect(
      createCredentialStore(database).readModelSecret({
        provider: "openai",
        keyId: "openai-api-key",
      }),
    ).resolves.toEqual({ encryptedValue: "higher-id-value" });
  });
});

describe("credential store rotation", () => {
  test("retires the previous credential and stores the new one together", async () => {
    const store = createCredentialStore(database);
    const previousId = randomUUID();
    const keyId = `rotation-atomic-${previousId}`;
    credentialIds.push(previousId);
    await database.insert(credentials).values({
      id: previousId,
      kind: "model",
      provider: "openai",
      keyId,
      encryptedValue: "initial",
      metadata: {},
    });

    const rotated = await store.rotate({
      previousCredentialId: previousId,
      kind: "model",
      provider: "openai",
      keyId,
      metadata: {},
      encryptedValue: "rotated",
    });
    credentialIds.push(rotated.id);

    const rows = await database
      .select({
        id: credentials.id,
        encryptedValue: credentials.encryptedValue,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(eq(credentials.keyId, keyId));
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    expect(byId[previousId]?.revokedAt).not.toBeNull();
    expect(byId[rotated.id]?.revokedAt).toBeNull();
    expect(byId[rotated.id]?.encryptedValue).toBe("rotated");
  });

  test("refuses a previous credential that is already revoked, and stores nothing", async () => {
    const store = createCredentialStore(database);
    const previousId = randomUUID();
    const keyId = `rotation-revoked-${previousId}`;
    credentialIds.push(previousId);
    await database.insert(credentials).values({
      id: previousId,
      kind: "model",
      provider: "openai",
      keyId,
      encryptedValue: "initial",
      metadata: {},
      revokedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    await expect(
      store.rotate({
        previousCredentialId: previousId,
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        encryptedValue: "rotated",
      }),
    ).rejects.toThrow("already revoked");

    const rows = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(eq(credentials.keyId, keyId));
    expect(rows.map((row) => row.id)).toEqual([previousId]);
  });

  test("refuses a previous credential that does not exist, and stores nothing", async () => {
    const store = createCredentialStore(database);
    const missing = randomUUID();
    const keyId = `rotation-missing-${missing}`;

    await expect(
      store.rotate({
        previousCredentialId: missing,
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        encryptedValue: "orphan-if-broken",
      }),
    ).rejects.toThrow("not found");

    // Nothing was written, so the failed rotation left no credential behind
    // for this key at all.
    const rows = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(eq(credentials.keyId, keyId));
    expect(rows).toEqual([]);
  });

  test("refuses a rotation aimed at a different kind, provider or keyId", async () => {
    // Rotating one credential with another's identity would retire a secret
    // the caller never named and leave its key with nothing live, which is a
    // worse outcome than a raised error.
    const store = createCredentialStore(database);
    const previousId = randomUUID();
    const previousKey = `mismatch-previous-${previousId}`;
    credentialIds.push(previousId);
    await database.insert(credentials).values({
      id: previousId,
      kind: "model",
      provider: "openai",
      keyId: previousKey,
      encryptedValue: "previous",
      metadata: {},
    });

    await expect(
      store.rotate({
        previousCredentialId: previousId,
        kind: "model",
        provider: "openai",
        keyId: `mismatch-input-${previousId}`,
        metadata: {},
        encryptedValue: "would-retire-the-wrong-secret",
      }),
    ).rejects.toThrow("does not match");

    const [after] = await database
      .select({ revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(eq(credentials.id, previousId));
    expect(after?.revokedAt).toBeNull();
  });

  test("refuses to revoke a credential that is already revoked", async () => {
    const store = createCredentialStore(database);
    const id = randomUUID();
    credentialIds.push(id);
    await database.insert(credentials).values({
      id,
      kind: "model",
      provider: "openai",
      keyId: `revoke-guard-${id}`,
      encryptedValue: "one",
      metadata: {},
      revokedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    await expect(store.revoke(id)).rejects.toThrow("already revoked");
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
