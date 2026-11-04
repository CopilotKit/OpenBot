// server/tests/person-purge-cascade.integration.test.ts
//
// A person deleted for good takes what Intelligence holds of them beyond the directory.
//
// Their row in `users` used to take, by `ON DELETE CASCADE`, their memories and memory sources, their
// Learning space and thread containers, their routines, and the sign-in accounts whose secrets are the
// vault's now. Those moved into Intelligence beside the
// directory, so nothing cascades there any more: the people directory tells its listeners instead,
// and the server's listener (people/purge-cascade.ts) removes them. Both ways a person goes for good
// are driven here, against a real Intelligence: purged through the directory, and purged elsewhere
// (another replica, SCIM) and found gone by this one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { idempotencyKey } from "../src/people/directory/client";
import type { PeopleDirectory } from "../src/people/directory/directory";
import { storeSignInSecret } from "../src/auth/sign-in-secrets";
import { createPersonPurgeCascade } from "../src/people/purge-cascade";
import type { ConnectionsDirectory } from "../src/vault/directory";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { directoryFor, uniqueEmail } from "./support/directory";
import { testLearningIntelligence } from "./support/learning";
import { removeTestMemory, testMemory } from "./support/memory";
import {
  purgeRoutinesOwnedBy,
  seedRoutine,
  testScheduleClient,
  useTestSchedules,
} from "./support/schedules";
import { useTestVault } from "./support/vault";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const memory = testMemory(database);
const learning = testLearningIntelligence();
const run = randomUUID().slice(0, 8);
const made: string[] = [];
let people: PeopleDirectory;
let vault: ConnectionsDirectory;

beforeAll(async () => {
  await useTestSchedules();
  vault = await useTestVault();
  people = directoryFor(database);
  await people.onPurged(
    createPersonPurgeCascade({
      memory: memory.store,
      learning,
      schedules: testScheduleClient(),
      vault,
    }),
  );
});

afterAll(async () => {
  // Whatever a failing case left behind, removed here so the next run starts clean.
  await removeTestMemory(made);
  for (const id of made) {
    await purgeRoutinesOwnedBy(id);
    await learning.purgePersonalSpace(id).catch(() => undefined);
    await learning.deleteThreadAssignments(id).catch(() => undefined);
  }
  await database.delete(users).where(inArray(users.id, made));
  await database.$client.close();
});

/**
 * A person in the directory, with a memory, a memory source, a Learning space and thread, a routine,
 * and the password hash their sign-in account names.
 */
async function personWithEverything(label: string) {
  const person = await people.create({
    id: `purge-${label}-${run}`,
    email: uniqueEmail(`purge-${label}`),
    name: "Leaving Person",
    image: null,
    emailVerified: true,
    role: "user",
  });
  made.push(person.id);
  await memory.intelligence.createMemory(person.id, {
    content: "Prefers the morning standup",
    provenance: "You",
    formedBy: "person",
  });
  await memory.intelligence.createSource({
    userId: person.id,
    agentId: `bot-${run}`,
    connectorRef: "docs/read",
    title: "Docs",
  });
  await learning.confirmPersonalSpace(person.id, `container-${person.id}`);
  await learning.assignThread({
    threadId: `thread-${person.id}`,
    appUserId: person.id,
    agentId: `bot-${run}`,
    learningContainerId: null,
  });
  await seedRoutine({
    ownerUserId: person.id,
    agentId: `bot-${run}`,
    channelId: `channel-${person.id}`,
  });
  await storeSignInSecret(
    vault,
    "account",
    "password",
    { userId: person.id, providerId: "credential" },
    "$scrypt$hash",
  );
  return person;
}

/** What Intelligence holds of them beyond the directory, read past every cache. */
async function heldFor(userId: string) {
  return {
    memories: (await memory.intelligence.allMemories(userId)).length,
    sources: (await memory.intelligence.sources({ userId })).length,
    spaceVersion: (await learning.personalSpace(userId)).version,
    threads: (await learning.threadAssignments(userId)).length,
    routines: (
      await testScheduleClient().all("routines", {
        ownerUserId: userId,
        includeDeleted: true,
      })
    ).items.length,
    signInSecrets: (
      await vault.client.secrets.all({
        includeRevoked: true,
        ownerUserId: userId,
      })
    ).secrets.length,
  };
}

const NOTHING = {
  memories: 0,
  sources: 0,
  spaceVersion: 0,
  threads: 0,
  routines: 0,
  signInSecrets: 0,
};

describe("a person deleted for good", () => {
  test("through the directory takes their memory, Learning and schedules with them", async () => {
    const person = await personWithEverything("direct");
    expect(await heldFor(person.id)).toMatchObject({
      memories: 1,
      sources: 1,
      threads: 1,
      routines: 1,
      signInSecrets: 1,
    });

    await people.purge(person.id);

    expect(await heldFor(person.id)).toEqual(NOTHING);
  });

  test("elsewhere, and found gone here, takes them too", async () => {
    const person = await personWithEverything("elsewhere");
    // Another replica, or the company's directory through SCIM, deletes them in Intelligence.
    await people.client.purgePerson(person.id, idempotencyKey("test-purge"));

    // This replica hears of it and finds them gone: their row goes, and the listeners are told.
    expect(await people.refresh(person.id)).toBeNull();

    expect(await heldFor(person.id)).toEqual(NOTHING);
  });
});
