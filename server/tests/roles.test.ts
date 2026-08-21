import { describe, expect, test } from "bun:test";
import { reconcileRole, roleForEmail } from "../src/auth/roles";
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

describe("reconcileRole", () => {
  test("makes an address on the list an administrator", async () => {
    const { database, statements } = recordingDatabase();

    const role = await reconcileRole(database, "u1", "admin@openbot.test", [
      "admin@openbot.test",
    ]);

    expect(role).toBe("admin");
    expect(statements).toEqual([
      { kind: "delete", role: "" },
      { kind: "insert", role: "admin" },
    ]);
  });

  /**
   * The half that create-time assignment could never do.
   *
   * Taking somebody off the list has to remove the `admin` row, because the guard reads the set and
   * one leftover row keeps them an administrator for ever. Nothing else in the product can remove
   * it: there is no route that changes a role.
   */
  test("takes the role back from an address no longer on the list", async () => {
    const { database, statements } = recordingDatabase();

    const role = await reconcileRole(database, "u1", "former@openbot.test", [
      "admin@openbot.test",
    ]);

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

    await reconcileRole(database, "u1", "admin@openbot.test", [
      "admin@openbot.test",
    ]);

    expect(transactions).toBe(1);
  });
});
