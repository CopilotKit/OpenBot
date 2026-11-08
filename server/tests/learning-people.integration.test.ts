import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { learningPersonSpaces } from "../src/db/schema/learning";
import { createLearningPeople } from "../src/learning/people";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `learning-people-${randomUUID()}`;
const ada = `${prefix}-ada`;
const grace = `${prefix}-grace`;
const nameless = `${prefix}-nameless`;
const without = `${prefix}-without`;
const ids = [ada, grace, nameless, without];

beforeAll(async () => {
  await database.insert(users).values([
    { id: ada, email: `${ada}@example.test`, name: " Ada Lovelace " },
    { id: grace, email: `${grace}@example.test`, name: "Grace Hopper" },
    { id: nameless, email: `${prefix}-nameless@example.test`, name: "  " },
    { id: without, email: `${without}@example.test`, name: "No Space" },
  ]);
  await database.insert(learningPersonSpaces).values([
    { userId: ada, containerId: `${prefix}-c-ada` },
    { userId: grace, containerId: `${prefix}-c-grace` },
    { userId: nameless, containerId: `${prefix}-c-nameless` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, ids));
  await database.$client.close();
});

describe("createLearningPeople", () => {
  test("lists the people who have a space by name, falling back to the email", async () => {
    const people = (await createLearningPeople(database)()).filter((person) =>
      ids.includes(person.userId),
    );
    expect(people).toEqual([
      { userId: ada, name: "Ada Lovelace", containerId: `${prefix}-c-ada` },
      { userId: grace, name: "Grace Hopper", containerId: `${prefix}-c-grace` },
      {
        userId: nameless,
        name: `${prefix}-nameless@example.test`,
        containerId: `${prefix}-c-nameless`,
      },
    ]);
  });
});
