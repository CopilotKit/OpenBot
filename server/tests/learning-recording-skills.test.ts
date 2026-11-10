import { afterEach, describe, expect, test } from "bun:test";
import type { PersonalReview, RecordingSkills } from "@openbot/shared/learning";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { SkillApprovalStore } from "../src/learning/approvals";
import { runtimeKeyClient } from "../src/learning/auto-assign";
import { personalLearningContainerId } from "../src/learning/personal-space";
import type { LearningSettingsStore } from "../src/learning/settings";
import type { LearningSharingStore } from "../src/learning/sharing";
import {
  createPersonalLearningRoutes,
  type PersonalLearningRouteDeps,
} from "../src/learning/sharing-routes";
import {
  type FakeIntelligence,
  fakeIntelligence,
  RUNTIME_KEY,
} from "./support/intelligence-learning";

/*
 * Teach a Bot, once a recording saves: which skills Learning proposed from that recording, and why Learning can't run
 * when OpenBot Desktop could give it no model. The person's routes are built directly over a fake Intelligence holding
 * their recordings space; nothing here reads OpenBot's database.
 */

const ada = "recording-skills-ada";
const SPACE = personalLearningContainerId(ada);
const PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d1";
/** The recording the fake Intelligence's evidence cites (support/intelligence-learning.ts `EVIDENCE`). */
const CITED = "0198a012-a20f-77c0-9e33-8992f18e74b0";
/** When the fake Intelligence made its proposal. */
const PROPOSED_AT = Date.parse("2026-11-04T12:00:00.000Z");
const served: FakeIntelligence[] = [];

afterEach(() => {
  for (const intelligence of served.splice(0)) intelligence.stop();
});

function routes(
  options: {
    /** The person's own recordings, by id, as `recordingTitles` names them: anybody else's are left out. */
    theirs?: Record<string, string>;
    noModel?: boolean;
    modelUnavailable?: PersonalLearningRouteDeps["modelUnavailable"];
  } = {},
) {
  const intelligence = fakeIntelligence("current", {
    containers: [SPACE],
    candidates: [PROPOSAL],
    ...(options.noModel ? { noModel: true } : {}),
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
      id: ada,
      email: `${ada}@example.test`,
      role: "user",
    });
    await next();
  };
  const theirs = options.theirs ?? { [CITED]: "Find my meeting" };
  const deps: PersonalLearningRouteDeps = {
    store: {} as LearningSharingStore,
    approvals: {} as SkillApprovalStore,
    skillsOf: async () => ({ skills: [] }),
    invalidate: () => {},
    sharingAllowed: async () => true,
    manage: client.experimental.learning,
    recordingTitles: async (userId, ids) =>
      new Map(
        userId === ada
          ? ids.flatMap((id) => {
              const title = theirs[id];
              return title === undefined ? [] : [[id, title] as const];
            })
          : [],
      ),
    ...(options.modelUnavailable
      ? { modelUnavailable: options.modelUnavailable }
      : {}),
    settings: {
      read: async () => ({
        enabled: true,
        defaultTarget: null,
        agents: {},
        personalReview: "people",
      }),
    } as unknown as LearningSettingsStore,
    scopesFor: async () => [
      { containerId: SPACE, kind: "recordings", label: "Your recordings" },
    ],
  };
  return { app: createPersonalLearningRoutes(deps, requireUser), intelligence };
}

const skillsFrom = async (
  app: ReturnType<typeof routes>["app"],
  title: string,
  since: number,
) => {
  const response = await app.request(
    `/recording-skills?title=${encodeURIComponent(title)}&since=${since}`,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as RecordingSkills).skills;
};

describe("the skills learned from one recording", () => {
  test("a proposal made since the recording stopped, citing the person's recording by its name, is that recording's skill", async () => {
    const { app } = routes();
    const skills = await skillsFrom(app, "Find my meeting", PROPOSED_AT - 1);
    expect(skills).toMatchObject([
      {
        id: PROPOSAL,
        status: "pending_review",
        operation: "add",
        container: SPACE,
      },
    ]);
  });

  test("a proposal from another recording, one made before this one stopped, or a recording that isn't theirs is not its skill", async () => {
    expect(
      await skillsFrom(routes().app, "Submit an expense report", 0),
    ).toEqual([]);
    // Made more than the clocks' slack before this recording stopped: it was learned from something earlier.
    expect(
      await skillsFrom(routes().app, "Find my meeting", PROPOSED_AT + 120_000),
    ).toEqual([]);
    // The evidence cites somebody else's recording, so it is never named for this person.
    expect(
      await skillsFrom(routes({ theirs: {} }).app, "Find my meeting", 0),
    ).toEqual([]);
  });

  test("an approved proposal is said to be approved, and a rejected one is left out", async () => {
    const { app, intelligence } = routes();
    const proposal = intelligence.candidates.get(PROPOSAL);
    if (!proposal) throw new Error("no proposal");
    intelligence.candidates.set(PROPOSAL, { ...proposal, status: "approved" });
    expect(await skillsFrom(app, "Find my meeting", 0)).toMatchObject([
      { id: PROPOSAL, status: "approved" },
    ]);
    intelligence.candidates.set(PROPOSAL, { ...proposal, status: "rejected" });
    expect(await skillsFrom(app, "Find my meeting", 0)).toEqual([]);
  });

  test("a request without a recording's name or when it stopped is refused", async () => {
    const { app } = routes();
    expect((await app.request("/recording-skills?since=1")).status).toBe(400);
    expect(
      (await app.request("/recording-skills?title=Find%20my%20meeting")).status,
    ).toBe(400);
  });
});

describe("Learning with no model on OpenBot Desktop", () => {
  const unsupported =
    "Learning can't run on the model you signed in with. To use it, sign OpenBot in with an OpenAI or Anthropic API key, or a Claude or ChatGPT plan.";

  test("the person's review says why Learning can't run, before anyone presses Learn now", async () => {
    const { app } = routes({ modelUnavailable: "unsupported" });
    const review = (await (
      await app.request("/review")
    ).json()) as PersonalReview;
    expect(review.modelProblem).toBe(unsupported);
    const without = (await (
      await routes().app.request("/review")
    ).json()) as PersonalReview;
    expect(without.modelProblem).toBeUndefined();
  });

  test("Learn now on the person's own recordings says the same, not the backend's setup", async () => {
    const { app } = routes({ noModel: true, modelUnavailable: "unsupported" });
    const response = await app.request(`/runs?container=${SPACE}`, {
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: unsupported });
  });
});
