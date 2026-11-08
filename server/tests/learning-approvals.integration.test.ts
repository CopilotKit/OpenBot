import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
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

/** Answers a request on the version `requests()` lists now, as an admin who just opened it would. */
async function decide(
  userId: string,
  skillName: string,
  decision: "approved" | "declined",
) {
  return store.decideSharing(
    userId,
    skillName,
    decision,
    await requestedAt(userId, skillName),
  );
}

async function requestedAt(userId: string, skillName: string) {
  return (await store.requests()).find(
    (entry) => entry.userId === userId && entry.skillName === skillName,
  )?.updatedAt as string;
}

describe("skill approvals", () => {
  test("a person's update to a shared skill asks for sharing again", async () => {
    expect(await store.recordApproval(ada, "invoice", "person")).toEqual({
      existed: false,
      previous: null,
    });
    expect((await store.get(ada, "invoice"))?.sharing).toBe("none");
    expect(await store.requestSharing(ada, "invoice")).toBe(true);
    expect(await decide(ada, "invoice", "approved")).toBe(true);
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
    await decide(ada, "declined-one", "declined");
    await store.recordApproval(ada, "declined-one", "person");
    expect((await store.get(ada, "declined-one"))?.sharing).toBe("declined");
  });

  test("withheld lists person-approved skills not approved for sharing", async () => {
    await store.recordApproval(grace, "shared", "person");
    await store.requestSharing(grace, "shared");
    await decide(grace, "shared", "approved");
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
    expect(
      await store.decideSharing(
        grace,
        "not-asked",
        "approved",
        new Date().toISOString(),
      ),
    ).toBe(false);
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

  test("requestSharing leaves a request already waiting or decided as it is", async () => {
    await store.recordApproval(grace, "asked-twice", "person");
    expect(await store.requestSharing(grace, "asked-twice")).toBe(true);
    const asked = await requestedAt(grace, "asked-twice");
    expect(await store.requestSharing(grace, "asked-twice")).toBe(false);
    expect(await requestedAt(grace, "asked-twice")).toBe(asked);

    // An admin approves between the person's page reading "none" and its request arriving.
    expect(await decide(grace, "asked-twice", "approved")).toBe(true);
    expect(await store.requestSharing(grace, "asked-twice")).toBe(false);
    expect((await store.get(grace, "asked-twice"))?.sharing).toBe("approved");
  });

  test("requestSharing asks again after a decline", async () => {
    await store.recordApproval(grace, "asked-again", "person");
    await store.requestSharing(grace, "asked-again");
    await decide(grace, "asked-again", "declined");
    expect(await store.requestSharing(grace, "asked-again")).toBe(true);
    expect((await store.get(grace, "asked-again"))?.sharing).toBe("requested");
  });

  test("a request's version reads the same whatever the session's time zone and date style", async () => {
    await store.recordApproval(grace, "zoned", "person");
    await store.requestSharing(grace, "zoned");
    const seen = await database.transaction(async (transaction) => {
      await transaction.execute(sql`set local timezone = 'Asia/Kolkata'`);
      await transaction.execute(sql`set local datestyle = 'SQL, DMY'`);
      const elsewhere = createSkillApprovalStore(
        transaction as unknown as typeof database,
      );
      return (await elsewhere.requests()).find(
        (entry) => entry.userId === grace && entry.skillName === "zoned",
      )?.updatedAt as string;
    });
    expect(seen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(seen).toBe(await requestedAt(grace, "zoned"));
    expect(await store.decideSharing(grace, "zoned", "approved", seen)).toBe(
      true,
    );
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
    const record = await recordApprovalBefore(
      store,
      hopper,
      "admin",
    )({ files: skill(null), operation: "update" });
    await record.undo?.();
    await record.after?.();
    const rows = await database
      .select()
      .from(learningSkillApprovals)
      .where(eq(learningSkillApprovals.userId, hopper));
    expect(rows).toEqual([]);
  });

  test("a new name writes a person row and the undo removes it", async () => {
    const { undo } = await recordApprovalBefore(
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
    await undo?.();
    expect(await store.get(hopper, "fresh")).toBeNull();
  });

  test("an existing row survives the undo, as it was before", async () => {
    await store.recordApproval(hopper, "kept", "person");
    await store.requestSharing(hopper, "kept");
    await decide(hopper, "kept", "approved");
    const { undo } = await recordApprovalBefore(
      store,
      hopper,
      "admin",
    )({ files: skill("kept"), operation: "update" });
    expect((await store.get(hopper, "kept"))?.approvedBy).toBe("admin");
    await undo?.();
    expect(await store.get(hopper, "kept")).toEqual({
      userId: hopper,
      skillName: "kept",
      approvedBy: "person",
      sharing: "approved",
    });
  });

  test("remove keeps the row until Intelligence has removed the skill", async () => {
    await store.recordApproval(hopper, "removed", "person");
    const record = await recordApprovalBefore(
      store,
      hopper,
      "person",
    )({ files: skill("removed"), operation: "remove" });
    // Until the removal lands the skill is still published, so it stays held back from other people's Bots.
    expect((await store.get(hopper, "removed"))?.approvedBy).toBe("person");
    expect((await store.withheld([hopper])).get(hopper)?.has("removed")).toBe(
      true,
    );
    await record.undo?.();
    expect((await store.get(hopper, "removed"))?.approvedBy).toBe("person");
    await record.after?.();
    expect(await store.get(hopper, "removed")).toBeNull();
  });

  test("a confirmed remove leaves alone a row approved since", async () => {
    await store.recordApproval(hopper, "reapproved", "admin");
    const record = await recordApprovalBefore(
      store,
      hopper,
      "admin",
    )({ files: skill("reapproved"), operation: "remove" });
    await store.recordApproval(hopper, "reapproved", "person");
    await record.after?.();
    expect((await store.get(hopper, "reapproved"))?.approvedBy).toBe("person");
  });

  test("a remove of a skill with no row records nothing", async () => {
    const record = await recordApprovalBefore(
      store,
      hopper,
      "person",
    )({ files: skill("never-approved"), operation: "remove" });
    await record.after?.();
    await record.undo?.();
    expect(await store.get(hopper, "never-approved")).toBeNull();
  });

  test("an undo puts back the version an admin opened, so their decision still applies", async () => {
    await store.recordApproval(hopper, "reopened", "person");
    await store.requestSharing(hopper, "reopened");
    const opened = await requestedAt(hopper, "reopened");
    const record = await recordApprovalBefore(
      store,
      hopper,
      "person",
    )({ files: skill("reopened"), operation: "update" });
    expect(await requestedAt(hopper, "reopened")).not.toBe(opened);
    await record.undo?.();
    expect(await requestedAt(hopper, "reopened")).toBe(opened);
    expect(
      await store.decideSharing(hopper, "reopened", "approved", opened),
    ).toBe(true);
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
    await created.undo?.();
    expect((await store.get(hopper, "overlap"))?.approvedBy).toBe("admin");

    const later = await recordApprovalBefore(
      store,
      hopper,
      "person",
    )({ files: skill("overlap"), operation: "update" });
    await updated.undo?.();
    expect((await store.get(hopper, "overlap"))?.approvedBy).toBe("person");
    await later.undo?.();
    expect((await store.get(hopper, "overlap"))?.approvedBy).toBe("admin");
  });
});
