import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CopilotKitIntelligence,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import {
  type ExchangeResponse,
  RECORDER_SIGNED_OUT,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq, inArray } from "drizzle-orm";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import type { RoleRepository } from "../src/auth/guards";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { learningPersonSpaces } from "../src/db/schema/learning";
import { recorderTrajectoryBindings } from "../src/db/schema/recorder";
import type { LearningContainerSpec } from "../src/learning/ensure-container";
import {
  createPersonalLearningSpaces,
  createPersonSpaceStore,
  personalLearningContainerId,
} from "../src/learning/personal-space";
import { createLearningSettingsStore } from "../src/learning/settings";
import { createRecorderExtension } from "../src/recorder/wiring";
import { createRequestActor } from "../src/request-actor";
import { skillSnapshot } from "./fixtures/learned-skills";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { SESSION_LIFETIME_MS, testEnvironment } from "./support/environment";

/*
 * The capture pass end to end, through the app index.ts builds: the Recorder's routes, the runtime mounted with the
 * Recorder's gate and Learning space selector, and the request identity that answers the Recorder's bearer only here.
 * Intelligence is the one thing faked: its trajectory join answers a grant and records what it was asked, its skills
 * read says which Learning containers exist, and a service token's create makes one.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-pass-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const OWNER_COOKIE = { cookie: "test-session=owner" };

const config = loadConfig(
  testEnvironment({
    INTELLIGENCE_API_URL: "http://127.0.0.1:7100",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://127.0.0.1:7103",
  }),
);
const intelligenceApi = config.runtime.intelligence.apiUrl.replace(/\/$/, "");
const roleRepository: RoleRepository = { rolesForUser: async () => ["user"] };
const getSession = async ({ headers }: { headers: Headers }) => {
  const cookie = headers.get("cookie") ?? "";
  const id = cookie.includes("test-session=owner")
    ? owner
    : cookie.includes("test-session=stranger")
      ? stranger
      : null;
  return id
    ? { user: { id, email: `${id}@example.test`, name: `Person ${id}` } }
    : null;
};
const learning: LearningSettings = {
  enabled: true,
  defaultTarget: { containerId: "openbot" },
  agents: {},
};
const audits: AuditEventInput[] = [];
const auditStore = {
  insert: async (event: AuditEventInput) => {
    audits.push(event);
  },
};
const OWNER_SPACE = personalLearningContainerId(owner);
const STRANGER_SPACE = personalLearningContainerId(stranger);
/** The Learning containers Intelligence holds: the stranger's space exists, the owner's is made on first need. */
const containers = new Set([STRANGER_SPACE]);
const created: LearningContainerSpec[] = [];
const recorder = createRecorderExtension({
  config,
  database,
  organizationAuth: undefined,
  roleRepository,
  peopleStore: { isRevoked: async () => false },
  personalSpaces: createPersonalLearningSpaces({
    readSettings: async () => learning,
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
    create: async (container) => {
      created.push(container);
      if (containers.has(container.id)) return "present";
      containers.add(container.id);
      return "created";
    },
    log: () => {},
  }),
  sessionLifetimeMs: SESSION_LIFETIME_MS,
  auditStore,
});

const guard = createStallGuard({ stallMs: 0 });
const { identifyUser, identifyActor } = createRequestActor({
  singleUser: false,
  resolveRecorder: recorder.resolve,
  getSession: async (headers) => getSession({ headers }),
  rolesForUser: (id) => roleRepository.rolesForUser(id),
});
const runtime = mountCopilotRuntime(
  config,
  createActorAgentResolver({
    model: { provider: "openai", defaultModel: "unused" },
    loadAgents: async () => [],
    resolveModelApiKey: async () => "synthetic-key",
    stallGuard: guard,
  }),
  identifyUser,
  identifyActor,
  {
    learningSettings: createLearningSettingsStore(undefined, {
      containerId: "openbot",
    }),
    trajectoryCapture: recorder.trajectoryCapture,
  },
);
/*
 * createApp is positional. Placed by index rather than after a spread of `undefined`s, whose length
 * TypeScript cannot see, so each dependency is type-checked against the parameter it lands on: the
 * runtime every capture pass goes through is `copilotHandler`, and the audit store `auditStore`.
 */
const args = new Array(createApp.length) as unknown as Parameters<
  typeof createApp
>;
args[0] = config;
args[1] = {
  handler: () => new Response(null, { status: 204 }),
  api: { getSession },
} as never;
args[2] = roleRepository;
args[6] = runtime.handler;
args[12] = auditStore;
args[34] = { recorder };
const app = createApp(...args);

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, headers, ...rest } = init;
  return app.request(`http://openbot.test${path}`, {
    ...rest,
    headers: {
      ...(json === undefined ? {} : { "content-type": "application/json" }),
      ...(headers as Record<string, string>),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
};

/** What Intelligence's trajectory join was asked, in order. */
const joins: Array<{
  trajectoryId: string;
  appUserId: string;
  learningContainerIds?: string[];
}> = [];
const spies: Array<{ mockRestore(): void }> = [];
const tokens: Record<string, string> = {};

async function connectBrowser(person: string, installId: string) {
  const minted = await call(recorderPaths.connectCodes, {
    method: "POST",
    headers: {
      cookie: `test-session=${person === owner ? "owner" : "stranger"}`,
    },
    json: { via: "web" },
  });
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await call(recorderPaths.connections, {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { code, label: "Chrome", installId },
  });
  expect(exchanged.status).toBe(201);
  return ((await exchanged.json()) as ExchangeResponse).token;
}

/** The capture pass exactly as the Recorder asks for it: its bearer and `{}`. No Bot is named. */
function pass(trajectoryId: string, headers: Record<string, string>) {
  return call(recorderPaths.trajectoryConnect(trajectoryId), {
    method: "POST",
    headers,
    json: {},
  });
}

const as = (person: string) => ({
  authorization: `Bearer ${tokens[person]}`,
});

async function bindingOf(trajectoryId: string) {
  return database
    .select()
    .from(recorderTrajectoryBindings)
    .where(eq(recorderTrajectoryBindings.trajectoryId, trajectoryId))
    .then((rows) => rows.map(({ userId }) => ({ userId })));
}

beforeAll(async () => {
  spies.push(
    // `typeof fetch` carries Bun's `preconnect` as well as the call, so the stand-in has one too.
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url === `${intelligenceApi}/api/trajectories/join`) {
            const body = JSON.parse(
              String(init?.body),
            ) as (typeof joins)[number];
            joins.push(body);
            return Response.json({
              joinToken: `join-${joins.length}`,
              trajectoryId: body.trajectoryId,
            });
          }
          throw new Error(`No network in this test: ${url}`);
        },
        { preconnect: () => {} },
      ),
    ),
    // Nothing here may open a thread: a pass is not a run.
    spyOn(
      CopilotKitIntelligence.prototype,
      "getOrCreateThread",
    ).mockImplementation(async () => {
      throw new Error("No thread is opened in this test.");
    }),
  );
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test`, name: "The Owner" },
    { id: stranger, email: `${stranger}@example.test`, name: "A Stranger" },
  ]);
  tokens[owner] = await connectBrowser(owner, "1".repeat(32));
  tokens[stranger] = await connectBrowser(stranger, "2".repeat(32));
});

afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  guard.stop();
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});

describe("the capture pass", () => {
  const mine = randomUUID();

  test("a connected browser gets a pass with no Bot named, joined to the person's own Learning space", async () => {
    const answer = await pass(mine, as(owner));

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      joinToken: "join-1",
      realtime: {
        clientUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:7103\//),
        topic: `trajectory:${mine}`,
      },
    });
    expect(joins).toEqual([
      {
        trajectoryId: mine,
        appUserId: owner,
        learningContainerIds: [OWNER_SPACE],
      },
    ]);
    expect(await bindingOf(mine)).toEqual([{ userId: owner }]);
  });

  test("the person's space was made once, on first need, and OpenBot remembers it", async () => {
    expect(created.filter((spec) => spec.id === OWNER_SPACE)).toHaveLength(1);
    expect(
      await database
        .select({ containerId: learningPersonSpaces.containerId })
        .from(learningPersonSpaces)
        .where(eq(learningPersonSpaces.userId, owner)),
    ).toEqual([{ containerId: OWNER_SPACE }]);
  });

  test("a reconnect asks for a fresh pass and gets one, joined to the same space", async () => {
    const answer = await pass(mine, as(owner));

    expect(answer.status).toBe(200);
    expect(joins.at(-1)).toEqual({
      trajectoryId: mine,
      appUserId: owner,
      learningContainerIds: [OWNER_SPACE],
    });
    expect(await bindingOf(mine)).toEqual([{ userId: owner }]);
  });

  test("the selector reads the binding: the person's own container for them, nothing for anyone else", async () => {
    const select = recorder.trajectoryCapture.selectLearningContainers;

    expect(
      await select({ trajectoryId: mine, user: { id: owner, name: "Owner" } }),
    ).toEqual([OWNER_SPACE]);
    expect(
      await select({
        trajectoryId: mine,
        user: { id: stranger, name: "Stranger" },
      }),
    ).toBeNull();
    expect(
      await select({
        trajectoryId: randomUUID(),
        user: { id: owner, name: "Owner" },
      }),
    ).toBeNull();
  });

  test("the Recorder reads the person's own space, which its popup warns about", async () => {
    const answer = await call(recorderPaths.learning, { headers: as(owner) });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      learning: { state: "assigned", containerId: OWNER_SPACE },
    });
  });

  describe("is refused, and never reaches Intelligence,", () => {
    let joined = 0;
    const refusedWith = async (
      response: Response,
      status: number,
      code: string,
    ) => {
      expect(response.status).toBe(status);
      expect(((await response.json()) as { code: string }).code).toBe(code);
      expect(joins.length).toBe(joined);
    };
    beforeAll(() => {
      joined = joins.length;
    });

    test("for a trajectory id that is not a UUID", async () => {
      await refusedWith(
        await pass("not-a-uuid", as(owner)),
        400,
        "INVALID_REQUEST",
      );
    });

    test("for a trajectory bound to someone else", async () => {
      await refusedWith(await pass(mine, as(stranger)), 404, "NOT_FOUND");
      expect(await bindingOf(mine)).toEqual([{ userId: owner }]);
    });

    test("with neither a bearer nor a cookie", async () => {
      await refusedWith(await pass(randomUUID(), {}), 401, "IDENTITY_REQUIRED");
    });

    test("with only the person's signed-in session, because only a connected browser records", async () => {
      await refusedWith(
        await pass(randomUUID(), OWNER_COOKIE),
        401,
        "IDENTITY_REQUIRED",
      );
    });

    test("with a bearer that no longer resolves, as signed out", async () => {
      await refusedWith(
        await pass(randomUUID(), {
          authorization: `Bearer obr_${"z".repeat(43)}`,
        }),
        401,
        RECORDER_SIGNED_OUT,
      );
    });

    test("and each refusal is in the audit trail with its reason", () => {
      const reasons = audits
        .filter((event) => event.eventType === "recorder.trajectory_refused")
        .map((event) => (event.payload as { reason: string }).reason);
      expect(reasons).toEqual(
        expect.arrayContaining(["invalid-id", "bound-elsewhere", "signed-out"]),
      );
      expect(reasons).not.toContain("no-bot");
      expect(reasons).not.toContain("bot-forbidden");
    });
  });

  test("the other person's own trajectory still gets its pass, into their own space", async () => {
    const theirs = randomUUID();
    const answer = await pass(theirs, as(stranger));

    expect(answer.status).toBe(200);
    expect(joins.at(-1)).toEqual({
      trajectoryId: theirs,
      appUserId: stranger,
      learningContainerIds: [STRANGER_SPACE],
    });
    expect(await bindingOf(theirs)).toEqual([{ userId: stranger }]);
  });
});
