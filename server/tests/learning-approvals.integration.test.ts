import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { learningSkillApprovals } from "../src/db/schema/learning";
import {
  createSkillApprovalStore,
  recordApprovalBefore,
  UnnamedSkillError,
} from "../src/learning/approvals";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `learning-approvals-${randomUUID()}`;
const ada = `${prefix}-ada`;
const grace = `${prefix}-grace`;
const hopper = `${prefix}-hopper`;
const store = createSkillApprovalStore(database);

beforeAll(async () => {
  await database.insert(users).values([
    { id: ada, email: `${ada}@example.test` },
    { id: grace, email: `${grace}@example.test` },
    { id: hopper, email: `${hopper}@example.test` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [ada, grace, hopper]));
  await database.$client.close();
});

describe("skill approvals", () => {
  test("a person's update to a shared skill asks for sharing again", async () => {
    expect(await store.recordApproval(ada, "invoice", "person")).toEqual({
      existed: false,
      previous: null,
    });
    expect((await store.get(ada, "invoice"))?.sharing).toBe("none");
    expect(await store.requestSharing(ada, "invoice")).toBe(true);
    expect(await store.decideSharing(ada, "invoice", "approved")).toBe(true);
    expect((await store.get(ada, "invoice"))?.sharing).toBe("approved");

    expect(await store.recordApproval(ada, "invoice", "person")).toEqual({
      existed: true,
      previous: {
        userId: ada,
        skillName: "invoice",
        approvedBy: "person",
        sharing: "approved",
      },
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

  test("decideSharing with a stale requestedAt leaves the request waiting", async () => {
    await store.recordApproval(grace, "edited", "person");
    await store.requestSharing(grace, "edited");
    const seen = (await store.requests()).find(
      (entry) => entry.userId === grace && entry.skillName === "edited",
    )?.updatedAt as string;
    await store.recordApproval(grace, "edited", "person");
    expect(await store.decideSharing(grace, "edited", "approved", seen)).toBe(
      false,
    );
    expect((await store.get(grace, "edited"))?.sharing).toBe("requested");
    const current = (await store.requests()).find(
      (entry) => entry.userId === grace && entry.skillName === "edited",
    )?.updatedAt as string;
    expect(
      await store.decideSharing(grace, "edited", "approved", current),
    ).toBe(true);
  });

  test("two first approvals at once both succeed and exactly one says it created the row", async () => {
    const results = await Promise.all([
      store.recordApproval(grace, "raced", "person"),
      store.recordApproval(grace, "raced", "admin"),
    ]);
    expect(results.map((result) => result.existed).sort()).toEqual([
      false,
      true,
    ]);
    const second = results.find((result) => result.existed);
    expect(second?.previous).toEqual({
      userId: grace,
      skillName: "raced",
      approvedBy: results[0]?.existed ? "admin" : "person",
      sharing: "none",
    });
  });

  test("forget deletes the row", async () => {
    await store.recordApproval(grace, "gone", "person");
    await store.forget(grace, "gone");
    expect(await store.get(grace, "gone")).toBeNull();
  });
});

const skill = (name: string | null) => [
  {
    path: "SKILL.md",
    content: name === null ? "No front matter" : `---\nname: ${name}\n---\n`,
  },
];

describe("recordApprovalBefore", () => {
  test("an unnamed skill approved by a person throws and writes no row", async () => {
    const before = recordApprovalBefore(store, hopper, "person");
    await expect(
      before({ files: skill(null), operation: "add" }),
    ).rejects.toBeInstanceOf(UnnamedSkillError);
    const rows = await database
      .select()
      .from(learningSkillApprovals)
      .where(eq(learningSkillApprovals.userId, hopper));
    expect(rows).toEqual([]);
  });

  test("an unnamed skill approved by an admin gets an undo that does nothing", async () => {
    const undo = await recordApprovalBefore(
      store,
      hopper,
      "admin",
    )({ files: skill(null), operation: "update" });
    await undo();
    const rows = await database
      .select()
      .from(learningSkillApprovals)
      .where(eq(learningSkillApprovals.userId, hopper));
    expect(rows).toEqual([]);
  });

  test("a new name writes a person row and the undo removes it", async () => {
    const undo = await recordApprovalBefore(
      store,
      hopper,
      "person",
    )({ files: skill("fresh"), operation: "add" });
    expect(await store.get(hopper, "fresh")).toEqual({
      userId: hopper,
      skillName: "fresh",
      approvedBy: "person",
      sharing: "none",
    });
    await undo();
    expect(await store.get(hopper, "fresh")).toBeNull();
  });

  test("an existing row survives the undo, as it was before", async () => {
    await store.recordApproval(hopper, "kept", "person");
    await store.requestSharing(hopper, "kept");
    await store.decideSharing(hopper, "kept", "approved");
    const undo = await recordApprovalBefore(
      store,
      hopper,
      "admin",
    )({ files: skill("kept"), operation: "update" });
    expect((await store.get(hopper, "kept"))?.approvedBy).toBe("admin");
    await undo();
    expect(await store.get(hopper, "kept")).toEqual({
      userId: hopper,
      skillName: "kept",
      approvedBy: "person",
      sharing: "approved",
    });
  });

  test("remove forgets the row and the undo restores its approver", async () => {
    await store.recordApproval(hopper, "removed", "admin");
    const undo = await recordApprovalBefore(
      store,
      hopper,
      "person",
    )({ files: skill("removed"), operation: "remove" });
    expect(await store.get(hopper, "removed")).toBeNull();
    await undo();
    expect((await store.get(hopper, "removed"))?.approvedBy).toBe("admin");
  });

  test("undoing a remove puts back the row with its original stamp, so an earlier approval's undo still applies", async () => {
    const stampOf = async () => {
      const [row] = await database
        .select({
          stamp: sql<string>`${learningSkillApprovals.updatedAt}::text`,
        })
        .from(learningSkillApprovals)
        .where(
          and(
            eq(learningSkillApprovals.userId, hopper),
            eq(learningSkillApprovals.skillName, "stamped"),
          ),
        );
      return row?.stamp;
    };
    const approved = await recordApprovalBefore(
      store,
      hopper,
      "person",
    )({ files: skill("stamped"), operation: "add" });
    const before = await stampOf();
    const removed = await recordApprovalBefore(
      store,
      hopper,
      "admin",
    )({ files: skill("stamped"), operation: "remove" });
    expect(await store.get(hopper, "stamped")).toBeNull();
    await removed();
    expect(await stampOf()).toBe(before);
    await approved();
    expect(await store.get(hopper, "stamped")).toBeNull();
  });

  test("an undo of a remove leaves alone a row approved since", async () => {
    await store.recordApproval(hopper, "reapproved", "admin");
    const undo = await recordApprovalBefore(
      store,
      hopper,
      "admin",
    )({ files: skill("reapproved"), operation: "remove" });
    await store.recordApproval(hopper, "reapproved", "person");
    await undo();
    expect((await store.get(hopper, "reapproved"))?.approvedBy).toBe("person");
  });

  test("an undo leaves alone a row another approval changed since", async () => {
    const created = await recordApprovalBefore(
      store,
      hopper,
      "person",
    )({ files: skill("overlap"), operation: "add" });
    const updated = await recordApprovalBefore(
      store,
      hopper,
      "admin",
    )({ files: skill("overlap"), operation: "update" });
    await created();
    expect((await store.get(hopper, "overlap"))?.approvedBy).toBe("admin");

    const later = await recordApprovalBefore(
      store,
      hopper,
      "person",
    )({ files: skill("overlap"), operation: "update" });
    await updated();
    expect((await store.get(hopper, "overlap"))?.approvedBy).toBe("person");
    await later();
    expect((await store.get(hopper, "overlap"))?.approvedBy).toBe("admin");
  });
});
