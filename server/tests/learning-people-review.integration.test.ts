import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { learningSkillApprovals } from "../src/db/schema/learning";
import { createSkillApprovalStore } from "../src/learning/approvals";
import { runtimeKeyClient } from "../src/learning/auto-assign";
import { personalLearningContainerId } from "../src/learning/personal-space";
import {
  createLearningRoutes,
  type LearningAdminDependencies,
} from "../src/learning/routes";
import { createLearningSettingsStore } from "../src/learning/settings";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  type FakeIntelligence,
  fakeIntelligence,
  RUNTIME_KEY,
} from "./support/intelligence-learning";

const PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d1";
const served: FakeIntelligence[] = [];
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const approvals = createSkillApprovalStore(database);
const prefix = `people-review-${randomUUID()}`;
const reviewed = `${prefix}-ana`;
const audits: AuditEventInput[] = [];
const auditStore = {
  insert: async (event: AuditEventInput) => {
    audits.push(event);
  },
};
beforeAll(async () => {
  await database
    .insert(users)
    .values([{ id: reviewed, email: `${reviewed}@example.test` }]);
});
afterEach(async () => {
  audits.length = 0;
  await database
    .delete(learningSkillApprovals)
    .where(eq(learningSkillApprovals.userId, reviewed));
  for (const intelligence of served.splice(0)) intelligence.stop();
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [reviewed]));
});

function admin(
  extra: Partial<LearningAdminDependencies> = {},
  origins: { audit?: boolean } = {},
) {
  const intelligence = fakeIntelligence("current", {
    containers: [
      personalLearningContainerId("ana"),
      personalLearningContainerId(reviewed),
    ],
    candidates: [PROPOSAL],
  });
  served.push(intelligence);
  const client = runtimeKeyClient(
    intelligence.url,
    RUNTIME_KEY,
    "ws://127.0.0.1:9",
  );
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "admin-ada",
      email: "ada@example.com",
      name: "Ada",
      role: "admin",
    });
    await next();
  };
  return createLearningRoutes(
    {
      store: createLearningSettingsStore(),
      manage: client.experimental.learning,
      people: async () => [
        {
          userId: "ana",
          name: "Ana",
          containerId: personalLearningContainerId("ana"),
        },
        {
          userId: reviewed,
          name: "Reviewed",
          containerId: personalLearningContainerId(reviewed),
        },
        {
          userId: "bo",
          name: "Bo",
          containerId: personalLearningContainerId("bo"),
        },
      ],
      recordingTitles: async () => new Map(),
      ...extra,
    },
    requireUser,
    [],
    origins.audit ? auditStore : undefined,
  );
}

test("an admin lists people's pending proposals, each with the person's name", async () => {
  const response = await admin().request("/people/proposals");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    people: {
      userId: string;
      name: string;
      proposals: { id: string }[] | null;
    }[];
  };
  expect(body.people.map((person) => person.name)).toEqual([
    "Ana",
    "Reviewed",
    "Bo",
  ]);
  expect(body.people[0]?.proposals?.map((entry) => entry.id)).toEqual([
    PROPOSAL,
  ]);
  expect(body.people[2]?.proposals).toBeNull();
});

test("an admin reads one proposal from a person", async () => {
  const response = await admin().request(`/people/ana/proposals/${PROPOSAL}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { proposal: { id: string } };
  expect(body.proposal.id).toBe(PROPOSAL);
  expect(
    (await admin().request("/people/ana/proposals/not-an-id")).status,
  ).toBe(400);
});

test("an unknown person is not found", async () => {
  expect(
    (await admin().request(`/people/nobody/proposals/${PROPOSAL}`)).status,
  ).toBe(404);
});

test("an admin reads a person's published skill", async () => {
  const asked: [string, string][] = [];
  const routes = admin({
    personSkill: async (userId, name) => {
      asked.push([userId, name]);
      return name === "send-invoice"
        ? {
            name,
            description: "Send an invoice.",
            files: [{ path: "SKILL.md", text: "# Send an invoice" }],
          }
        : null;
    },
  });
  const known = await routes.request("/people/ana/skills/send-invoice");
  expect(known.status).toBe(200);
  const body = (await known.json()) as {
    skill: { files: { path: string; text: string }[] };
  };
  expect(body.skill.files[0]?.path).toBe("SKILL.md");
  expect(asked).toEqual([["ana", "send-invoice"]]);
  expect((await routes.request("/people/ana/skills/other-skill")).status).toBe(
    404,
  );
  expect(
    (await routes.request("/people/nobody/skills/send-invoice")).status,
  ).toBe(404);
  expect(
    (await routes.request(`/people/ana/skills/${"a".repeat(201)}`)).status,
  ).toBe(400);
  expect(
    (await admin().request("/people/ana/skills/send-invoice")).status,
  ).toBe(503);
  const failing = admin({
    personSkill: async () => {
      throw new Error("Intelligence is down");
    },
  });
  const failed = await failing.request("/people/ana/skills/send-invoice");
  expect(failed.status).toBe(503);
  expect(((await failed.json()) as { error: string }).error).toContain(
    "Intelligence",
  );
});

const post = (
  routes: ReturnType<typeof admin>,
  userId: string,
  id: string,
  action: string,
  headers: Record<string, string> = { "content-type": "application/json" },
) =>
  routes.request(`/people/${userId}/proposals/${id}/${action}`, {
    method: "POST",
    headers,
  });

test("an admin reviews a person's proposal and it is recorded as admin-approved", async () => {
  const routes = admin({ approvals }, { audit: true });
  const response = await post(routes, reviewed, PROPOSAL, "approve");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    proposal: { id: PROPOSAL, status: "approved" },
  });
  expect(
    await database
      .select()
      .from(learningSkillApprovals)
      .where(eq(learningSkillApprovals.userId, reviewed)),
  ).toMatchObject([{ skillName: "Refund triage", approvedBy: "admin" }]);
  expect(audits).toMatchObject([
    {
      targetId: PROPOSAL,
      actorUserId: "admin-ada",
      payload: {
        change: "skill_approved",
        userId: reviewed,
        containerId: personalLearningContainerId(reviewed),
      },
    },
  ]);
  const second = await post(routes, reviewed, PROPOSAL, "approve");
  expect(second.status).toBe(409);
  expect(audits.at(-1)?.payload).toMatchObject({
    change: "skill_review_failed",
    userId: reviewed,
  });
});

test("an admin rejects a person's proposal, and bad requests are refused", async () => {
  const routes = admin({ approvals }, { audit: true });
  const rejected = await post(routes, reviewed, PROPOSAL, "reject");
  expect(await rejected.json()).toEqual({
    proposal: { id: PROPOSAL, status: "rejected" },
  });
  expect(
    await database
      .select()
      .from(learningSkillApprovals)
      .where(eq(learningSkillApprovals.userId, reviewed)),
  ).toEqual([]);
  expect((await post(routes, reviewed, PROPOSAL, "approve", {})).status).toBe(
    403,
  );
  expect((await post(routes, reviewed, "nope", "approve")).status).toBe(400);
  expect((await post(routes, "nobody", PROPOSAL, "approve")).status).toBe(404);
  expect(
    (await post(admin({ manage: undefined }), "ana", PROPOSAL, "approve"))
      .status,
  ).toBe(503);
});
