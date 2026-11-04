/**
 * The `users` projection stays in line with Intelligence's organization directory when somebody else
 * changes it: another replica, another application of the organization, an administrator's tool.
 *
 * Against a real Intelligence's realtime gateway and a project of its own
 * (`TEST_INTELLIGENCE_API_KEY_2`): this suite starts the directory the way a server does, which reads
 * the whole project into the database, so it must not share the project every other suite writes to.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { userInstructions, users } from "../src/db/schema";
import {
  createDirectoryClient,
  idempotencyKey,
} from "../src/people/directory/client";
import {
  createPeopleDirectory,
  DirectoryProjectMismatchError,
  type PeopleDirectory,
} from "../src/people/directory/directory";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { uniqueEmail } from "./support/directory";

function secondProjectKey(): string {
  const key = process.env.TEST_INTELLIGENCE_API_KEY_2?.trim();
  if (!key)
    throw new Error(
      "TEST_INTELLIGENCE_API_KEY_2 must name a second project of the test Intelligence: this suite starts a people directory, which reads its whole project into the database.",
    );
  return key;
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const intelligence = testIntelligence();
const client = createDirectoryClient({
  apiUrl: intelligence.apiUrl,
  apiKey: secondProjectKey(),
});
let directory: PeopleDirectory;

/** Wait for something an announcement should bring about, for at most a few seconds. */
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(100);
    value = await read();
  }
  return value;
}

async function row(id: string) {
  const [found] = await database.select().from(users).where(eq(users.id, id));
  return found;
}

beforeAll(async () => {
  // The project starts empty, as a new organization's does.
  for (const person of (await client.allPeople({ includeDeleted: true }))
    .people)
    await client.purgePerson(person.id, idempotencyKey("test-reset"));
  directory = createPeopleDirectory({
    client,
    database,
    gatewayWsUrl: intelligence.gatewayWsUrl,
    pushIntervalMs: 60_000,
  });
  await directory.start();
  await eventually(
    async () => directory.subscribed(),
    (joined) => joined,
  );
});

afterAll(async () => {
  directory.stop();
  for (const person of (await client.allPeople({ includeDeleted: true }))
    .people) {
    await client.purgePerson(person.id, idempotencyKey("test-cleanup"));
    await database.delete(users).where(eq(users.id, person.id));
  }
  await database.$client.close();
});

describe("changes made elsewhere", () => {
  test("a person made in Intelligence by somebody else arrives here", async () => {
    const id = `elsewhere-${randomUUID()}`;
    await client.createPerson(
      {
        id,
        email: uniqueEmail("elsewhere"),
        name: "Made elsewhere",
        image: null,
        emailVerified: true,
        role: "user",
      },
      idempotencyKey("test-create"),
    );

    const arrived = await eventually(
      () => row(id),
      (found) => found !== undefined,
    );
    expect(arrived?.name).toBe("Made elsewhere");
    expect(arrived?.role).toBe("user");
  });

  test("a role changed elsewhere reaches the row the request guard reads", async () => {
    const id = `promoted-${randomUUID()}`;
    const created = await directory.create({
      id,
      email: uniqueEmail("promoted"),
      name: "To be promoted",
      image: null,
      emailVerified: true,
      role: "user",
    });

    await client.updatePerson(
      id,
      created.version,
      { role: "admin" },
      idempotencyKey("test-promote"),
    );

    const promoted = await eventually(
      () => row(id),
      (found) => found?.role === "admin",
    );
    expect(promoted?.role).toBe("admin");
    expect(promoted?.directoryVersion).toBe(created.version + 1);
  });

  test("a person deleted for good elsewhere leaves, with every row that named them", async () => {
    const id = `purged-${randomUUID()}`;
    await directory.create({
      id,
      email: uniqueEmail("purged"),
      name: "To be purged",
      image: null,
      emailVerified: true,
      role: "user",
    });
    await database
      .insert(userInstructions)
      .values({ userId: id, instructions: "Keep it short." });

    await client.purgePerson(id, idempotencyKey("test-purge"));

    const gone = await eventually(
      () => row(id),
      (found) => found === undefined,
    );
    expect(gone).toBeUndefined();
    const [instructions] = await database
      .select({ n: count() })
      .from(userInstructions)
      .where(eq(userInstructions.userId, id));
    expect(instructions?.n).toBe(0);
  });

  test("a purge nobody heard is caught by the next full read", async () => {
    // A row once written from Intelligence (it has a version) whose person Intelligence no longer
    // has: purged while this deployment was not listening.
    const id = `missed-${randomUUID()}`;
    await database.insert(users).values({
      id,
      email: uniqueEmail("missed"),
      name: "Purged while away",
      directoryVersion: 3,
      directoryPending: false,
    });

    await directory.resync();

    expect(await row(id)).toBeUndefined();
  });

  test("a pending row survives the full read, and is pushed", async () => {
    const id = `pending-${randomUUID()}`;
    await database.insert(users).values({
      id,
      email: uniqueEmail("pending"),
      name: "Made by Better Auth",
      role: "user",
      directoryPending: true,
    });

    await directory.resync();
    expect(await row(id)).toBeDefined();

    expect(await directory.pushPending()).toBeGreaterThanOrEqual(1);
    expect((await client.getPerson(id))?.name).toBe("Made by Better Auth");
    expect((await row(id))?.directoryVersion).not.toBeNull();
  });
});

describe("a database belongs to one project", () => {
  test("started against another project, the server refuses, names both, and removes nobody", async () => {
    // This database is bound to the second project: the directory above started on it.
    const id = `bound-${randomUUID()}`;
    await directory.create({
      id,
      email: uniqueEmail("bound"),
      name: "Belongs to project two",
      image: null,
      emailVerified: true,
      role: "user",
    });
    const scope = await client.scope();
    const elsewhere = createDirectoryClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
    });
    const other = await elsewhere.scope();
    expect(other.projectId).not.toBe(scope.projectId);

    const pointedElsewhere = createPeopleDirectory({
      client: elsewhere,
      database,
    });
    const refusal = await pointedElsewhere.start().then(
      () => null,
      (error: unknown) => error,
    );
    pointedElsewhere.stop();

    expect(refusal).toBeInstanceOf(DirectoryProjectMismatchError);
    const message = (refusal as Error).message;
    expect(message).toContain(`project ${scope.projectId}`);
    expect(message).toContain(`project ${other.projectId}`);
    expect(message).toContain("INTELLIGENCE_API_KEY");
    // Nobody here was taken for a person deleted in the other project.
    expect(await row(id)).toBeDefined();
  });
});
