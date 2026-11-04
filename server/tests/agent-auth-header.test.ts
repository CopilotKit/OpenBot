import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { storeAgentAuth } from "../src/agents/auth-header";
import {
  purgeSecrets,
  recordingCredentialStore,
  secretValue,
  seedCredential,
  storedSecret,
} from "./support/vault";

/**
 * An agent already has a credential when its bearer token is being edited.
 * The vault refuses two live secrets for the same agent, so the edit path has
 * to rotate the vault secret rather than store a duplicate. These tests pin
 * which method the module reaches for in each case, against the real vault.
 */

const created: string[] = [];

afterAll(async () => {
  await purgeSecrets(created.splice(0));
});

describe("storeAgentAuth", () => {
  async function agentCredential(agentId: string, revoked = false) {
    const secret = await seedCredential({
      kind: "agent",
      provider: "ag-ui",
      keyId: agentId,
      metadata: { header: "Authorization" },
      plaintext: "Bearer old",
      revoked,
    });
    created.push(secret.id);
    return secret;
  }

  test("creates a fresh credential when the agent has none yet", async () => {
    const calls: string[] = [];
    const agentId = `agent-${randomUUID()}`;

    const auth = await storeAgentAuth({
      store: await recordingCredentialStore({ calls, created }),
      agentId,
      header: "Authorization",
      value: "Bearer abc",
    });

    expect(calls).toEqual(["create"]);
    expect(auth).toEqual({
      header: "Authorization",
      credentialId: expect.any(String),
    });
    expect(await secretValue(auth.credentialId)).toBe("Bearer abc");
  });

  test("rotates the credential the agent already holds", async () => {
    const calls: string[] = [];
    const agentId = `agent-${randomUUID()}`;
    const old = await agentCredential(agentId);

    const auth = await storeAgentAuth({
      store: await recordingCredentialStore({ calls, created }),
      agentId,
      header: "Authorization",
      value: "Bearer new",
      previousCredentialId: old.id,
    });

    expect(calls).toEqual([`rotate:${old.id}`]);
    const rotated = await storedSecret(auth.credentialId);
    expect(rotated).toMatchObject({
      replaces: old.id,
      kind: "agent",
      keyId: agentId,
      revokedAt: null,
    });
    expect((await storedSecret(old.id))?.revokedAt).not.toBeNull();
    // The value is the vault's to hold: nothing it hands back about the secret carries it.
    expect(JSON.stringify(rotated)).not.toContain("Bearer new");
    expect(await secretValue(auth.credentialId)).toBe("Bearer new");
  });

  test("creates when the credential the agent names has been revoked", async () => {
    // An administrator can revoke an agent's key from the Credentials page,
    // and nothing repoints the agent's configuration when they do. Rotating
    // onto that revoked secret is refused by the vault, so trusting the reference
    // would leave the key impossible to replace: every later edit would fail
    // on the same stale id.
    const calls: string[] = [];
    const agentId = `agent-${randomUUID()}`;
    const revoked = await agentCredential(agentId, true);

    const auth = await storeAgentAuth({
      store: await recordingCredentialStore({ calls, created }),
      agentId,
      header: "Authorization",
      value: "Bearer replacement",
      previousCredentialId: revoked.id,
    });

    expect(calls).toEqual(["create"]);
    expect(auth.credentialId).not.toBe(revoked.id);
    expect(await secretValue(auth.credentialId)).toBe("Bearer replacement");
  });
});
