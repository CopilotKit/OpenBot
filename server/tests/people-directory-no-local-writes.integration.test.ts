/**
 * People live in Intelligence's organization directory: `user_roles`, `revoked_access` and
 * `identity_links` get no writes, and `users` is written only as the directory's projection.
 *
 * The three tables stay for one release so an upgrading deployment has rows to copy, and are read only
 * by that copy. Two guards: no server source writes them (or writes `users` outside the directory and
 * Better Auth's adapter), and a person's whole life through the stores (made, promoted, linked, given
 * settings, removed, restored, unlinked) leaves all three as they were while Intelligence holds each step.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { count } from "drizzle-orm";
import { setRole } from "../src/auth/roles";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { identityLinks, revokedAccess, userRoles } from "../src/db/schema";
import { createIdentityStore } from "../src/identity/store";
import { createOnboardingStore } from "../src/people/onboarding";
import { createPeopleStore } from "../src/people/store";
import { createUserPreferencesStore } from "../src/user-preferences";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  liftRemovals,
  purgeDirectoryPeople,
  seedDirectoryPerson,
  useTestPeople,
} from "./support/directory";
import { sourceFiles, stripComments } from "./support/source-scan";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made: string[] = [];
const removed: string[] = [];

afterAll(async () => {
  await liftRemovals(removed);
  await purgeDirectoryPeople(made);
  await database.$client.close();
});

describe("the legacy people tables", () => {
  test("no server source writes them, and `users` is written only as the projection", () => {
    const root = join(import.meta.dir, "..", "src");
    const projection = new Set([
      "people/directory/directory.ts",
      "people/directory/upgrade.ts",
    ]);
    const offenders = sourceFiles(root, [".ts"]).flatMap((file) => {
      const path = relative(root, file);
      const code = stripComments(readFileSync(file, "utf8"));
      const legacy =
        /\.(?:insert|update|delete)\(\s*(?:userRoles|revokedAccess|identityLinks)\s*\)/.test(
          code,
        );
      const people =
        !projection.has(path) &&
        /\.(?:insert|update|delete)\(\s*users\s*\)/.test(code);
      return legacy || people ? [path] : [];
    });
    expect(offenders).toEqual([]);
  });

  test("a person's whole life through the stores writes nothing to them", async () => {
    useTestPeople();
    const before = await tableCounts();

    const person = await seedDirectoryPerson();
    made.push(person.id);
    await setRole(database, person.id, "admin");
    await createUserPreferencesStore(database).patch(person.id, {
      skin: "openbot",
    });
    await createOnboardingStore(database).complete(person.id);
    const identities = createIdentityStore(
      database,
      createCredentialStore(database),
    );
    const link = await identities.linkVerified(
      {
        provider: "slack",
        realm: `T${person.id.slice(-6)}`,
        subject: `U${person.id.slice(-8)}`,
      },
      person.id,
      { method: "challenge", handle: "@person" },
    );
    const people = createPeopleStore(database, []);
    removed.push(person.email);
    await people.revoke(person.id, "test-admin");
    await people.restore(person.id);
    await identities.unlink(person.id, link.id);

    expect(await tableCounts()).toEqual(before);
  });
});

async function tableCounts() {
  const [roles] = await database.select({ n: count() }).from(userRoles);
  const [removals] = await database.select({ n: count() }).from(revokedAccess);
  const [links] = await database.select({ n: count() }).from(identityLinks);
  return {
    userRoles: roles?.n,
    revokedAccess: removals?.n,
    identityLinks: links?.n,
  };
}
