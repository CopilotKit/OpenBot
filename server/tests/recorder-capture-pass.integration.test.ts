import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
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
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { recorderTrajectoryBindings } from "../src/db/schema/recorder";
import { createLearningSettingsStore } from "../src/learning/settings";
import { RECORDER_BOT_HEADER } from "../src/recorder/trajectory-gate";
import { createRecorderExtension } from "../src/recorder/wiring";
import { createRequestActor } from "../src/request-actor";
import { skillSnapshot } from "./fixtures/learned-skills";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/*
 * The capture pass end to end, through the app index.ts builds: the Recorder's routes, the runtime mounted with the
 * Recorder's gate and Learning space selector, and the request identity that answers the Recorder's bearer only here.
 * Intelligence is the one thing faked: its trajectory join answers a grant and records what it was asked.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-pass-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const BOT = `${prefix}-bot`;
const STRANGERS_BOT = `${prefix}-strangers-bot`;
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const OWNER_COOKIE = { cookie: "test-session=owner" };

const config = loadConfig(
  testEnvironment({
    INTELLIGENCE_API_URL: "http://127.0.0.1:7100",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://127.0.0.1:7103",
  }),
);
const intelligenceApi = config.runtime.intelligence.apiUrl.replace(/\/$/, "");
const roleRepository = { rolesForUser: async () => ["user" as const] };
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
// Each person may record only for their own Bot.
const botOwners: Record<string, string> = {
  [BOT]: owner,
  [STRANGERS_BOT]: stranger,
};
const learning: LearningSettings = {
  enabled: true,
  defaultTarget: { containerId: "openbot" },
  agents: { [BOT]: { containerId: "bot-space" } },
};
const audits: AuditEventInput[] = [];
const auditStore = {
  insert: async (event: AuditEventInput) => {
    audits.push(event);
  },
};
const probed: string[] = [];

const recorder = createRecorderExtension({
  config,
  database,
  organizationAuth: undefined,
  roleRepository,
  peopleStore: { isRevoked: async () => false },
  agentProfileStore: {
    list: async () => [],
    get: async () => null,
  } as never,
  pluginStore: { agentOwner: async (botId) => botOwners[botId] ?? null },
  actorFor: async (id) => ({ id, role: "user" }),
  learningSettingsStore: { read: async () => learning },
  snapshots: {
    getLearnedSkillsSnapshot: async ({
      containerId,
    }: {
      containerId: string;
    }) => {
      probed.push(containerId);
      return skillSnapshot();
    },
  } as never,
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
const app = createApp(
  config,
  {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession },
  } as never,
  roleRepository,
  ...(Array.from({ length: 3 }) as never[]),
  runtime.handler,
  ...(Array.from({ length: 5 }) as never[]),
  auditStore,
  ...(Array.from({ length: 21 }) as never[]),
  { recorder },
);

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

/** The capture pass exactly as the Recorder asks for it: its bearer, the picked Bot, and `{}`. */
function pass(trajectoryId: string, headers: Record<string, string>) {
  return call(recorderPaths.trajectoryConnect(trajectoryId), {
    method: "POST",
    headers,
    json: {},
  });
}

const as = (person: string, botId?: string) => ({
  authorization: `Bearer ${tokens[person]}`,
  ...(botId === undefined ? {} : { [RECORDER_BOT_HEADER]: botId }),
});

async function bindingOf(trajectoryId: string) {
  return database
    .select({
      userId: recorderTrajectoryBindings.userId,
      botId: recorderTrajectoryBindings.botId,
    })
    .from(recorderTrajectoryBindings)
    .where(eq(recorderTrajectoryBindings.trajectoryId, trajectoryId));
}

beforeAll(async () => {
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${intelligenceApi}/api/trajectories/join`) {
        const body = JSON.parse(String(init?.body)) as (typeof joins)[number];
        joins.push(body);
        return Response.json({
          joinToken: `join-${joins.length}`,
          trajectoryId: body.trajectoryId,
        });
      }
      throw new Error(`No network in this test: ${url}`);
    }),
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

  test("a connected browser gets a pass for its own Bot, joined to that Bot's Learning space", async () => {
    const answer = await pass(mine, as(owner, BOT));

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
        learningContainerIds: ["bot-space"],
      },
    ]);
    expect(probed).toContain("bot-space");
    expect(await bindingOf(mine)).toEqual([{ userId: owner, botId: BOT }]);
  });

  test("a reconnect asks for a fresh pass and gets one, joined to the same space", async () => {
    const answer = await pass(mine, as(owner, BOT));

    expect(answer.status).toBe(200);
    expect(joins.at(-1)).toEqual({
      trajectoryId: mine,
      appUserId: owner,
      learningContainerIds: ["bot-space"],
    });
    expect(await bindingOf(mine)).toEqual([{ userId: owner, botId: BOT }]);
  });

  test("the selector reads the binding: the Bot's container for its person, nothing for anyone else", async () => {
    const select = recorder.trajectoryCapture.selectLearningContainers;

    expect(
      await select({ trajectoryId: mine, user: { id: owner, name: "Owner" } }),
    ).toEqual(["bot-space"]);
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

    test("without the Bot header", async () => {
      const trajectoryId = randomUUID();
      await refusedWith(await pass(trajectoryId, as(owner)), 403, "FORBIDDEN");
      expect(await bindingOf(trajectoryId)).toEqual([]);
    });

    test("for a Bot the person cannot record for", async () => {
      const trajectoryId = randomUUID();
      await refusedWith(
        await pass(trajectoryId, as(owner, STRANGERS_BOT)),
        403,
        "FORBIDDEN",
      );
      expect(await bindingOf(trajectoryId)).toEqual([]);
    });

    test("for a trajectory id that is not a UUID", async () => {
      await refusedWith(
        await pass("not-a-uuid", as(owner, BOT)),
        400,
        "INVALID_REQUEST",
      );
    });

    test("for a trajectory bound to someone else", async () => {
      await refusedWith(
        await pass(mine, as(stranger, STRANGERS_BOT)),
        404,
        "NOT_FOUND",
      );
      expect(await bindingOf(mine)).toEqual([{ userId: owner, botId: BOT }]);
    });

    test("with neither a bearer nor a cookie", async () => {
      await refusedWith(
        await pass(randomUUID(), { [RECORDER_BOT_HEADER]: BOT }),
        401,
        "IDENTITY_REQUIRED",
      );
    });

    test("with only the person's signed-in session, because only a connected browser records", async () => {
      await refusedWith(
        await pass(randomUUID(), {
          ...OWNER_COOKIE,
          [RECORDER_BOT_HEADER]: BOT,
        }),
        401,
        "IDENTITY_REQUIRED",
      );
    });

    test("with a bearer that no longer resolves, as signed out", async () => {
      await refusedWith(
        await pass(randomUUID(), {
          authorization: `Bearer obr_${"z".repeat(43)}`,
          [RECORDER_BOT_HEADER]: BOT,
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
        expect.arrayContaining([
          "no-bot",
          "bot-forbidden",
          "invalid-id",
          "bound-elsewhere",
          "signed-out",
        ]),
      );
    });
  });

  test("the other person's own trajectory, for their own Bot, still gets its pass", async () => {
    const theirs = randomUUID();
    const answer = await pass(theirs, as(stranger, STRANGERS_BOT));

    expect(answer.status).toBe(200);
    // Their Bot has no space of its own, so it joins the deployment's default.
    expect(joins.at(-1)).toEqual({
      trajectoryId: theirs,
      appUserId: stranger,
      learningContainerIds: ["openbot"],
    });
    expect(await bindingOf(theirs)).toEqual([
      { userId: stranger, botId: STRANGERS_BOT },
    ]);
  });
});
