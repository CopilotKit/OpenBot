import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  type AgentProfileStore,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { removeBots, useTestBots } from "./support/bots";
import { testDatabaseUrl } from "./support/database";
import {
  liveSecrets,
  purgeSecrets,
  secretsNamed,
  useTestVault,
} from "./support/vault";

/**
 * Editing a Bot's key, against a real database and the real vault.
 *
 * Proving which vault call is made is not enough; this file proves the call can be made at all from
 * where the edit makes it. The key is a secret in Intelligence's vault, and no OpenBot transaction
 * may be held open across a call to it.
 *
 * The pool is pinned to one connection deliberately. An edit that held a transaction open across the
 * vault call would hold the only connection while it waits, and any query the edit or the store makes
 * on the way cannot even be handed a connection until that transaction ends, which it never will,
 * because the transaction is awaiting the call. The edit hangs until something times it out. At the
 * driver's default pool the same shape survives as a row-lock wait instead, slower to hit and
 * identical in effect, so one connection is the honest setting for the question being asked. The Bot
 * itself is written to Intelligence, so an edit has no reason to hold a transaction across either
 * write; this file is what says so if one ever does again.
 */

const database = createDatabase(testDatabaseUrl(), { max: 1 });

let profiles: AgentProfileStore;

const suite = randomUUID().slice(0, 8);
const actor: AgentActor = { id: `user_${suite}`, role: "admin" };
const created: string[] = [];

/** An edit that hangs is the failure, so the wait is bounded and the bound is the assertion. */
const DEADLINE_MS = 5_000;

async function within<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} did not return within ${DEADLINE_MS}ms, which is what a vault write on a second connection looks like from inside the transaction that is holding the only one`,
          ),
        ),
      DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The live keys the vault holds for this Bot, as Intelligence holds them now. */
async function liveKeysFor(agentId: string) {
  return liveSecrets({ kind: "agent", provider: "ag-ui", keyId: agentId });
}

beforeAll(async () => {
  await useTestBots();
  profiles = createAgentProfileStore(database, undefined, {
    store: createCredentialStore(await useTestVault()),
  });
  await database.insert(users).values({
    id: actor.id,
    email: `${actor.id}@openbot.test`,
    name: "Key rotation tester",
    emailVerified: true,
  });

  const profile = await profiles.create(actor, {
    name: `key rotation ${suite}`,
    title: "Tester",
    roleDescription: "Holds a key that gets replaced.",
    visibility: "private",
    endpoint: "https://example.invalid/agent",
    auth: { header: "Authorization", value: "first-secret" },
  });
  created.push(profile.id);
});

afterAll(async () => {
  if (created.length) {
    await removeBots(created);
    for (const agentId of created)
      await purgeSecrets(
        (await secretsNamed({ kind: "agent", keyId: agentId })).map(
          (secret) => secret.id,
        ),
      );
  }
  await database.delete(users).where(eq(users.id, actor.id));
  await database.$client.end();
});

describe("editing a Bot's key", () => {
  test("returns, and leaves exactly one live credential", async () => {
    const [agentId] = created;
    expect(await liveKeysFor(agentId)).toHaveLength(1);
    const [before] = await liveKeysFor(agentId);

    await within(
      "the edit",
      profiles.update(actor, agentId, {
        name: `key rotation ${suite}`,
        title: "Tester",
        roleDescription: "Holds a key that gets replaced.",
        visibility: "private",
        endpoint: "https://example.invalid/agent",
        auth: { header: "Authorization", value: "second-secret" },
      }),
    );

    const live = await liveKeysFor(agentId);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(before?.id);
  });

  test("the credential it replaced is revoked, not merely unreferenced", async () => {
    const [agentId] = created;
    const rows = await secretsNamed({
      kind: "agent",
      provider: "ag-ui",
      keyId: agentId,
    });

    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
    expect(rows.filter((row) => row.revokedAt !== null)).toHaveLength(1);
  });

  test("deleting the Bot retires the key it was still holding", async () => {
    const profile = await profiles.create(actor, {
      name: `key deletion ${suite}`,
      title: "Tester",
      roleDescription: "Holds a key until it is deleted.",
      visibility: "private",
      endpoint: "https://example.invalid/agent",
      auth: { header: "Authorization", value: "only-secret" },
    });
    created.push(profile.id);

    expect(await liveKeysFor(profile.id)).toHaveLength(1);
    await within("the deletion", profiles.softDelete(actor, profile.id));
    expect(await liveKeysFor(profile.id)).toHaveLength(0);
  });
});
