import { expect, test } from "bun:test";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";

test("creates a typed database boundary without opening a query", () => {
  const database = createDatabase(
    "postgres://openbot:openbot@localhost:5432/openbot",
    TEST_POOL,
  );

  expect(database.query.users).toBeDefined();
});
