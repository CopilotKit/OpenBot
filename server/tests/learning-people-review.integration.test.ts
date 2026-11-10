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
/** How many of the next audit writes throw, as a database that is down would. */
let auditFailures = 0;
const auditStore = {
  insert: async (event: AuditEventInput) => {
    if (auditFailures > 0) {
      auditFailures -= 1;
      throw new Error("audit database is down");
    }
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
  auditFailures = 0;
  await database
    .delete(learningSkillApprovals)
    .where(eq(learningSkillApprovals.userId, reviewed));
  for (const intelligence of served.splice(0)) intelligence.stop();
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [reviewed]));
});
afterAll(async () => {
  await database.$client.end();
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

test("a person whose space can't be read is logged, and the others still list", async () => {
  const logs = captureLogs();
  try {
    const base = admin();
    void base;
    const intelligence = fakeIntelligence("current", {
      containers: [],
      candidates: [],
    });
    served.push(intelligence);
    const learning = runtimeKeyClient(
      intelligence.url,
      RUNTIME_KEY,
      "ws://127.0.0.1:9",
    ).experimental.learning;
    const routes = admin({
      manage: {
        ...learning,
        listLearningCandidates: async (input) => {
          if (input.containerId === personalLearningContainerId("ana"))
            throw new Error(`down, key ${RUNTIME_KEY}`);
          return [];
        },
      },
    });
    const response = await routes.request("/people/proposals");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      people: { userId: string; proposals: unknown }[];
    };
    expect(body.people.map((person) => person.proposals)).toEqual([
      null,
      [],
      [],
    ]);
    const failed = logs.lines.map(
      (line) => JSON.parse(line) as { type: string; userId?: string },
    );
    expect(failed).toEqual([
      expect.objectContaining({
        type: "learning-people-proposals-failed",
        userId: "ana",
      }),
    ]);
    expect(logs.lines.join("\n")).not.toContain(RUNTIME_KEY);
  } finally {
    logs.restore();
  }
});

test("the people list reads at most four spaces at a time", async () => {
  let running = 0;
  let peak = 0;
  const base = admin();
  void base;
  const intelligence = fakeIntelligence("current", {
    containers: [],
    candidates: [],
  });
  served.push(intelligence);
  const client = runtimeKeyClient(
    intelligence.url,
    RUNTIME_KEY,
    "ws://127.0.0.1:9",
  );
  const routes = admin({
    manage: {
      ...client.experimental.learning,
      listLearningCandidates: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return [];
      },
    },
    people: async () =>
      Array.from({ length: 12 }, (_, index) => ({
        userId: `p${index}`,
        name: `P${index}`,
        containerId: personalLearningContainerId(`p${index}`),
      })),
  });
  const response = await routes.request("/people/proposals");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { people: unknown[] };
  expect(body.people).toHaveLength(12);
  expect(peak).toBe(4);
});

test("a people list that can't be read answers a generic 503", async () => {
  const logs = captureLogs();
  try {
    const routes = admin({
      people: async () => {
        throw new Error("secret-database-password");
      },
    });
    for (const path of [
      "/people/proposals",
      `/people/ana/proposals/${PROPOSAL}`,
      "/sharing-requests",
    ]) {
      const response = await routes.request(path);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("secret-database-password");
    }
    expect(logs.lines.join("\n")).not.toContain("secret-database-password");
  } finally {
    logs.restore();
  }
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
    "the backend",
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

test("approving a person's proposal refreshes the open-skill index", async () => {
  let invalidated = 0;
  const routes = admin({
    approvals,
    invalidate: () => {
      invalidated += 1;
    },
  });
  expect((await post(routes, reviewed, PROPOSAL, "approve")).status).toBe(200);
  // Once when the record is written before Intelligence is asked, once after the review settles.
  expect(invalidated).toBe(2);
});

test("a refused review still refreshes the open-skill index and takes the record back", async () => {
  let invalidated = 0;
  const routes = admin({
    approvals,
    invalidate: () => {
      invalidated += 1;
    },
  });
  expect((await post(routes, reviewed, PROPOSAL, "approve")).status).toBe(200);
  invalidated = 0;
  const second = await post(routes, reviewed, PROPOSAL, "approve");
  expect(second.status).toBe(409);
  expect(invalidated).toBeGreaterThanOrEqual(1);
});

/** Captures what the routes log, as one JSON line each. */
function captureLogs() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

test("an audit write that fails after Intelligence approved is logged, and the approval still answers", async () => {
  const logs = captureLogs();
  try {
    const routes = admin({ approvals }, { audit: true });
    auditFailures = 1;
    const response = await post(routes, reviewed, PROPOSAL, "approve");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      proposal: { id: PROPOSAL, status: "approved" },
    });
    // The success was not turned into a failed review.
    expect(audits).toEqual([]);
    expect(logs.lines).toHaveLength(1);
    expect(JSON.parse(logs.lines[0] as string)).toMatchObject({
      type: "learning-audit-failed",
    });
    expect(logs.lines[0]).not.toContain("audit database is down");
  } finally {
    logs.restore();
  }
});

test("a failure audit that throws does not hide the review's own failure", async () => {
  const routes = admin({ approvals }, { audit: true });
  expect((await post(routes, reviewed, PROPOSAL, "approve")).status).toBe(200);
  const logs = captureLogs();
  try {
    auditFailures = 1;
    const second = await post(routes, reviewed, PROPOSAL, "approve");
    expect(second.status).toBe(409);
    expect(
      logs.lines.some((line) => line.includes("learning-audit-failed")),
    ).toBe(true);
  } finally {
    logs.restore();
  }
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

const decide = (
  routes: ReturnType<typeof admin>,
  userId: string,
  skill: string,
  action: "approve" | "decline",
  headers: Record<string, string> = { "content-type": "application/json" },
  body?: unknown,
) =>
  routes.request(`/sharing-requests/${userId}/${skill}/${action}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Decides on the version `/sharing-requests` lists now, as the app does. */
async function decideCurrent(
  routes: ReturnType<typeof admin>,
  userId: string,
  skill: string,
  action: "approve" | "decline",
) {
  const listed = (await (await routes.request("/sharing-requests")).json()) as {
    requests: { userId: string; skillName: string; requestedAt: string }[];
  };
  const requestedAt = listed.requests.find(
    (entry) => entry.userId === userId && entry.skillName === skill,
  )?.requestedAt as string;
  return decide(routes, userId, skill, action, undefined, { requestedAt });
}

async function requestSharing(skillName: string) {
  await approvals.recordApproval(reviewed, skillName, "person");
  await approvals.requestSharing(reviewed, skillName);
}

test("a sharing request changed after the admin opened it answers 409 and stays requested", async () => {
  await requestSharing("Edited triage");
  const routes = admin({ approvals });
  const listed = (await (await routes.request("/sharing-requests")).json()) as {
    requests: { userId: string; skillName: string; requestedAt: string }[];
  };
  const seen = listed.requests.find(
    (entry) => entry.userId === reviewed && entry.skillName === "Edited triage",
  )?.requestedAt as string;
  await approvals.recordApproval(reviewed, "Edited triage", "person");
  const stale = await decide(
    routes,
    reviewed,
    "Edited triage",
    "approve",
    undefined,
    { requestedAt: seen },
  );
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: string }).error).toContain(
    "changed after you opened it",
  );
  expect((await approvals.get(reviewed, "Edited triage"))?.sharing).toBe(
    "requested",
  );
  const now = (await (await routes.request("/sharing-requests")).json()) as {
    requests: { userId: string; skillName: string; requestedAt: string }[];
  };
  const current = now.requests.find(
    (entry) => entry.userId === reviewed && entry.skillName === "Edited triage",
  )?.requestedAt as string;
  const fresh = await decide(
    routes,
    reviewed,
    "Edited triage",
    "approve",
    undefined,
    { requestedAt: current },
  );
  expect(fresh.status).toBe(200);
});

test("an admin approves a sharing request and the skill is no longer withheld", async () => {
  await requestSharing("Refund triage");
  let invalidated = 0;
  const routes = admin(
    {
      approvals,
      invalidate: () => {
        invalidated += 1;
      },
    },
    { audit: true },
  );
  const listed = await routes.request("/sharing-requests");
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    requests: { userId: string; name: string; skillName: string }[];
  };
  expect(body.requests.filter((entry) => entry.userId === reviewed)).toEqual([
    expect.objectContaining({ name: "Reviewed", skillName: "Refund triage" }),
  ]);
  expect(
    (await approvals.withheld([reviewed])).get(reviewed)?.has("Refund triage"),
  ).toBe(true);
  const response = await decideCurrent(
    routes,
    reviewed,
    "Refund triage",
    "approve",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sharing: "approved" });
  expect(
    (await approvals.withheld([reviewed]))
      .get(reviewed)
      ?.has("Refund triage") ?? false,
  ).toBe(false);
  expect(invalidated).toBe(1);
  expect(audits).toMatchObject([
    {
      eventType: "learning.sharing_decided",
      targetType: "learned_skill",
      targetId: "Refund triage",
      actorUserId: "admin-ada",
      payload: {
        skill: "Refund triage",
        userId: reviewed,
        decision: "approved",
      },
    },
  ]);
  const again = await decide(
    routes,
    reviewed,
    "Refund triage",
    "approve",
    undefined,
    { requestedAt: new Date().toISOString() },
  );
  expect(again.status).toBe(404);
  expect(audits).toHaveLength(1);
});

test("a sharing decision made when the audit write fails still answers, and is logged", async () => {
  await requestSharing("Refund triage");
  const routes = admin({ approvals }, { audit: true });
  const logs = captureLogs();
  try {
    auditFailures = 1;
    const response = await decideCurrent(
      routes,
      reviewed,
      "Refund triage",
      "approve",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sharing: "approved" });
    expect(
      logs.lines.some((line) => line.includes("learning-audit-failed")),
    ).toBe(true);
  } finally {
    logs.restore();
  }
});

test("a requested time that is not a full timestamp is refused before the database sees it", async () => {
  await requestSharing("Refund triage");
  const routes = admin({ approvals });
  for (const requestedAt of [
    "1",
    "2026",
    "2026-11-06",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-11-06T10:00:00",
    "2026-11-06T10:00:00Z; drop table users",
  ]) {
    const refused = await decide(
      routes,
      reviewed,
      "Refund triage",
      "approve",
      undefined,
      { requestedAt },
    );
    expect(refused.status).toBe(400);
  }
});

test("a sharing decision with an oversized body is refused", async () => {
  await requestSharing("Refund triage");
  const refused = await decide(
    admin({ approvals }),
    reviewed,
    "Refund triage",
    "approve",
    { "content-type": "application/json", "content-length": "10020" },
    { requestedAt: "x".repeat(10_000) },
  );
  expect(refused.status).toBe(413);
});

test("an admin declines a sharing request, and bad requests are refused", async () => {
  await requestSharing("Refund triage");
  const routes = admin({ approvals }, { audit: true });
  expect(
    (await decide(routes, reviewed, "Refund triage", "approve", {})).status,
  ).toBe(403);
  expect((await decide(routes, reviewed, "%20padded", "approve")).status).toBe(
    400,
  );
  expect(
    (await decide(routes, "nobody", "Refund triage", "approve")).status,
  ).toBe(404);
  for (const requestedAt of [undefined, "x", 5]) {
    const refused = await decide(
      routes,
      reviewed,
      "Refund triage",
      "approve",
      undefined,
      requestedAt === undefined ? {} : { requestedAt },
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "Open the request again, then decide.",
    });
  }
  const declined = await decideCurrent(
    routes,
    reviewed,
    "Refund triage",
    "decline",
  );
  expect(await declined.json()).toEqual({ sharing: "declined" });
  expect(
    (await admin({ approvals: undefined }).request("/sharing-requests")).status,
  ).toBe(503);
});

test("a user who is not an admin gets 403 on every people route", async () => {
  const userRoutes = createLearningRoutes(
    {
      store: createLearningSettingsStore(),
      approvals,
      people: async () => [],
    },
    (async (context, next) => {
      context.set("actor", {
        id: "person",
        email: "person@example.com",
        name: "Person",
        role: "user",
      });
      await next();
    }) as MiddlewareHandler<{ Variables: AppVariables }>,
  );
  const json = { "content-type": "application/json" };
  for (const [method, path] of [
    ["GET", "/people/proposals"],
    ["GET", `/people/ana/proposals/${PROPOSAL}`],
    ["GET", "/people/ana/skills/Refund triage"],
    ["POST", `/people/ana/proposals/${PROPOSAL}/approve`],
    ["POST", `/people/ana/proposals/${PROPOSAL}/reject`],
    ["GET", "/sharing-requests"],
    ["POST", "/sharing-requests/ana/Refund triage/approve"],
    ["POST", "/sharing-requests/ana/Refund triage/decline"],
  ] as const) {
    const response = await userRoutes.request(path, {
      method,
      headers: json,
    });
    expect(response.status).toBe(403);
  }
});
