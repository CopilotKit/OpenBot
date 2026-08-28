import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, credentials, users } from "../src/db/schema";

/**
 * Editing a Bot's key, against a real database.
 *
 * The rotation tests elsewhere hand `storeAgentAuth` a fake store, which can answer any call
 * instantly and holds no locks. That is enough to prove which vault call is made and useless for
 * proving the call can be made at all: every failure this file exists to catch is a lock taken by
 * one connection and waited for by another, and a fake has neither.
 *
 * The pool is pinned to one connection deliberately. A second vault write on its own connection is
 * a second session competing with the transaction the edit is already inside, and at `max: 1` it
 * cannot even be handed a connection until that transaction ends — which it never will, because the
 * transaction is awaiting the call. The edit hangs until something times it out. At the driver's
 * default pool the same shape survives as a row-lock wait instead, slower to hit and identical in
 * effect, so one connection is the honest setting for the question being asked.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  { max: 1 },
);

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const store = createCredentialStore(database);
const profiles = createAgentProfileStore(database, undefined, {
  store,
  encryptionKey,
});

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

async function liveKeysFor(agentId: string) {
  return database
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(
        eq(credentials.kind, "agent"),
        eq(credentials.keyId, agentId),
        isNull(credentials.revokedAt),
      ),
    );
}

beforeAll(async () => {
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
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, created));
    await database.delete(agents).where(inArray(agents.id, created));
    await database
      .delete(credentials)
      .where(inArray(credentials.keyId, created));
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
    const rows = await database
      .select({ id: credentials.id, revokedAt: credentials.revokedAt })
      .from(credentials)
      .where(
        and(eq(credentials.kind, "agent"), eq(credentials.keyId, agentId)),
      );

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
