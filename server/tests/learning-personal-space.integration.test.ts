import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LearnedSkillsError } from "@copilotkit/runtime/v2";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { learningPersonSpaces } from "../src/db/schema/learning";
import {
  createLearningContainer,
  type KeyIntelligence,
} from "../src/learning/ensure-container";
import {
  createPersonalLearningSpaces,
  createPersonSpaceStore,
  personalLearningContainerId,
} from "../src/learning/personal-space";
import { skillSnapshot } from "./fixtures/learned-skills";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Several OpenBot replicas making the same person's Learning space at once, against one database and one Intelligence.
 * Intelligence is faked as it behaves: a container id is unique per project, a second create answers 409
 * LEARNING_CONTAINER_ALREADY_EXISTS, and the runtime key's skills read says whether a container exists. Each replica
 * creates through the real service-token path in learning/ensure-container.ts.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const person = `personal-space-${randomUUID()}`;
const SPACE = personalLearningContainerId(person);
const API = "https://intelligence.customer.example";

const containers = new Map<string, string>();
const posts: { id: string; name: string }[] = [];
const fetch = Object.assign(
  async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(`${API}/api/learning/projects/7/containers`);
    expect(
      ((init?.headers ?? {}) as Record<string, string>)[
        "x-copilotkit-ei-service-token"
      ],
    ).toBe("synthetic-service-token");
    const body = JSON.parse(String(init?.body)) as { id: string; name: string };
    posts.push(body);
    // A real round trip, so the replicas genuinely overlap.
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (containers.has(body.id)) {
      return Response.json(
        {
          error: {
            code: "LEARNING_CONTAINER_ALREADY_EXISTS",
            message: "Taken.",
            category: "conflict",
            retryable: false,
          },
        },
        { status: 409 },
      );
    }
    containers.set(body.id, body.name);
    return Response.json(
      { container: { id: body.id, name: body.name, projectId: 7 } },
      { status: 201 },
    );
  },
  { preconnect: () => {} },
) as typeof globalThis.fetch;

const key: KeyIntelligence = {
  probe: async (containerId) =>
    containers.has(containerId) ? "present" : "absent",
  project: async () => undefined,
};

function replica() {
  return createPersonalLearningSpaces({
    readSettings: async () => ({
      enabled: true,
      defaultTarget: null,
      agents: {},
    }),
    snapshots: {
      getLearnedSkillsSnapshot: async ({
        containerId,
      }: {
        containerId: string;
      }) => {
        if (!containers.has(containerId))
          throw new LearnedSkillsError("CONTAINER_NOT_FOUND", false);
        return skillSnapshot();
      },
    } as never,
    store: createPersonSpaceStore(database),
    create: (container) =>
      createLearningContainer({
        directory: process.cwd(),
        apiUrl: API,
        nonInteractive: true,
        key,
        serviceToken: { token: "synthetic-service-token", projectId: "7" },
        fetch,
        container,
      }),
    nameFor: async () => "Ada Lovelace",
    log: () => {},
  });
}

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: person, email: `${person}@example.test` });
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [person]));
  await database.$client.close();
});

test("a person's space is created once across concurrent calls on several replicas", async () => {
  const replicas = [replica(), replica(), replica()];
  const answers = await Promise.all(
    replicas.flatMap((spaces) =>
      Array.from({ length: 5 }, () => spaces.state(person)),
    ),
  );

  for (const answer of answers)
    expect(answer).toEqual({ state: "assigned", containerId: SPACE });
  // Intelligence holds it once; each replica asked at most once, and a replica that lost the race was told it exists.
  expect([...containers.keys()]).toEqual([SPACE]);
  expect(containers.get(SPACE)).toBe("OpenBot: Ada Lovelace");
  expect(posts.length).toBeGreaterThanOrEqual(1);
  expect(posts.length).toBeLessThanOrEqual(replicas.length);
  expect(posts.every((post) => post.id === SPACE)).toBe(true);
  expect(
    await database
      .select({ containerId: learningPersonSpaces.containerId })
      .from(learningPersonSpaces)
      .where(eq(learningPersonSpaces.userId, person)),
  ).toEqual([{ containerId: SPACE }]);
});

test("a replica that starts after the space exists never asks Intelligence to create it", async () => {
  const before = posts.length;
  expect(await replica().state(person)).toEqual({
    state: "assigned",
    containerId: SPACE,
  });
  expect(posts.length).toBe(before);
});
