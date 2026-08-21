import { describe, expect, test } from "bun:test";
import {
  applyConfiguredAdmin,
  isConfiguredAdmin,
  roleForEmail,
  seedRole,
  setRole,
} from "../src/auth/roles";
import type { Database } from "../src/db/client";

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

/**
 * Bringing a role in line with the administrator list, on a fake that records the statements.
 *
 * A real database would test Drizzle. What matters here is the shape of the write: `user_roles` is
 * a set with a `(user_id, role)` primary key and the guard takes `admin` if any row says so, so
 * reconciling has to remove the rows that should not be there rather than only adding one. Insert
 * alone is what the old create-time hook did, and it could promote but never demote.
 */
type Statement = { kind: "delete" | "insert"; role: string };

function recordingDatabase(): {
  database: Database;
  statements: Statement[];
} {
  const statements: Statement[] = [];
  const tx = {
    delete: () => ({
      where: (condition: unknown) => {
        // The condition carries the role being kept; what is asserted is that a delete happened at
        // all and that the insert which follows names the same role.
        void condition;
        statements.push({ kind: "delete", role: "" });
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (row: { role: string }) => ({
        onConflictDoNothing: () => {
          statements.push({ kind: "insert", role: row.role });
          return Promise.resolve();
        },
      }),
    }),
  };

  const database = {
    transaction: async (run: (t: typeof tx) => Promise<void>) => {
      await run(tx);
    },
  } as unknown as Database;

  return { database, statements };
}

describe("setRole", () => {
  test("replaces the set rather than adding to it", async () => {
    const { database, statements } = recordingDatabase();

    const role = await setRole(database, "u1", "admin");

    expect(role).toBe("admin");
    expect(statements).toEqual([
      { kind: "delete", role: "" },
      { kind: "insert", role: "admin" },
    ]);
  });

  /**
   * Demotion has to remove the `admin` row, because the guard reads the set and one leftover row
   * keeps somebody an administrator for ever.
   */
  test("removes the admin row when setting somebody back to user", async () => {
    const { database, statements } = recordingDatabase();

    const role = await setRole(database, "u1", "user");

    expect(role).toBe("user");
    expect(statements).toEqual([
      { kind: "delete", role: "" },
      { kind: "insert", role: "user" },
    ]);
  });

  // Both statements together or neither: between them a request on another process would find no
  // row and be refused with a 403 that reads as a permissions bug rather than a race.
  test("writes both statements inside one transaction", async () => {
    let transactions = 0;
    const database = {
      transaction: async (run: (t: unknown) => Promise<void>) => {
        transactions += 1;
        await run({
          delete: () => ({ where: () => Promise.resolve() }),
          insert: () => ({
            values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
          }),
        });
      },
    } as unknown as Database;

    await setRole(database, "u1", "admin");

    expect(transactions).toBe(1);
  });
});

/**
 * The configured floor, applied at every sign-in.
 *
 * This is the half that has to coexist with an admin screen. `INITIAL_ADMIN_EMAILS` guarantees a way
 * back in, so an address it names is promoted whenever they sign in; everybody else's role belongs
 * to whoever administers the deployment, and a sign-in that rewrote it would make that screen lie
 * the moment they came back.
 */
function databaseWithUser(
  email: string | null,
  /**
   * Whether this person is already an administrator.
   *
   * `applyConfiguredAdmin` reads it so it can answer whether this sign-in is what granted the role.
   * The caller writes an audit row when it did, and a returning administrator must not produce one
   * on every sign-in.
   */
  alreadyAdmin = false,
): {
  database: Database;
  written: string[];
} {
  const written: string[] = [];
  const database = {
    // Two different reads go through here: the user's address, and whether they already hold the
    // role. Told apart by the projection, because that is the only thing the double can see.
    select: (projection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (projection && "role" in projection) {
              return alreadyAdmin ? [{ role: "admin" }] : [];
            }
            return email === null ? [] : [{ email }];
          },
        }),
      }),
    }),
    transaction: async (run: (t: unknown) => Promise<void>) => {
      await run({
        delete: () => ({ where: () => Promise.resolve() }),
        insert: () => ({
          values: (row: { role: string }) => ({
            onConflictDoNothing: () => {
              written.push(row.role);
              return Promise.resolve();
            },
          }),
        }),
      });
    },
  } as unknown as Database;

  return { database, written };
}

describe("applyConfiguredAdmin", () => {
  test("promotes an address the deployment names", async () => {
    const { database, written } = databaseWithUser("admin@openbot.test");

    await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]);

    expect(written).toEqual(["admin"]);
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
    const { database } = databaseWithUser("admin@openbot.test");

    expect(
      await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]),
    ).toBe(true);
  });

  test("says nothing when they were already an administrator", async () => {
    const { database } = databaseWithUser("admin@openbot.test", true);

    expect(
      await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]),
    ).toBe(false);
  });

  test("says nothing for somebody the configuration does not name", async () => {
    const { database } = databaseWithUser("member@openbot.test");

    expect(
      await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]),
    ).toBe(false);
  });

  test("says nothing when nothing is configured", async () => {
    const { database } = databaseWithUser("admin@openbot.test");

    expect(await applyConfiguredAdmin(database, "u1", [])).toBe(false);
  });

  /**
   * The reason this is a floor and not the whole answer.
   *
   * Somebody promoted from the admin screen is not on the list, and rewriting their role here would
   * silently undo that promotion the next time they signed in.
   */
  test("leaves everybody else exactly as the admin screen set them", async () => {
    const { database, written } = databaseWithUser("member@openbot.test");

    await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]);

    expect(written).toEqual([]);
  });

  test("writes nothing when the deployment names nobody", async () => {
    const { database, written } = databaseWithUser("admin@openbot.test");

    await applyConfiguredAdmin(database, "u1", []);

    expect(written).toEqual([]);
  });

  test("does nothing for a session whose user is not there", async () => {
    const { database, written } = databaseWithUser(null);

    await applyConfiguredAdmin(database, "u1", ["admin@openbot.test"]);

    expect(written).toEqual([]);
  });
});

describe("seedRole", () => {
  test("starts an address on the list as an administrator", async () => {
    const { database, written } = databaseWithUser("admin@openbot.test");

    await seedRole(database, "u1", "admin@openbot.test", [
      "admin@openbot.test",
    ]);

    expect(written).toEqual(["admin"]);
  });

  test("starts everybody else as a user", async () => {
    const { database, written } = databaseWithUser("member@openbot.test");

    await seedRole(database, "u1", "member@openbot.test", [
      "admin@openbot.test",
    ]);

    expect(written).toEqual(["user"]);
  });
});

describe("isConfiguredAdmin", () => {
  test("ignores case and surrounding space, on both sides", () => {
    expect(
      isConfiguredAdmin("  Admin@OpenBot.test ", [" admin@openbot.TEST "]),
    ).toBe(true);
  });
});
