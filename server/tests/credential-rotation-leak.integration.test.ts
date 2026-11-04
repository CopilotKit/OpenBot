import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAuditStore } from "../src/audit";
import { createCredentialStore, rotateCredential } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { deploymentFaultSentence } from "../src/plugins/store";
import { SecretNameTakenError } from "../src/vault/client";
import { auditRows, useTestAuditTrail } from "./support/audit";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { purgeSecrets, useTestVault } from "./support/vault";

/**
 * What a refused rotation is allowed to write down, against a real vault.
 *
 * A stubbed store cannot answer this. The thing that could leak is the failure the vault's own
 * service raises, whose message this file does not write: the rotation sends the new secret's value
 * and its name, and a refusal that quoted the request would carry both. A hand-thrown `Error` whose
 * message the test chose would prove nothing, because the message this test is about is one the
 * real service produces.
 *
 * The audit trail is append-only, held in Intelligence, exported, and kept for the whole retention
 * window, so a secret written here is not one anybody can take back out.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
useTestAuditTrail();

let store: ReturnType<typeof createCredentialStore>;
let service: {
  store: ReturnType<typeof createCredentialStore>;
  auditStore: ReturnType<typeof createAuditStore>;
};

beforeAll(async () => {
  store = createCredentialStore(await useTestVault());
  service = { store, auditStore: createAuditStore(database) };
});

/**
 * A character `jsonb` will not take, which is how this test reaches a real failed write in the vault:
 * Intelligence keeps a secret's metadata in `jsonb`, and the value it was asked to store travels in
 * the same request.
 *
 * Written as a code point rather than typed into the source, because a literal U+0000 in a
 * TypeScript file is a byte that makes the file binary to half the tools that read it.
 */
const NUL = String.fromCharCode(0);

const created: string[] = [];

async function liveCredential(keyId: string, secret: string) {
  const credential = await store.create({
    kind: "model",
    provider: "openai",
    keyId,
    metadata: {},
    plaintext: secret,
  });
  created.push(credential.id);
  return credential;
}

async function refusalReason(targetId: string) {
  // Newest first, as the helper answers.
  const [event] = await auditRows({
    eventType: "credential.rotation_refused",
    targetId,
  });

  return (event?.payload as { reason?: string } | undefined)?.reason;
}

afterAll(async () => {
  // Only the secrets this file stored, named by id. The trail itself is append-only and stays.
  await purgeSecrets(created.splice(0));
});

describe("a rotation the vault refuses", () => {
  test("records the service's complaint and never the value or the name it was sent", async () => {
    const keyId = `rotation-leak-sentinel-${randomUUID()}`;
    const previous = await liveCredential(keyId, "old-openai-secret");

    const failure = await rotateCredential(service, {
      previousCredentialId: previous.id,
      kind: "model",
      provider: "openai",
      keyId,
      // Refused by `jsonb` in Intelligence, so the write fails with the new value in the request.
      metadata: { note: NUL },
      plaintext: "new-openai-secret",
      actorUserId: "admin",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);

    const reason = await refusalReason(previous.id);

    expect(reason).toBeString();
    // What the rotation sent: the key it names, and the new secret. Neither may be in a row nobody
    // can delete.
    expect(reason).not.toContain(keyId);
    expect(reason).not.toContain("new-openai-secret");
    expect(reason).not.toContain("Failed query");
    expect(reason).not.toContain("params:");
    // And the half that is worth keeping is still there: the service's own sentence.
    expect(reason).toBe((failure as Error).message);
    expect(reason).toContain("Intelligence refused to store a secret");
    // The previous key was not retired by a rotation that failed.
    expect(await store.isLive(previous.id)).toBe(true);
  });

  test("still records the vault's own sentence when the vault refused the rotation itself", async () => {
    // A refusal that is not a service failure must come through untouched: the message is the whole
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

  test("keeps the vault's one-live-key refusal while dropping the value it was sent", async () => {
    // The inverse, on the failure an operator most often has to act on. Produced by a real second
    // store of a live name rather than described, because the refusal is a sentence the vault
    // client writes from Intelligence's answer and this file does not.
    const keyId = `duplicate-key-sentinel-${randomUUID()}`;
    await liveCredential(keyId, "first-openai-secret");

    const failure = await liveCredential(keyId, "second-openai-secret").then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SecretNameTakenError);
    const sentence = deploymentFaultSentence(failure as Error);
    expect(sentence).toContain(
      "A live secret already holds this kind, provider, name and owner",
    );
    expect(sentence).not.toContain(keyId);
    expect(sentence).not.toContain("second-openai-secret");
  });
});

afterAll(async () => {
  await database.$client.close();
});
