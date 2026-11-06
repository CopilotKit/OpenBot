import { afterEach, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { runtimeKeyClient } from "../src/learning/auto-assign";
import { personalLearningContainerId } from "../src/learning/personal-space";
import { createLearningRoutes } from "../src/learning/routes";
import { createLearningSettingsStore } from "../src/learning/settings";
import {
  type FakeIntelligence,
  fakeIntelligence,
  RUNTIME_KEY,
} from "./support/intelligence-learning";

const PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d1";
const served: FakeIntelligence[] = [];
afterEach(() => {
  for (const intelligence of served.splice(0)) intelligence.stop();
});

function admin() {
  const intelligence = fakeIntelligence("current", {
    containers: [personalLearningContainerId("ana")],
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
          userId: "bo",
          name: "Bo",
          containerId: personalLearningContainerId("bo"),
        },
      ],
      recordingTitles: async () => new Map(),
    },
    requireUser,
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
  expect(body.people.map((person) => person.name)).toEqual(["Ana", "Bo"]);
  expect(body.people[0]?.proposals?.map((entry) => entry.id)).toEqual([
    PROPOSAL,
  ]);
  expect(body.people[1]?.proposals).toBeNull();
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
