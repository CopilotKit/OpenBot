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
import { inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
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

beforeAll(async () => {
  await database
    .insert(users)
    .values([{ id: ada, email: `${ada}@example.test` }]);
});

afterEach(() => {
  setEdition(EDITION);
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
}) {
  const intelligence = fakeIntelligence("current", {
    containers: options.containers ?? [personalLearningContainerId(ada)],
    candidates: [PROPOSAL],
  });
  served.push(intelligence);
  const client = runtimeKeyClient(
    intelligence.url,
    RUNTIME_KEY,
    "ws://127.0.0.1:9",
  );
  const settings: LearningSettings = {
    enabled: true,
    defaultTarget: null,
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
    invalidate: () => {},
    sharingAllowed: async () => true,
    ...(options.withManage === false
      ? {}
      : { manage: options.manage ?? client.experimental.learning }),
    ...(options.recordingTitles
      ? { recordingTitles: options.recordingTitles }
      : {}),
    settings: {
      read: async () => settings,
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
    const app = review({ containers: [] });
    const body = (await (
      await app.request("/review")
    ).json()) as PersonalReview;
    expect(body.sources[0]).toMatchObject({
      proposals: null,
      latestRun: null,
    });
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
