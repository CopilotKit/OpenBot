import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  LearningSettings,
  PersonalReview,
} from "@openbot/shared/learning";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { learningSkillApprovals } from "../src/db/schema/learning";
import { currentEdition, setEdition } from "../src/edition";
import { createSkillApprovalStore } from "../src/learning/approvals";
import { runtimeKeyClient } from "../src/learning/auto-assign";
import { personalLearningContainerId } from "../src/learning/personal-space";
import type { LearningManagement } from "../src/learning/review";
import { learningScopes } from "../src/learning/scopes";
import type { LearningSettingsStore } from "../src/learning/settings";
import { createLearningSharingStore } from "../src/learning/sharing";
import {
  createPersonalLearningRoutes,
  type PersonalLearningRouteDeps,
} from "../src/learning/sharing-routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  type FakeIntelligence,
  fakeIntelligence,
  RUNTIME_KEY,
} from "./support/intelligence-learning";

/*
 * Settings, Learning: the skills proposed from a person's own recordings that wait for their decision. The routes are
 * built directly with a header-driven sign-in, a real approval store and a fake Intelligence holding the person's space.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `personal-review-${randomUUID()}`;
const ada = `${prefix}-ada`;
const PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d1";
const EDITION = currentEdition();

const approvals = createSkillApprovalStore(database);
const store = createLearningSharingStore(database, approvals);
const served: FakeIntelligence[] = [];
const audits: AuditEventInput[] = [];
const auditStore = {
  insert: async (event: AuditEventInput) => {
    audits.push(event);
  },
};

beforeAll(async () => {
  await database
    .insert(users)
    .values([{ id: ada, email: `${ada}@example.test` }]);
});

afterEach(async () => {
  setEdition(EDITION);
  audits.length = 0;
  await database
    .delete(learningSkillApprovals)
    .where(eq(learningSkillApprovals.userId, ada));
  for (const intelligence of served.splice(0)) intelligence.stop();
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [ada]));
});

function review(options: {
  containers?: string[];
  personalReview?: LearningSettings["personalReview"];
  withManage?: boolean;
  manage?: LearningManagement;
  recordingTitles?: PersonalLearningRouteDeps["recordingTitles"];
  bundles?: Record<string, { path: string; content: string }[]>;
  containerSkills?: PersonalLearningRouteDeps["containerSkills"];
  defaultTarget?: string;
  autoApprover?: PersonalLearningRouteDeps["autoApprover"];
  written?: LearningSettings[];
  invalidate?: () => void;
}) {
  const intelligence = fakeIntelligence("current", {
    containers: options.containers ?? [personalLearningContainerId(ada)],
    candidates: [PROPOSAL],
    ...(options.bundles ? { bundles: options.bundles } : {}),
  });
  served.push(intelligence);
  const client = runtimeKeyClient(
    intelligence.url,
    RUNTIME_KEY,
    "ws://127.0.0.1:9",
  );
  const settings: LearningSettings = {
    enabled: true,
    defaultTarget: options.defaultTarget
      ? { containerId: options.defaultTarget }
      : null,
    agents: {},
    ...(options.personalReview
      ? { personalReview: options.personalReview }
      : {}),
  };
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: ada,
      email: `${ada}@example.test`,
      role: "user",
    });
    await next();
  };
  const deps: PersonalLearningRouteDeps = {
    store,
    approvals,
    skillsOf: async () => ({ skills: [] }),
    ...(options.containerSkills
      ? { containerSkills: options.containerSkills }
      : {}),
    invalidate: options.invalidate ?? (() => {}),
    sharingAllowed: async () => true,
    auditStore,
    ...(options.withManage === false
      ? {}
      : { manage: options.manage ?? client.experimental.learning }),
    ...(options.recordingTitles
      ? { recordingTitles: options.recordingTitles }
      : {}),
    ...(options.autoApprover ? { autoApprover: options.autoApprover } : {}),
    settings: {
      read: async () => settings,
      setAutoApprove: async (autoApprove: boolean) => {
        options.written?.push({ ...settings, autoApprove });
      },
    } as unknown as LearningSettingsStore,
    scopesFor: async (actor) =>
      learningScopes({ edition: currentEdition(), userId: actor.id, settings }),
  };
  return createPersonalLearningRoutes(deps, requireUser);
}

describe("reviewing the skills learned from your own recordings", () => {
  test("a person sees their pending proposals and the latest run for their space", async () => {
    const app = review({});
    const response = await app.request("/review");
    expect(response.status).toBe(200);
    const body = (await response.json()) as PersonalReview;
    expect(body.autoApprove).toBeNull();
    expect(body.canReview).toBe(false);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({
      containerId: personalLearningContainerId(ada),
      kind: "recordings",
      proposals: [{ id: PROPOSAL, status: "pending_review" }],
      latestRun: { status: "succeeded", trigger: "manual" },
    });
  });

  test("the review lists only pending proposals and the newest run", async () => {
    const candidate = (id: string, status: string) => ({
      id,
      title: id,
      description: "",
      reason: "",
      operation: "create",
      status,
      createdAt: "2026-11-01T00:00:00.000Z",
      reviewedAt: null,
    });
    const run = (id: string, createdAt: string, status: string) => ({
      id,
      status,
      triggerSource: "manual",
      candidateCount: 0,
      insightCount: 0,
      failureCode: null,
      createdAt,
      startedAt: createdAt,
      completedAt: createdAt,
    });
    const manage = {
      listLearningCandidates: async () => [
        candidate("pending-one", "pending_review"),
        candidate("approved-one", "approved"),
      ],
      listLearningRuns: async () => [
        run("old", "2026-11-01T00:00:00.000Z", "failed"),
        run("new", "2026-11-03T00:00:00.000Z", "succeeded"),
      ],
    } as unknown as LearningManagement;
    const body = (await (
      await review({ manage }).request("/review")
    ).json()) as PersonalReview;
    expect(body.sources[0]?.proposals?.map((entry) => entry.id)).toEqual([
      "pending-one",
    ]);
    expect(body.sources[0]?.latestRun?.status).toBe("succeeded");
  });

  test("whether a person can review follows who an admin chose, and the personal edition", async () => {
    const read = async (app: ReturnType<typeof review>) =>
      ((await (await app.request("/review")).json()) as PersonalReview)
        .canReview;
    expect(await read(review({ personalReview: "admins" }))).toBe(false);
    expect(await read(review({ personalReview: "people" }))).toBe(true);
    setEdition("personal");
    expect(await read(review({}))).toBe(true);
  });

  test("a space that cannot be read comes back without proposals or a run", async () => {
    const broken = () => Promise.reject(new Error("down"));
    const app = review({
      manage: {
        listLearningCandidates: broken,
        listLearningRuns: broken,
      } as unknown as LearningManagement,
    });
    const body = (await (
      await app.request("/review")
    ).json()) as PersonalReview;
    expect(body.sources[0]).toMatchObject({
      proposals: null,
      latestRun: null,
    });
  });

  test("a space not made yet reads as nothing to review, without an error", async () => {
    const app = review({ containers: [] });
    const body = (await (
      await app.request("/review")
    ).json()) as PersonalReview;
    expect(body.sources[0]).toMatchObject({
      proposals: [],
      latestRun: null,
    });
    expect(body.sources[0]?.unavailable).toBeUndefined();
  });

  test("Learning switched off in Intelligence reads as unavailable, not as empty", async () => {
    const failing = (code: string) =>
      Object.assign(new Error(code), { status: 404, code });
    for (const code of ["ROUTE_NOT_FOUND", "LEARNING_NOT_ENABLED"]) {
      const app = review({
        manage: {
          listLearningCandidates: async () => {
            throw failing(code);
          },
          listLearningRuns: async () => {
            throw failing(code);
          },
        } as unknown as LearningManagement,
      });
      const body = (await (
        await app.request("/review")
      ).json()) as PersonalReview;
      expect(body.sources[0]).toMatchObject({
        proposals: null,
        latestRun: null,
        unavailable: "learning-off",
      });
    }
  });

  test("with no Intelligence connection it answers 503", async () => {
    const app = review({ withManage: false });
    expect((await app.request("/review")).status).toBe(503);
  });

  test("another container than the person's own is not found", async () => {
    setEdition("team");
    const app = review({});
    expect(
      (await app.request(`/proposals/${PROPOSAL}?container=openbot`)).status,
    ).toBe(404);
  });

  test("evidence names the person's own recordings and no one else's", async () => {
    const asked: { userId: string; ids: string[] }[] = [];
    const read = async () => {
      const app = review({
        recordingTitles: async (userId, ids) => {
          asked.push({ userId, ids });
          return new Map([
            ["0198a012-a20f-77c0-9e33-8992f18e74b0", "Refund an order"],
            ["someone-elses-recording", "Not yours"],
          ]);
        },
      });
      const response = await app.request(
        `/proposals/${PROPOSAL}?container=${personalLearningContainerId(ada)}`,
      );
      expect(response.status).toBe(200);
      const { proposal } = (await response.json()) as {
        proposal: {
          insights: {
            evidence: { kind: string; id: string; title: string | null }[];
          }[];
        };
      };
      return proposal.insights
        .flatMap((insight) => insight.evidence ?? [])
        .filter((item) => item.kind === "recording");
    };
    const recordings = await read();
    expect(recordings.length).toBeGreaterThan(0);
    expect(
      recordings.find(
        (item) => item.id === "0198a012-a20f-77c0-9e33-8992f18e74b0",
      )?.title,
    ).toBe("Refund an order");
    expect(recordings.some((item) => item.title === "Not yours")).toBe(false);
    expect(asked.length).toBe(1);
    expect(asked[0]?.userId).toBe(ada);
    expect(asked[0]?.ids.length).toBeGreaterThan(0);
  });

  test("a bad proposal id answers 400 and no Intelligence connection answers 503", async () => {
    expect((await review({}).request("/proposals/nope")).status).toBe(400);
    expect(
      (await review({ withManage: false }).request(`/proposals/${PROPOSAL}`))
        .status,
    ).toBe(503);
  });
});

describe("approving and rejecting the skills learned from your own recordings", () => {
  const approve = (app: ReturnType<typeof review>, action = "approve") =>
    app.request(
      `/proposals/${PROPOSAL}/${action}?container=${personalLearningContainerId(ada)}`,
      { method: "POST" },
    );
  const rowsOf = () =>
    database
      .select()
      .from(learningSkillApprovals)
      .where(eq(learningSkillApprovals.userId, ada));
  const lastServed = () => served[served.length - 1] as FakeIntelligence;
  const approveRequests = (intelligence: FakeIntelligence) =>
    intelligence.requests.filter((entry) => /approve/.test(entry.path)).length;

  test("with admins approving, a person sees their pending proposals and cannot review them", async () => {
    const app = review({ personalReview: "admins" });
    for (const action of ["approve", "reject"]) {
      expect((await approve(app, action)).status).toBe(403);
    }
    expect(
      lastServed().requests.filter((entry) =>
        /approve|reject/.test(entry.path),
      ),
    ).toEqual([]);
    expect(await rowsOf()).toEqual([]);
  });

  test("with people approving, a person approves their own proposal and OpenBot records it as theirs", async () => {
    const app = review({ personalReview: "people" });
    const response = await approve(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      proposal: { id: PROPOSAL, status: "approved" },
    });
    expect(await rowsOf()).toMatchObject([
      { skillName: "Refund triage", approvedBy: "person" },
    ]);
    expect(audits).toMatchObject([
      {
        eventType: "configuration.changed",
        targetType: "learning_skill",
        actorUserId: ada,
        payload: { change: "skill_approved", by: `${ada}@example.test` },
      },
    ]);
  });

  test("the open-skill index is refreshed after the approval is recorded and before Intelligence publishes, and again after", async () => {
    const calls: number[] = [];
    let intelligence: FakeIntelligence | undefined;
    const app = review({
      personalReview: "people",
      invalidate: () => {
        calls.push(intelligence ? approveRequests(intelligence) : 0);
      },
    });
    intelligence = lastServed();
    expect((await approve(app)).status).toBe(200);
    expect((await rowsOf()).length).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toBe(0);
    expect(calls[calls.length - 1]).toBe(1);
  });

  test("a refused approval still refreshes the index", async () => {
    let invalidated = 0;
    const app = review({
      personalReview: "people",
      invalidate: () => {
        invalidated += 1;
      },
    });
    const intelligence = lastServed();
    const entry = intelligence.candidates.get(PROPOSAL);
    if (!entry) throw new Error("missing candidate");
    intelligence.candidates.set(PROPOSAL, { ...entry, status: "approved" });
    expect((await approve(app)).status).toBe(409);
    expect(invalidated).toBeGreaterThanOrEqual(1);
  });

  test("a person rejects a proposal and OpenBot records no approval", async () => {
    const app = review({ personalReview: "people" });
    const response = await approve(app, "reject");
    expect(response.status).toBe(200);
    expect(await rowsOf()).toEqual([]);
    expect(audits[0]?.payload).toMatchObject({ change: "skill_rejected" });
  });

  test("a refused approval leaves no record behind", async () => {
    const app = review({ personalReview: "people" });
    const intelligence = lastServed();
    const entry = intelligence.candidates.get(PROPOSAL);
    if (!entry) throw new Error("missing candidate");
    intelligence.candidates.set(PROPOSAL, { ...entry, status: "approved" });
    const response = await approve(app);
    expect(response.status).toBe(409);
    expect(await rowsOf()).toEqual([]);
    expect(audits[0]?.payload).toMatchObject({ change: "skill_review_failed" });
  });

  test("a skill without a name is not approved", async () => {
    const app = review({
      personalReview: "people",
      bundles: {
        [PROPOSAL]: [{ path: "SKILL.md", content: "# No front matter" }],
      },
    });
    const response = await approve(app);
    expect(response.status).toBe(422);
    expect(audits[0]?.payload).toMatchObject({
      change: "skill_review_failed",
      decision: "approve",
      code: "UNNAMED_SKILL",
    });
    expect(
      lastServed().requests.filter((entry) => entry.path.endsWith("/approve")),
    ).toEqual([]);
    expect(await rowsOf()).toEqual([]);
  });

  test("a bad id answers 400 and another container answers 404", async () => {
    const app = review({ personalReview: "people" });
    expect(
      (await app.request("/proposals/nope/approve", { method: "POST" })).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/proposals/${PROPOSAL}/approve?container=elsewhere`,
          {
            method: "POST",
          },
        )
      ).status,
    ).toBe(404);
  });
});

describe("Learn now on your own space", () => {
  const own = personalLearningContainerId(ada);
  const learn = (app: ReturnType<typeof review>, container = own) =>
    app.request(`/runs?container=${container}`, { method: "POST" });

  test("Learn now starts a run on the person's own space only while people approve", async () => {
    const admins = review({ personalReview: "admins" });
    expect((await learn(admins)).status).toBe(403);
    expect(
      (served[served.length - 1] as FakeIntelligence).requests.filter(
        (entry) => entry.method === "POST" && /runs/.test(entry.path),
      ),
    ).toEqual([]);

    const people = review({ personalReview: "people" });
    expect((await learn(people, "elsewhere")).status).toBe(404);
    const response = await learn(people);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run: { id: string; status: string };
    };
    expect(body.run.id).toBeTruthy();
    expect(audits).toMatchObject([
      {
        eventType: "configuration.changed",
        targetType: "learning",
        actorUserId: ada,
        payload: {
          change: "learning_run_started",
          containerId: own,
          runId: body.run.id,
          by: `${ada}@example.test`,
        },
      },
    ]);

    expect(
      (await learn(review({ personalReview: "people", withManage: false })))
        .status,
    ).toBe(503);
  });
});

describe("Your Skills in the personal edition", () => {
  const CONVERSATIONS = "conversations-space";
  const skill = (name: string, description: string) => ({
    name,
    description,
    files: [{ path: "SKILL.md", text: `# ${name}` }],
  });
  const spaces = new Map<string, ReturnType<typeof skill>[]>([
    [personalLearningContainerId(ada), [skill("mine", "From a recording")]],
    [
      CONVERSATIONS,
      [skill("mine", "Shadowed"), skill("chatty", "From a conversation")],
    ],
  ]);
  const containerSkills: PersonalLearningRouteDeps["containerSkills"] = async (
    id,
  ) => {
    const skills = spaces.get(id);
    return skills ? { skills } : { unavailable: "unavailable" };
  };

  test("the personal edition's Your Skills include skills learned from conversations", async () => {
    setEdition("personal");
    const app = review({ containerSkills, defaultTarget: CONVERSATIONS });
    const body = (await (await app.request("/")).json()) as {
      skills: { name: string; description: string; sharing: string }[];
    };
    expect(body.skills.map((entry) => entry.name)).toEqual(["mine", "chatty"]);
    expect(body.skills[0]?.description).toBe("From a recording");
    expect(body.skills[1]).toMatchObject({
      approvedBy: null,
      sharing: "none",
    });
    const found = await app.request("/skills/chatty");
    expect(found.status).toBe(200);
    expect(
      ((await found.json()) as { skill: { name: string } }).skill.name,
    ).toBe("chatty");
    expect((await app.request("/skills/nope")).status).toBe(404);
  });

  test("it says unavailable only when every space failed to read", async () => {
    setEdition("personal");
    const failing: PersonalLearningRouteDeps["containerSkills"] = async () => ({
      unavailable: "unavailable",
    });
    const body = (await (
      await review({
        containerSkills: failing,
        defaultTarget: CONVERSATIONS,
      }).request("/")
    ).json()) as { skills: unknown; unavailable?: string };
    expect(body.skills).toBeNull();
    expect(body.unavailable).toBe("unavailable");
  });

  test("the team edition keeps reading only the person's own space", async () => {
    setEdition("team");
    const body = (await (
      await review({ containerSkills, defaultTarget: CONVERSATIONS }).request(
        "/",
      )
    ).json()) as { skills: unknown[] };
    expect(body.skills).toEqual([]);
  });
});

describe("switching automatic approval on and off", () => {
  const put = (app: ReturnType<typeof review>, body: unknown) =>
    app.request("/auto-approve", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("auto-approve is not a route outside the personal edition", async () => {
    setEdition("team");
    const written: LearningSettings[] = [];
    const response = await put(review({ written }), { autoApprove: true });
    expect(response.status).toBe(404);
    expect(written).toEqual([]);
  });

  test("opening Learning in the personal edition approves what is pending first and says automatic approval is on", async () => {
    let sweeps = 0;
    const autoApprover = {
      sweep: async () => {
        sweeps += 1;
        return { approved: 1 };
      },
    };
    setEdition("personal");
    try {
      const response = await review({ autoApprover }).request("/review");
      expect(response.status).toBe(200);
      const body = (await response.json()) as PersonalReview;
      expect(body.autoApprove).toBe(true);
      expect(sweeps).toBe(1);
    } finally {
      setEdition(EDITION);
    }
    setEdition("team");
    try {
      const response = await review({ autoApprover }).request("/review");
      const body = (await response.json()) as PersonalReview;
      expect(body.autoApprove).toBeNull();
      expect(sweeps).toBe(1);
    } finally {
      setEdition(EDITION);
    }
  });

  test("turning automatic approval on approves what is pending", async () => {
    setEdition("personal");
    try {
      const written: LearningSettings[] = [];
      let sweeps = 0;
      const autoApprover = {
        sweep: async () => {
          sweeps += 1;
          return { approved: 1 };
        },
      };
      const app = review({ written, autoApprover });
      expect((await put(app, { autoApprove: "yes" })).status).toBe(400);
      expect(written).toEqual([]);

      const on = await put(app, { autoApprove: true });
      expect(on.status).toBe(200);
      expect(await on.json()).toEqual({ autoApprove: true });
      expect(written).toMatchObject([{ autoApprove: true }]);
      expect(sweeps).toBe(1);
      expect(audits).toMatchObject([
        {
          eventType: "configuration.changed",
          targetType: "learning",
          actorUserId: ada,
          payload: { change: "auto_approve", to: true },
        },
      ]);

      const off = await put(app, { autoApprove: false });
      expect(await off.json()).toEqual({ autoApprove: false });
      expect(written[1]).toMatchObject({ autoApprove: false });
      expect(sweeps).toBe(1);
    } finally {
      setEdition(EDITION);
    }
  });
});
