import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import { createPeopleStore } from "../src/people/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The people list has to stop growing with the company.
 *
 * `list()` took no arguments and returned everybody, joined to their roles, their linked provider
 * accounts and every session they had ever held, on every render of the admin screen. `find()` was
 * `(await list()).find(...)`, so looking up one person ran that whole aggregate and filtered the
 * result in JavaScript, and every role change and every access change calls it twice.
 *
 * Against a real database, because what is being tested is the SQL: the keyset, the `nulls last`
 * ordering the cursor has to agree with, and the search. A fake store would pass whatever shape it
 * was written to return.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const store = createPeopleStore(database, []);
const PREFIX = "paging-test-";
const ids: string[] = [];

/** Somebody who signed in at a known moment, so the ordering is decidable rather than incidental. */
async function person(
  index: number,
  signedInAt: Date | null,
  name?: string,
): Promise<string> {
  const id = `${PREFIX}${String(index).padStart(3, "0")}`;
  ids.push(id);
  await database.insert(users).values({
    id,
    email: `${id}@openbot.test`,
    name: name ?? `Person ${index}`,
    emailVerified: true,
    lastSignedInAt: signedInAt,
  });
  if (signedInAt) {
    await database.insert(sessions).values({
      id: `${id}-session`,
      userId: id,
      token: `${id}-token`,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: signedInAt,
    });
  }
  return id;
}

afterEach(async () => {
  if (ids.length === 0) return;
  await database.delete(sessions).where(
    inArray(
      sessions.userId,
      ids.map((id) => id),
    ),
  );
  await database.delete(users).where(inArray(users.id, ids));
  ids.length = 0;
});

describe("reading the people in a deployment", () => {
  test("answers a page rather than everybody", async () => {
    const base = Date.now();
    for (let index = 0; index < 7; index += 1) {
      await person(index, new Date(base - index * 60_000));
    }

    const page = await store.list({ limit: 3 });

    expect(page.people).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
  });

  test("walking the cursor reaches everybody exactly once", async () => {
    // The property that matters. An offset would skip a person whenever somebody signed in while
    // the caller was paging, and would re-read every earlier row to answer each page.
    const base = Date.now();
    const expected: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      expected.push(await person(index, new Date(base - index * 60_000)));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await store.list({
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.people.map((one) => one.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    const mine = seen.filter((id) => id.startsWith(PREFIX));
    expect(new Set(mine).size).toBe(mine.length);
    expect(mine.sort()).toEqual(expected.sort());
  });

  test("somebody who has never signed in is last, not first", async () => {
    /*
     * Postgres sorts nulls first on a descending order, so without `nulls last` everybody who has
     * never signed in floats above everybody who just did, and page one is entirely people who have
     * never used the deployment. The cursor has to agree with that ordering or paging silently
     * drops rows at the boundary.
     */
    const base = Date.now();
    const recent = await person(0, new Date(base));
    const never = await person(1, null);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await store.list({
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.people.map((one) => one.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    const mine = seen.filter((id) => id.startsWith(PREFIX));
    expect(mine).toEqual([recent, never]);
  });

  test("search finds somebody who is not on the first page", async () => {
    // The reason search is server-side. Filtering the page that arrived would only ever search the
    // first page, which is the one case where nobody needs help.
    const base = Date.now();
    for (let index = 0; index < 6; index += 1) {
      await person(index, new Date(base - index * 60_000));
    }
    const wanted = await person(99, new Date(base - 3_600_000), "Grace Hopper");

    const byName = await store.list({ search: "grace", limit: 2 });
    expect(byName.people.map((one) => one.id)).toEqual([wanted]);

    const byAddress = await store.list({ search: "paging-test-099", limit: 2 });
    expect(byAddress.people.map((one) => one.id)).toEqual([wanted]);
  });

  test("a nonsense cursor reads as the first page rather than an error", async () => {
    // A stale link or a hand-edited URL. There is nothing here worth refusing over, and the first
    // page is the honest answer to "I do not know where you were".
    await person(0, new Date());

    const result = await store.list({ cursor: "not-a-cursor", limit: 5 });
    expect(result.people.length).toBeGreaterThan(0);
  });

  test("search treats underscores and percent signs as literal characters", async () => {
    const underscore = await person(0, new Date(), "Ninety_ Percent");
    await person(1, new Date(), "NinetyX Percent");
    const percent = await person(2, new Date(), "Ninety% Percent");

    for (const [search, wanted] of [
      ["Ninety_ Percent", underscore],
      ["Ninety% Percent", percent],
    ]) {
      const result = await store.list({ search, limit: 10 });
      expect(result.people.map((one) => one.id)).toEqual([wanted]);
    }
  });

  test("caps an oversized page at 200 and leaves the rest reachable", async () => {
    const base = Date.now();
    const people = Array.from({ length: 201 }, (_, index) => ({
      id: `${PREFIX}cap-${String(index).padStart(3, "0")}`,
      email: `${PREFIX}cap-${index}@openbot.test`,
      name: `Page cap fixture ${index}`,
      emailVerified: true,
      lastSignedInAt: new Date(base - index * 1000),
    }));
    ids.push(...people.map((one) => one.id));
    await database.insert(users).values(people);

    const first = await store.list({ search: `${PREFIX}cap-`, limit: 100_000 });
    expect(first.people.map((one) => one.id)).toEqual(
      people.slice(0, 200).map((one) => one.id),
    );
    if (!first.nextCursor)
      throw new Error("Expected a cursor for the 201st person.");
    const last = await store.list({
      search: `${PREFIX}cap-`,
      limit: 100_000,
      cursor: first.nextCursor,
    });
    expect(last.people.map((one) => one.id)).toEqual([people[200]?.id]);
    expect(last.nextCursor).toBeNull();
  });

  test("finding one person does not read the deployment", async () => {
    const base = Date.now();
    const wanted = await person(0, new Date(base));
    for (let index = 1; index < 5; index += 1) {
      await person(index, new Date(base - index * 60_000));
    }

    const found = await store.find(wanted);

    expect(found?.id).toBe(wanted);
    // The same shape the list answers with, because the screen renders both through one type.
    expect(found?.email).toBe(`${wanted}@openbot.test`);
    expect(found?.role).toBe("user");
  });

  test("finding somebody who is not there answers undefined", async () => {
    expect(await store.find("nobody-by-that-id")).toBeUndefined();
  });
});

afterAll(async () => {
  await database.$client.close();
});
