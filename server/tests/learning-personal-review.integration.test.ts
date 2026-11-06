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
  LearningSource,
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
  scopes?: (userId: string) => LearningSource[];
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
    const id = context.req.header("x-person") ?? ada;
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
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
      : { manage: client.experimental.learning }),
    settings: {
      read: async () => settings,
    } as unknown as LearningSettingsStore,
    scopesFor: async (actor) =>
      options.scopes?.(actor.id) ??
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
});
