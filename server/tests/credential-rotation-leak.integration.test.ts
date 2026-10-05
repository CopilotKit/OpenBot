import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import {
  createCredentialStore,
  encryptSecret,
  rotateCredential,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { auditEvents, credentials } from "../src/db/schema";
import { deploymentFaultSentence } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What a refused rotation is allowed to write down, against a real vault.
 *
 * A stubbed store cannot answer this. The thing that leaks is `DrizzleQueryError`, and only a
 * database produces one: its `message` is `Failed query: <the statement>` followed by `params:` and
 * every value bound to it, and on the rotation path one of those values is the encrypted credential
 * envelope itself. A hand-thrown `Error` whose message the test chose would prove nothing, because
 * the message this test is about is one drizzle writes.
 *
 * `audit_events` is append-only by trigger, exported, and kept for the whole retention window, so a
 * secret written here is not one anybody can take back out.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const store = createCredentialStore(database);
const service = {
  encryptionKey: ENCRYPTION_KEY,
  store,
  auditStore: createAuditStore(database),
};

/**
 * A character `jsonb` will not take, which is how this test reaches a real failed insert.
 *
 * Written as a code point rather than typed into the source, because a literal U+0000 in a
 * TypeScript file is a byte that makes the file binary to half the tools that read it.
 *
 * WHY THIS FAILURE AND NOT A DUPLICATE KEY. `credentials_active_key_idx` cannot be violated from
 * inside `rotate`: the transaction revokes the one live row for the key before inserting the new
 * one, and the index guarantees there was only ever that one. A value Postgres refuses to store is
 * the failure that reaches this insert with the envelope already bound to it. The duplicate key is
 * exercised below for what it says rather than for where it happens.
 */
const NUL = String.fromCharCode(0);

const created: string[] = [];

async function liveCredential(keyId: string, secret: string) {
  const credential = await store.create({
    kind: "model",
    provider: "openai",
    keyId,
    metadata: {},
    encryptedValue: await encryptSecret(ENCRYPTION_KEY, secret),
  });
  created.push(credential.id);
  return credential;
}

async function refusalReason(targetId: string) {
  const [event] = await database
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "credential.rotation_refused"),
        eq(auditEvents.targetId, targetId),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);

  return (event?.payload as { reason?: string } | undefined)?.reason;
}

afterAll(async () => {
  // Only the rows this file inserted, named by id. The trail itself is append-only and stays.
  for (const id of created.splice(0)) {
    await database.delete(credentials).where(eq(credentials.id, id));
  }
});

describe("a rotation the database refuses", () => {
  test("records the driver's complaint and never the statement it was bound to", async () => {
    const keyId = `rotation-leak-sentinel-${randomUUID()}`;
    const previous = await liveCredential(keyId, "old-openai-secret");

    await expect(
      rotateCredential(service, {
        previousCredentialId: previous.id,
        kind: "model",
        provider: "openai",
        keyId,
        // Refused by `jsonb`, so the insert fails with the envelope already bound to it.
        metadata: { note: NUL },
        plaintext: "new-openai-secret",
        actorUserId: "admin",
      }),
    ).rejects.toThrow();

    const reason = await refusalReason(previous.id);

    expect(reason).toBeString();
    // The bound values, in the order the insert binds them: the key this rotation names, and the
    // envelope holding the new secret. Neither may be in a row nobody can delete.
    expect(reason).not.toContain(keyId);
    expect(reason).not.toContain("ciphertext");
    expect(reason).not.toContain("Failed query");
    expect(reason).not.toContain("params:");
    // And the half that is worth keeping is still there.
    expect(reason).toContain("unsupported Unicode escape sequence");
  });

  test("still records the vault's own sentence when the vault, not the database, refused", async () => {
    // A refusal that is not a query failure must come through untouched: the message is the whole
    // of what the row has to say, and scrubbing it would trade a leak for a trail nobody can read.
    const keyId = `rotation-refused-${randomUUID()}`;
    const previous = await liveCredential(keyId, "old-openai-secret");
    await store.revoke(previous.id);

    await expect(
      rotateCredential(service, {
        previousCredentialId: previous.id,
        kind: "model",
        provider: "openai",
        keyId,
        metadata: {},
        plaintext: "new-openai-secret",
        actorUserId: "admin",
      }),
    ).rejects.toThrow("Previous credential is already revoked");

    expect(await refusalReason(previous.id)).toBe(
      "Previous credential is already revoked",
    );
  });

  test("keeps a unique violation's constraint name while dropping the row it was bound to", async () => {
    // The inverse, on the failure an operator most often has to act on. Produced by a real
    // duplicate insert rather than described, because `duplicate key value violates unique
    // constraint "credentials_active_key_idx"` is a sentence Postgres writes and this file does not.
    const keyId = `duplicate-key-sentinel-${randomUUID()}`;
    await liveCredential(keyId, "first-openai-secret");

    const failure = await liveCredential(keyId, "second-openai-secret").then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const sentence = deploymentFaultSentence(failure as Error);
    expect(sentence).toContain(
      'duplicate key value violates unique constraint "credentials_active_key_idx"',
    );
    expect(sentence).not.toContain(keyId);
    expect(sentence).not.toContain("ciphertext");
  });
});
