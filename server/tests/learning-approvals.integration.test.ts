import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createSkillApprovalStore } from "../src/learning/approvals";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `learning-approvals-${randomUUID()}`;
const ada = `${prefix}-ada`;
const grace = `${prefix}-grace`;
const store = createSkillApprovalStore(database);

beforeAll(async () => {
  await database.insert(users).values([
    { id: ada, email: `${ada}@example.test` },
    { id: grace, email: `${grace}@example.test` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [ada, grace]));
  await database.$client.close();
});

describe("skill approvals", () => {
  test("a person's update to a shared skill asks for sharing again", async () => {
    expect(await store.recordApproval(ada, "invoice", "person")).toEqual({
      existed: false,
    });
    expect((await store.get(ada, "invoice"))?.sharing).toBe("none");
    expect(await store.requestSharing(ada, "invoice")).toBe(true);
    expect(await store.decideSharing(ada, "invoice", "approved")).toBe(true);
    expect((await store.get(ada, "invoice"))?.sharing).toBe("approved");

    expect(await store.recordApproval(ada, "invoice", "person")).toEqual({
      existed: true,
    });
    expect((await store.get(ada, "invoice"))?.sharing).toBe("requested");
    expect((await store.requests()).map((row) => row.skillName)).toContain(
      "invoice",
    );
  });

  test("an update keeps a sharing state that is not approved", async () => {
    await store.recordApproval(ada, "declined-one", "person");
    await store.requestSharing(ada, "declined-one");
    await store.decideSharing(ada, "declined-one", "declined");
    await store.recordApproval(ada, "declined-one", "person");
    expect((await store.get(ada, "declined-one"))?.sharing).toBe("declined");
  });

  test("withheld lists person-approved skills not approved for sharing", async () => {
    await store.recordApproval(grace, "shared", "person");
    await store.requestSharing(grace, "shared");
    await store.decideSharing(grace, "shared", "approved");
    await store.recordApproval(grace, "private", "person");
    await store.recordApproval(grace, "by-admin", "admin");

    const withheld = await store.withheld([grace, ada, `${prefix}-nobody`]);
    expect(withheld.get(grace)).toEqual(new Set(["private"]));
    expect(withheld.get(ada)?.has("invoice")).toBe(true);
    expect(withheld.get(ada)?.has("declined-one")).toBe(true);
    expect(withheld.has(`${prefix}-nobody`)).toBe(false);
    expect((await store.withheld([])).size).toBe(0);
  });

  test("requestSharing refuses an admin-approved skill", async () => {
    await store.recordApproval(grace, "admin-skill", "admin");
    expect(await store.requestSharing(grace, "admin-skill")).toBe(false);
    expect(await store.requestSharing(grace, "never-seen")).toBe(false);
    expect((await store.get(grace, "admin-skill"))?.sharing).toBe("none");
  });

  test("decideSharing acts only on a requested person skill", async () => {
    await store.recordApproval(grace, "not-asked", "person");
    expect(await store.decideSharing(grace, "not-asked", "approved")).toBe(
      false,
    );
  });

  test("forget deletes the row", async () => {
    await store.recordApproval(grace, "gone", "person");
    await store.forget(grace, "gone");
    expect(await store.get(grace, "gone")).toBeNull();
  });
});
