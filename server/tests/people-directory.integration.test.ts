/**
 * People live in Intelligence's organization directory, and `users` is this deployment's projection of
 * it. Against a real Intelligence and a real database, through the stores the screens and sign-in use:
 *
 * - what OpenBot decides about a person (role, removal, preferences, onboarding, name) is written to
 *   Intelligence and the row follows; `user_roles` and `revoked_access` are never written;
 * - what Better Auth writes to a row is pushed to Intelligence once it commits;
 * - a person Intelligence deletes for good leaves this deployment, with every row that named them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { count, eq, inArray } from "drizzle-orm";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  revokedAccess,
  sessions,
  userInstructions,
  userRoles,
  users,
} from "../src/db/schema";
import { idempotencyKey } from "../src/people/directory/client";
import { createOnboardingStore } from "../src/people/onboarding";
import { createProfileStore } from "../src/people/profile";
import { createPeopleStore } from "../src/people/store";
import { createUserPreferencesStore } from "../src/user-preferences";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  liftRemovals,
  purgeDirectoryPeople,
  seedDirectoryPerson,
  uniqueEmail,
  useTestPeople,
} from "./support/directory";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const directory = useTestPeople();
const made: string[] = [];
const removedEmails: string[] = [];

afterAll(async () => {
  await liftRemovals(removedEmails);
  await purgeDirectoryPeople(made);
  await database.$client.close();
});

async function person(role: "admin" | "user" = "user") {
  const created = await seedDirectoryPerson({ role });
  made.push(created.id);
  return created;
}

async function row(id: string) {
  const [found] = await database.select().from(users).where(eq(users.id, id));
  return found;
}

async function legacyRows(id: string, email: string) {
  const [roles] = await database
    .select({ n: count() })
    .from(userRoles)
    .where(eq(userRoles.userId, id));
  const [removals] = await database
    .select({ n: count() })
    .from(revokedAccess)
    .where(eq(revokedAccess.email, email));
  return { roles: roles?.n ?? 0, removals: removals?.n ?? 0 };
}

describe("what OpenBot decides about a person", () => {
  test("a person made through the directory is in Intelligence and projected here", async () => {
    const ada = await person();
    const held = await directory.client.getPerson(ada.id);
    expect(held?.email).toBe(ada.email);
    const local = await row(ada.id);
    expect(local?.email).toBe(ada.email);
    expect(local?.role).toBe("user");
    expect(local?.directoryVersion).toBe(held?.version ?? -1);
  });

  test("a role change is Intelligence's, and the row the guard reads follows", async () => {
    const ada = await person();
    await setRole(database, ada.id, "admin");

    expect((await directory.client.getPerson(ada.id))?.role).toBe("admin");
    expect((await row(ada.id))?.role).toBe("admin");
    expect((await legacyRows(ada.id, ada.email)).roles).toBe(0);

    // The People screen shows the same role, from the same row.
    const store = createPeopleStore(database, []);
    expect((await store.find(ada.id))?.role).toBe("admin");
  });

  test("removing somebody records the address in Intelligence and ends their sessions here", async () => {
    const ada = await person();
    removedEmails.push(ada.email);
    await database.insert(sessions).values({
      id: `session-${randomUUID()}`,
      userId: ada.id,
      token: `token-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const store = createPeopleStore(database, []);

    await store.revoke(ada.id, "admin-who-removed");

    const removal = await directory.client.getRemoval(ada.email);
    expect(removal?.removedBy).toBe("admin-who-removed");
    expect(await store.isRevoked(ada.email.toUpperCase())).toBe(true);
    expect((await store.find(ada.id))?.revoked).toBe(true);
    const [left] = await database
      .select({ n: count() })
      .from(sessions)
      .where(eq(sessions.userId, ada.id));
    expect(left?.n).toBe(0);
    expect((await legacyRows(ada.id, ada.email)).removals).toBe(0);

    await store.restore(ada.id);
    expect(await directory.client.getRemoval(ada.email)).toBeNull();
    expect(await store.isRevoked(ada.email)).toBe(false);
    expect((await store.find(ada.id))?.revoked).toBe(false);
  });

  test("somebody another application deleted from the directory cannot sign in again", async () => {
    const ada = await person();
    const store = createPeopleStore(database, []);
    expect(await store.isRevoked(ada.email)).toBe(false);

    // Soft-deleted straight in Intelligence: kept there, with their history, but gone.
    await directory.client.deletePerson(ada.id, idempotencyKey("test-delete"));

    expect(await store.isRevoked(ada.email)).toBe(true);
    // Their row here stays, as their history does.
    expect(await row(ada.id)).toBeDefined();
  });

  test("preferences merge over Intelligence's copy, so two saves to different settings both stand", async () => {
    const ada = await person();
    const preferences = createUserPreferencesStore(database);

    await Promise.all([
      preferences.patch(ada.id, { skin: "openbot" }),
      preferences.patch(ada.id, { profileNameSet: true }),
    ]);

    const held = await directory.client.getPerson(ada.id);
    expect(held?.preferences).toMatchObject({
      skin: "openbot",
      profileNameSet: true,
    });
    expect((await preferences.read(ada.id)).skin).toBe("openbot");
  });

  test("onboarding and a chosen display name are written to Intelligence", async () => {
    const ada = await person();
    const onboarding = createOnboardingStore(database);
    const profile = createProfileStore(database);

    await onboarding.setStep(ada.id, 3);
    await onboarding.complete(ada.id);
    const first = (await directory.client.getPerson(ada.id))
      ?.onboardingCompletedAt;
    await onboarding.complete(ada.id);
    await profile.save(ada.id, "Ada Lovelace");

    const held = await directory.client.getPerson(ada.id);
    expect(held?.onboardingStep).toBe(3);
    expect(held?.onboardingCompletedAt?.toISOString()).toBe(
      first?.toISOString() ?? "",
    );
    expect(held?.name).toBe("Ada Lovelace");
    expect(held?.preferences).toMatchObject({ profileNameSet: true });
    expect((await onboarding.status(ada.id)).step).toBe(3);
    expect((await profile.read(ada.id)).name).toBe("Ada Lovelace");
  });
});

describe("what Better Auth writes", () => {
  test("a row Better Auth changed is pending until pushed, and the push lands in Intelligence", async () => {
    const ada = await person();
    // What Better Auth's adapter does for an identity provider's new name (auth/directory-adapter.ts).
    await database
      .update(users)
      .set({
        name: "Ada from the IdP",
        directoryPending: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, ada.id));

    const pushed = await directory.push(ada.id);

    expect(pushed?.name).toBe("Ada from the IdP");
    expect((await directory.client.getPerson(ada.id))?.name).toBe(
      "Ada from the IdP",
    );
    expect((await row(ada.id))?.directoryVersion).toBe(pushed?.version ?? -1);
  });

  test("a pending row is never overwritten from Intelligence", async () => {
    const ada = await person();
    await database
      .update(users)
      .set({ name: "Pending name", directoryPending: true })
      .where(eq(users.id, ada.id));

    // Somebody else changes the person in Intelligence meanwhile.
    const held = await directory.client.getPerson(ada.id);
    await directory.client.updatePerson(
      ada.id,
      held?.version ?? 1,
      { role: "admin" },
      idempotencyKey("test"),
    );
    await directory.refresh(ada.id);
    expect((await row(ada.id))?.name).toBe("Pending name");

    // The push carries the name and brings back the role.
    await directory.pushPending();
    const local = await row(ada.id);
    expect(local?.name).toBe("Pending name");
    expect(local?.role).toBe("admin");
    expect(local?.directoryVersion).not.toBeNull();
    expect(local?.directoryPending).toBe(false);
  });
});

describe("a person Intelligence deletes for good", () => {
  test("is never made again by a change of Better Auth's still waiting to be pushed", async () => {
    const ada = await person();
    await database
      .insert(userInstructions)
      .values({ userId: ada.id, instructions: "Keep it brief." });
    // Better Auth writes a new name; before it is pushed, another application purges the person.
    await database
      .update(users)
      .set({
        name: "Renamed meanwhile",
        directoryPending: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, ada.id));
    await directory.client.purgePerson(ada.id, idempotencyKey("test-purge"));

    expect(await directory.push(ada.id)).toBeNull();

    // Not made again in Intelligence; gone here, with what named them, as the purge means.
    expect(await directory.client.getPerson(ada.id)).toBeNull();
    expect(await row(ada.id)).toBeUndefined();
    const [instructions] = await database
      .select({ n: count() })
      .from(userInstructions)
      .where(eq(userInstructions.userId, ada.id));
    expect(instructions?.n).toBe(0);
  });

  test("leaves this deployment with every row that named them", async () => {
    const ada = await person();
    await database
      .insert(userInstructions)
      .values({ userId: ada.id, instructions: "Write in British English." });

    // Purged by another application of the organization, straight in Intelligence.
    await directory.client.purgePerson(ada.id, idempotencyKey("test-purge"));
    expect(await directory.refresh(ada.id)).toBeNull();

    expect(await row(ada.id)).toBeUndefined();
    const [instructions] = await database
      .select({ n: count() })
      .from(userInstructions)
      .where(eq(userInstructions.userId, ada.id));
    expect(instructions?.n).toBe(0);
  });

  test("a pending row is never taken for a purged person", async () => {
    const id = `pending-${randomUUID()}`;
    made.push(id);
    await database.insert(users).values({
      id,
      email: uniqueEmail("pending"),
      name: "Not pushed yet",
      directoryPending: true,
    });
    await directory.refresh(id);
    expect(await row(id)).toBeDefined();
    await database.delete(users).where(inArray(users.id, [id]));
  });
});
