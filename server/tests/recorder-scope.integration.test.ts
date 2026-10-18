import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ExchangeResponse } from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { count, eq, inArray } from "drizzle-orm";
import { GATED_ROUTES, runtimeRun } from "../src/admin/gate";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { routines } from "../src/db/schema/coworker";
import { demonstrations } from "../src/db/schema/demonstrations";
import { skills } from "../src/db/schema/plugins";
import { createDemonstrationRecorder } from "../src/demonstrations/recording";
import { createDemonstrationStore } from "../src/demonstrations/store";
import { createLearningSettingsStore } from "../src/learning/settings";
import { createRecorderExtension } from "../src/recorder/wiring";
import { createRequestActor } from "../src/request-actor";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-scope-${randomUUID()}`;
const owner = `${prefix}-owner`;
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const BOT = `${prefix}-bot`;
const COOKIE = { cookie: "test-session=owner" };

const config = loadConfig(testEnvironment());
const roleRepository = { rolesForUser: async () => ["user" as const] };
const getSession = async ({ headers }: { headers: Headers }) =>
  headers.get("cookie")?.includes("test-session=owner")
    ? {
        user: {
          id: owner,
          email: `${owner}@example.test`,
          name: "The Owner",
        },
      }
    : null;
const bot = { id: BOT, name: "Bot", hidden: false, deletedAt: null };
const agentProfileStore = {
  list: async () => [bot],
  get: async (_actor: unknown, id: string) => (id === BOT ? bot : null),
} as never;
const auditStore = { insert: async (_event: AuditEventInput) => {} };

const demonstrationStore = createDemonstrationStore(database);
const demonstrationRecorder = createDemonstrationRecorder({
  store: demonstrationStore,
  ownsBot: async () => true,
  ownsSkill: async () => true,
});
const recorder = createRecorderExtension({
  config,
  database,
  organizationAuth: undefined,
  roleRepository,
  peopleStore: { isRevoked: async () => false },
  agentProfileStore,
  pluginStore: { agentOwner: async () => owner },
  actorFor: async (id) => ({ id, role: "user" }),
  learningSettingsStore: { read: async () => ({}) as never },
  snapshots: { getLearnedSkillsSnapshot: async () => ({}) as never },
  demonstrations: {
    store: demonstrationStore,
    recorder: demonstrationRecorder,
  },
  auditStore,
});

// The agent resolver records every actor a run asks it to load Bots for.
const loadedFor: string[] = [];
const guard = createStallGuard({ stallMs: 0 });
const { identifyUser, identifyActor } = createRequestActor({
  singleUser: false,
  getSession: async (headers) => getSession({ headers }),
  rolesForUser: (id) => roleRepository.rolesForUser(id),
});
const learningSettings = createLearningSettingsStore(undefined, {
  containerId: "general",
});
const runtime = mountCopilotRuntime(
  config,
  createActorAgentResolver({
    model: { provider: "openai", defaultModel: "unused" },
    loadAgents: async (actor) => {
      loadedFor.push(actor.id);
      return [];
    },
    resolveModelApiKey: async () => null,
    stallGuard: guard,
  }),
  identifyUser,
  identifyActor,
  { learningSettings },
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
  ...(Array.from({ length: 2 }) as never[]),
  agentProfileStore,
  ...(Array.from({ length: 2 }) as never[]),
  auditStore,
  ...(Array.from({ length: 21 }) as never[]),
  {
    recorder,
    approvals: {} as never,
    demonstrations: {
      store: demonstrationStore,
      recorder: demonstrationRecorder,
    },
  },
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

async function counts() {
  const of = async (
    table: typeof demonstrations | typeof routines | typeof skills,
  ) => (await database.select({ n: count() }).from(table))[0]?.n ?? 0;
  return {
    demonstrations: await of(demonstrations),
    routines: await of(routines),
    skills: await of(skills),
  };
}

let token = "";
let stoppedId = "";

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test`, name: "The Owner" });
  await database
    .insert(agents)
    .values({ id: BOT, name: "Bot", type: "built_in", configuration: {} });
  const minted = await call("/api/recorder/connect-codes", {
    method: "POST",
    headers: COOKIE,
    json: { via: "web" },
  });
  const { code } = (await minted.json()) as { code: string };
  const exchanged = await call("/api/recorder/connections", {
    method: "POST",
    headers: { origin: ORIGIN },
    json: { code, label: "Chrome on macOS", installId: "e".repeat(32) },
  });
  expect(exchanged.status).toBe(201);
  token = ((await exchanged.json()) as ExchangeResponse).token;
  const started = await demonstrationStore.start(
    owner,
    BOT,
    "Seeded",
    "computer",
  );
  await demonstrationStore.stop(owner, started.id);
  stoppedId = started.id;
});
afterAll(async () => {
  guard.stop();
  await database
    .delete(demonstrations)
    .where(inArray(demonstrations.ownerUserId, [owner]));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(inArray(users.id, [owner]));
  await database.$client.close();
});

describe("a recorder bearer works only on the Recorder's own routes", () => {
  test("the bearer is valid where it belongs", async () => {
    const me = await call("/api/recorder/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
  });

  test("every other route answers 401 and changes nothing", async () => {
    const before = await counts();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/api/demonstrations?botId=${BOT}`],
      ["POST", "/api/demonstrations", { botId: BOT, title: "Sneaky" }],
      ["POST", `/api/demonstrations/${stoppedId}/draft`, {}],
      ["POST", `/api/demonstrations/${stoppedId}/published`, {}],
      ["POST", `/api/demonstrations/${stoppedId}/schedule`, {}],
      ["DELETE", `/api/demonstrations/${stoppedId}`],
      ["GET", "/api/agents"],
      ["POST", "/api/agents", { name: "Sneaky" }],
      ["GET", "/api/approvals"],
      ["GET", `/api/demonstrations/${stoppedId}/media`],
      ["GET", `/api/demonstrations/${stoppedId}/media/m/content`],
    ];
    for (const [method, path, json] of routes) {
      const answer = await call(path, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(json === undefined ? {} : { json }),
      });
      expect([method, path, answer.status]).toEqual([method, path, 401]);
      expect(((await answer.json()) as { error: string }).error).toBe(
        "Authentication required.",
      );
    }
    expect(await counts()).toEqual(before);
  });

  test("a bearer on a Bot's run starts no run", async () => {
    const run = (headers: Record<string, string>) =>
      call(`/api/copilotkit/agent/${BOT}/run`, {
        method: "POST",
        headers,
        json: {
          threadId: "t",
          runId: "r",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
        },
      });
    // The control: the person's own session does reach the agent resolver, so the recording works.
    await run(COOKIE);
    expect(loadedFor).toContain(owner);
    const before = loadedFor.length;
    const answer = await run({ authorization: `Bearer ${token}` });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(loadedFor.slice(before)).not.toContain(owner);
  });

  test("no gate rule matches a recorder path", () => {
    for (const path of [
      "/api/recorder/me",
      "/api/recorder/demonstrations/x/actions",
      "/api/audio/transcriptions",
    ]) {
      expect(runtimeRun(path)).toBeNull();
      const matched = GATED_ROUTES.filter((rule) => rule.path.test(path));
      expect([path, matched.length]).toEqual([path, 0]);
    }
  });
});
