import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  applyConfiguredAdmin,
  isConfiguredAdmin,
  roleForEmail,
  seedRole,
  setRole,
} from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  purgeDirectoryPeople,
  seedDirectoryPerson,
  useTestPeople,
} from "./support/directory";

describe("roleForEmail", () => {
  test("assigns an admin role to allowlisted addresses without case sensitivity", () => {
    expect(roleForEmail("Admin@OpenBot.test", ["admin@openbot.test"])).toBe(
      "admin",
    );
  });

  test("assigns the user role to addresses outside the initial admin allowlist", () => {
    expect(roleForEmail("member@openbot.test", ["admin@openbot.test"])).toBe(
      "user",
    );
  });
});

/*
 * Roles against a real Intelligence directory and a real database: a person's role is the
 * directory's, and the row the request guard reads follows it. Each case makes its own person.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const directory = useTestPeople();
const made: string[] = [];

afterAll(async () => {
  await purgeDirectoryPeople(made);
  await database.$client.close();
});

async function person(role: "admin" | "user" = "user") {
  const created = await seedDirectoryPerson({ role });
  made.push(created.id);
  return created;
}

/** The role as both the directory and the guard's row hold it: they must agree. */
async function roleOf(id: string) {
  const [row] = await database
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, id));
  const held = await directory.client.getPerson(id);
  expect(held?.role).toBe(row?.role ?? undefined);
  return row?.role;
}

describe("setRole", () => {
  test("replaces the role rather than adding to it", async () => {
    const ada = await person();

    await setRole(database, ada.id, "admin");
    expect(await roleOf(ada.id)).toBe("admin");
  });

  test("sets somebody back to user", async () => {
    const ada = await person("admin");

    await setRole(database, ada.id, "user");
    expect(await roleOf(ada.id)).toBe("user");
  });

  test("setting the role somebody has changes nothing in Intelligence", async () => {
    const ada = await person();
    const before = (await directory.client.getPerson(ada.id))?.version;

    await setRole(database, ada.id, "user");

    expect((await directory.client.getPerson(ada.id))?.version).toBe(
      before ?? -1,
    );
  });
});

describe("applyConfiguredAdmin", () => {
  test("promotes an address the deployment names", async () => {
    const ada = await person();

    await applyConfiguredAdmin(database, ada.id, [ada.email]);

    expect(await roleOf(ada.id)).toBe("admin");
  });

  /*
   * Whether this sign-in is what granted the role.
   *
   * The floor is re-applied silently on every sign-in, which meant anybody who could edit
   * `INITIAL_ADMIN_EMAILS` made themselves an administrator with nothing anywhere recording it. The
   * caller writes the audit row, and it needs to know which sign-in did it, or every sign-in by
   * every administrator would produce one and the row would say nothing.
   */
  test("says so when this sign-in is what granted the role", async () => {
    const ada = await person();

    expect(await applyConfiguredAdmin(database, ada.id, [ada.email])).toBe(
      true,
    );
  });

  test("says nothing when they were already an administrator", async () => {
    const ada = await person("admin");

    expect(await applyConfiguredAdmin(database, ada.id, [ada.email])).toBe(
      false,
    );
  });

  test("says nothing for somebody the configuration does not name", async () => {
    const ada = await person();

    expect(
      await applyConfiguredAdmin(database, ada.id, ["admin@openbot.test"]),
    ).toBe(false);
  });

  test("says nothing when nothing is configured", async () => {
    const ada = await person();

    expect(await applyConfiguredAdmin(database, ada.id, [])).toBe(false);
  });

  /**
   * The reason this is a floor and not the whole answer.
   *
   * Somebody promoted from the admin screen is not on the list, and rewriting their role here would
   * silently undo that promotion the next time they signed in.
   */
  test("leaves everybody else exactly as the admin screen set them", async () => {
    const promoted = await person("admin");

    await applyConfiguredAdmin(database, promoted.id, ["admin@openbot.test"]);

    expect(await roleOf(promoted.id)).toBe("admin");
  });

  test("does nothing for a session whose user is not there", async () => {
    expect(
      await applyConfiguredAdmin(database, "nobody-at-all", [
        "admin@openbot.test",
      ]),
    ).toBe(false);
  });
});

describe("seedRole", () => {
  test("starts an address on the list as an administrator", async () => {
    const ada = await person();

    await seedRole(database, ada.id, ada.email, [ada.email]);

    expect(await roleOf(ada.id)).toBe("admin");
  });

  test("starts everybody else as a user", async () => {
    const ada = await person("admin");

    await seedRole(database, ada.id, ada.email, ["admin@openbot.test"]);

    expect(await roleOf(ada.id)).toBe("user");
  });
});

describe("isConfiguredAdmin", () => {
  test("ignores case and surrounding space, on both sides", () => {
    expect(
      isConfiguredAdmin("  Admin@OpenBot.test ", [" admin@openbot.TEST "]),
    ).toBe(true);
  });
});
