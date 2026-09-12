import { describe, expect, test } from "bun:test";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

describe("TEST_DATABASE_URL isolation", () => {
  test("survives createDatabase deleting DATABASE_URL before a later connection opens", async () => {
    const databaseUrl = testDatabaseUrl();
    const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
    process.env.DATABASE_URL =
      "postgres://openbot:openbot@localhost:5432/openbot";

    const first = createDatabase(databaseUrl, TEST_POOL);
    try {
      const [firstRow] = await first.execute<{ name: string }>(
        "select current_database() as name",
      );
      expect(process.env.DATABASE_URL).toBeUndefined();

      const second = createDatabase(testDatabaseUrl(), TEST_POOL);
      try {
        const [secondRow] = await second.execute<{ name: string }>(
          "select current_database() as name",
        );

        expect(firstRow?.name).toBe(databaseName);
        expect(secondRow?.name).toBe(databaseName);
        expect(databaseName).not.toBe("openbot");
      } finally {
        await second.$client.close();
      }
    } finally {
      await first.$client.close();
    }
  });
});
