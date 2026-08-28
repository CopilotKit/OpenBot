import { describe, expect, test } from "bun:test";
import { storeAgentAuth } from "../src/agents/auth-header";
import type { CredentialStore } from "../src/credentials";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * An agent already has a credential when its bearer token is being edited.
 * `credentials_active_key_idx` refuses two live rows for the same agent, so
 * the edit path has to rotate the vault row rather than insert a duplicate.
 * These tests pin which method the module reaches for in each case.
 */

describe("storeAgentAuth", () => {
  function fakeStore(options: {
    live?: Set<string>;
    calls: string[];
    rotated?: unknown[];
  }): CredentialStore {
    const live = options.live ?? new Set<string>();
    return {
      create: async () => {
        options.calls.push("create");
        return { id: "credential-new", revokedAt: null };
      },
      rotate: async (input) => {
        options.calls.push("rotate");
        options.rotated?.push(input);
        return { id: "credential-rotated", revokedAt: null };
      },
      revoke: async () => new Date(),
      isLive: async (id) => live.has(id),
      findLiveByKey: async () => null,
    };
  }

  test("creates a fresh credential when the agent has none yet", async () => {
    const calls: string[] = [];

    const auth = await storeAgentAuth({
      store: fakeStore({ calls }),
      encryptionKey: key,
      agentId: "agent-1",
      header: "Authorization",
      value: "Bearer abc",
    });

    expect(calls).toEqual(["create"]);
    expect(auth).toEqual({
      header: "Authorization",
      credentialId: "credential-new",
    });
  });

  test("rotates the credential the agent already holds", async () => {
    const calls: string[] = [];
    const rotated: unknown[] = [];

    const auth = await storeAgentAuth({
      store: fakeStore({ calls, rotated, live: new Set(["credential-old"]) }),
      encryptionKey: key,
      agentId: "agent-1",
      header: "Authorization",
      value: "Bearer new",
      previousCredentialId: "credential-old",
    });

    expect(calls).toEqual(["rotate"]);
    const [call] = rotated as [
      { previousCredentialId: string; kind: string; keyId: string },
    ];
    expect(call.previousCredentialId).toBe("credential-old");
    expect(call.kind).toBe("agent");
    expect(call.keyId).toBe("agent-1");
    expect(JSON.stringify(rotated)).not.toContain("Bearer new");
    expect(auth.credentialId).toBe("credential-rotated");
  });

  test("creates when the credential the agent names has been revoked", async () => {
    // An administrator can revoke an agent's key from the Credentials page,
    // and nothing repoints the agent's configuration when they do. Rotating
    // onto that revoked row is refused by the vault, so trusting the reference
    // would leave the key impossible to replace: every later edit would fail
    // on the same stale id.
    const calls: string[] = [];

    const auth = await storeAgentAuth({
      store: fakeStore({ calls, live: new Set() }),
      encryptionKey: key,
      agentId: "agent-1",
      header: "Authorization",
      value: "Bearer replacement",
      previousCredentialId: "credential-revoked",
    });

    expect(calls).toEqual(["create"]);
    expect(auth.credentialId).toBe("credential-new");
  });
});
