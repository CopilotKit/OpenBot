import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DEV_ACTOR, initializeDevActorUser } from "../src/auth/dev-actor";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { idempotencyKey } from "../src/people/directory/client";
import { createProfileStore } from "../src/people/profile";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { purgeDirectoryPeople, useTestPeople } from "./support/directory";

/*
 * The single-user administrator is a person in Intelligence's organization directory like anybody
 * else, made at startup when the deployment runs without sign-in, under a fixed id so their threads
 * and memory stay theirs across restarts. Against a real directory and a real database.
 */
const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const directory = useTestPeople();
const conflicting: string[] = [];

beforeEach(async () => {
  await purgeDirectoryPeople([DEV_ACTOR.id]);
});

afterAll(async () => {
  await purgeDirectoryPeople([DEV_ACTOR.id, ...conflicting]);
  await database.$client.close();
});

async function row() {
  return (
    await database.select().from(users).where(eq(users.id, DEV_ACTOR.id))
  )[0];
}

describe("development actor persistence", () => {
  test("touches nothing when disabled", async () => {
    expect(await initializeDevActorUser(undefined, false)).toBe(false);
    expect(await directory.client.getPerson(DEV_ACTOR.id)).toBeNull();
    expect(await row()).toBeUndefined();
  });

  test("makes the administrator in the directory when enabled, and restores the canonical identity", async () => {
    expect(await initializeDevActorUser(undefined, true)).toBe(true);
    const held = await directory.client.getPerson(DEV_ACTOR.id);
    expect(held).toMatchObject({
      id: DEV_ACTOR.id,
      email: DEV_ACTOR.email,
      name: DEV_ACTOR.name ?? DEV_ACTOR.email,
      emailVerified: false,
      role: "admin",
      groups: [],
    });
    expect(await row()).toMatchObject({
      id: DEV_ACTOR.id,
      email: DEV_ACTOR.email,
      role: "admin",
      directoryVersion: held?.version ?? -1,
    });

    // Changed elsewhere: the address comes back, the name stays.
    await directory.client.updatePerson(
      DEV_ACTOR.id,
      held?.version ?? 1,
      { email: `changed-${randomUUID()}@example.test`, name: "Changed" },
      idempotencyKey("test-change"),
    );
    expect(await initializeDevActorUser(undefined, true)).toBe(true);

    expect(await directory.client.getPerson(DEV_ACTOR.id)).toMatchObject({
      email: DEV_ACTOR.email,
      name: "Changed",
    });
    expect(await row()).toMatchObject({
      email: DEV_ACTOR.email,
      name: "Changed",
    });
  });

  test("profile edits survive startup without changing identity or onboarding", async () => {
    await initializeDevActorUser(undefined, true);
    const profile = createProfileStore(database);
    expect((await profile.read(DEV_ACTOR.id)).needsName).toBe(true);
    await directory.update(DEV_ACTOR.id, () => ({
      preferences: { selfHostBannerDismissed: true },
      onboardingCompletedAt: new Date("2026-01-01"),
    }));
    await profile.save(DEV_ACTOR.id, "Sam");
    await initializeDevActorUser(undefined, true);
    expect(await profile.read(DEV_ACTOR.id)).toEqual({
      name: "Sam",
      needsName: false,
    });
    expect(await row()).toMatchObject({
      id: DEV_ACTOR.id,
      email: DEV_ACTOR.email,
      preferences: { selfHostBannerDismissed: true, profileNameSet: true },
      onboardingCompletedAt: new Date("2026-01-01"),
    });
    // Even deliberately choosing the old placeholder counts as completing the prompt.
    await profile.save(DEV_ACTOR.id, DEV_ACTOR.email);
    await initializeDevActorUser(undefined, true);
    expect((await profile.read(DEV_ACTOR.id)).needsName).toBe(false);
  });

  test("fails loudly when another person holds the development address", async () => {
    const other = await directory.create({
      id: `dev-actor-conflict-${randomUUID()}`,
      email: DEV_ACTOR.email,
      name: "Conflicting User",
      image: null,
      emailVerified: false,
      role: "user",
    });
    conflicting.push(other.id);

    await expect(initializeDevActorUser(undefined, true)).rejects.toThrow();
    expect(await directory.client.getPerson(DEV_ACTOR.id)).toBeNull();
  });
});
