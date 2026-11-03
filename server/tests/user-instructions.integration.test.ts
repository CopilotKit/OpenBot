import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sweepRemovedPeople } from "../src/configuration/people-sweep";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import {
  createUserInstructionsStore,
  INSTRUCTIONS_LIMIT,
  InstructionsTooLongError,
} from "../src/user-instructions";
import { storedPreferences, useTestConfiguration } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createUserInstructionsStore();

beforeAll(async () => {
  await useTestConfiguration();
});

const createdUserIds: string[] = [];

async function person() {
  const id = `user-instructions-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@openbot.test` });
  createdUserIds.push(id);
  return id;
}

afterEach(async () => {
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

describe("one person's standing instructions", () => {
  test("reads as nothing before anybody has written any", async () => {
    await expect(store.read(await person())).resolves.toBeNull();
  });

  test("saves, replaces, and reads back what was stored", async () => {
    const userId = await person();

    await expect(
      store.write(userId, "Write in British English."),
    ).resolves.toBe("Write in British English.");
    await expect(store.read(userId)).resolves.toBe("Write in British English.");

    // The second save REPLACES rather than appends: the box holds one text, and a save says what it
    // now is. There is no gesture in the UI for removing half of what you wrote if it merged.
    await expect(store.write(userId, "Never say we are a team.")).resolves.toBe(
      "Never say we are a team.",
    );
    await expect(store.read(userId)).resolves.toBe("Never say we are a team.");

    // One text, not two, in the person's preferences in Intelligence.
    expect((await storedPreferences(userId)).instructions).toBe(
      "Never say we are a team.",
    );
  });

  test("trims what it is given, so the stored text is what the model will read", async () => {
    const userId = await person();

    await expect(
      store.write(userId, "  \n Write in British English. \n "),
    ).resolves.toBe("Write in British English.");
    await expect(store.read(userId)).resolves.toBe("Write in British English.");
  });

  test("clears by saving nothing, and leaves no empty text behind", async () => {
    const userId = await person();
    await store.write(userId, "Write in British English.");

    await expect(store.write(userId, "   ")).resolves.toBe("");

    /*
     * Absence, not an empty string. The two would read the same to a person and differently to
     * everything else: the prompt seam would have to learn that "" means no block, and "has this
     * person written any" would stop being a row count.
     */
    await expect(store.read(userId)).resolves.toBeNull();
    expect((await storedPreferences(userId)).instructions).toBeNull();
  });

  test("clearing what was never written is not an error", async () => {
    const userId = await person();

    await expect(store.write(userId, "")).resolves.toBe("");
    await expect(store.read(userId)).resolves.toBeNull();
  });

  test("refuses more than the cap, and stores nothing when it does", async () => {
    const userId = await person();
    await store.write(userId, "Write in British English.");

    await expect(
      store.write(userId, "x".repeat(INSTRUCTIONS_LIMIT + 1)),
    ).rejects.toBeInstanceOf(InstructionsTooLongError);

    // The refusal is a refusal, not a partial write: what was there is still there.
    await expect(store.read(userId)).resolves.toBe("Write in British English.");
  });

  test("accepts exactly the cap, measured after the trim", async () => {
    const userId = await person();
    const atTheLimit = "x".repeat(INSTRUCTIONS_LIMIT);

    // The whitespace is not part of what is stored, so it must not be part of what is counted: a
    // trailing newline from a textarea is not somebody exceeding a limit.
    await expect(store.write(userId, ` ${atTheLimit}\n`)).resolves.toBe(
      atTheLimit,
    );
    await expect(store.read(userId)).resolves.toBe(atTheLimit);
  });

  test("keeps two people's instructions apart", async () => {
    const one = await person();
    const other = await person();

    await store.write(one, "Write in British English.");
    await store.write(other, "Answer in one paragraph.");

    await expect(store.read(one)).resolves.toBe("Write in British English.");
    await expect(store.read(other)).resolves.toBe("Answer in one paragraph.");
  });

  test("goes when the person goes", async () => {
    const userId = await person();
    await store.write(userId, "Write in British English.");

    // The old foreign key's cascade, run by hand: the sweep removes what Intelligence holds about a
    // person this deployment no longer has.
    await database.delete(users).where(eq(users.id, userId));
    await sweepRemovedPeople(database, await useTestConfiguration());

    expect((await storedPreferences(userId)).revision).toBe(0);
    await expect(store.read(userId)).resolves.toBeNull();
  });

  test("another replica's save reaches this one without a restart", async () => {
    const userId = await person();
    const configuration = await useTestConfiguration();
    // Written past this process's copy, as another replica writes it.
    await configuration.client.preferences.change(
      userId,
      [{ op: "setInstructions", instructions: "Answer in Welsh." }],
      `test:${randomUUID()}`,
    );
    const deadline = Date.now() + 5_000;
    while (
      (await store.read(userId)) !== "Answer in Welsh." &&
      Date.now() < deadline
    )
      await Bun.sleep(50);
    await expect(store.read(userId)).resolves.toBe("Answer in Welsh.");
  });
});
