import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { ExchangeResponse } from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { count, eq, inArray } from "drizzle-orm";
import { GATED_ROUTES, runtimeRun } from "../src/admin/gate";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import type { RoleRepository } from "../src/auth/guards";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { routines } from "../src/db/schema/coworker";
import {
  learningOpenSkills,
  learningSkillSharing,
} from "../src/db/schema/learning";
import { skills } from "../src/db/schema/plugins";
import { createLearningSettingsStore } from "../src/learning/settings";
import { createLearningSharingStore } from "../src/learning/sharing";
import { createRecorderExtension } from "../src/recorder/wiring";
import { createRequestActor } from "../src/request-actor";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { SESSION_LIFETIME_MS, testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-scope-${randomUUID()}`;
const owner = `${prefix}-owner`;
const ORIGIN = `chrome-extension://${RECORDER_EXTENSION_ID}`;
const BOT = `${prefix}-bot`;
const COOKIE = { cookie: "test-session=owner" };

const config = loadConfig(testEnvironment());
const roleRepository: RoleRepository = { rolesForUser: async () => ["user"] };
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

const recorder = createRecorderExtension({
  config,
  database,
  organizationAuth: undefined,
  roleRepository,
  peopleStore: { isRevoked: async () => false },
  personalSpaces: {
    containerFor: (userId) => `space-of-${userId}`,
    state: async () => ({ state: "unassigned", containerId: null }),
    kick: () => {},
  },
  sessionLifetimeMs: SESSION_LIFETIME_MS,
  auditStore,
});

// The agent resolver records every actor a run asks it to load Bots for, and serves the Bot to every
// one of them, anonymous included: the worst case, a Bot anyone can reach, so only identity refuses.
const loadedFor: string[] = [];
// Who Intelligence was asked to open a thread for. Reaching it is a run starting.
const threadsFor: string[] = [];
// Every fetch, refused: nothing in this file may dial Intelligence (or anything else).
const dialled: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const guard = createStallGuard({ stallMs: 0 });
const { identifyUser, identifyActor } = createRequestActor({
  singleUser: false,
  resolveRecorder: recorder.resolve,
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
      return [
        { id: BOT, name: "Bot", type: "built_in", systemPrompt: "Work." },
      ];
    },
    resolveModelApiKey: async () => "synthetic-key",
    stallGuard: guard,
  }),
  identifyUser,
  identifyActor,
  { learningSettings, trajectoryCapture: recorder.trajectoryCapture },
);

/*
 * createApp is positional. Placed by index rather than after a spread of `undefined`s, whose length
 * TypeScript cannot see, so each dependency is type-checked against the parameter it lands on: the
 * runtime a Recorder bearer is refused a run on is `copilotHandler`, and the Bots are
 * `agentProfileStore`.
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
args[9] = agentProfileStore;
args[12] = auditStore;
args[34] = {
  recorder,
  personalLearning: {
    store: createLearningSharingStore(database),
    skillsOf: async () => ({ skills: [] }),
    invalidate: () => {},
    sharingAllowed: async () => true,
  },
  approvals: {} as never,
};
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

async function counts() {
  const of = async (
    table:
      | typeof routines
      | typeof skills
      | typeof learningSkillSharing
      | typeof learningOpenSkills,
  ) => (await database.select({ n: count() }).from(table))[0]?.n ?? 0;
  return {
    routines: await of(routines),
    skills: await of(skills),
    sharing: await of(learningSkillSharing),
    openSkills: await of(learningOpenSkills),
  };
}

let token = "";

beforeAll(async () => {
  spies.push(
    spyOn(
      CopilotKitIntelligence.prototype,
      "getOrCreateThread",
    ).mockImplementation(async (input) => {
      threadsFor.push(input.userId);
      throw new Error("No thread is opened in this test.");
    }),
    // The Learning assignment asks whether the thread exists first: it does not.
    spyOn(CopilotKitIntelligence.prototype, "getThread").mockImplementation(
      async () => {
        const error = new Error("Missing synthetic Thread");
        error.name = "PlatformRequestError";
        Object.assign(error, { status: 404 });
        throw error;
      },
    ),
    // `typeof fetch` carries Bun's `preconnect` as well as the call, so the stand-in has one too.
    spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
          dialled.push(input instanceof Request ? input.url : String(input));
          throw new Error("No network in this test.");
        },
        { preconnect: () => {} },
      ),
    ),
  );
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
});
afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  guard.stop();
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
      ["GET", "/api/agents"],
      ["POST", "/api/agents", { name: "Sneaky" }],
      ["GET", "/api/approvals"],
      // Who else's Bots use the person's Skills is theirs to change in Settings, never the Recorder's.
      ["GET", "/api/settings/learning"],
      ["PUT", "/api/settings/learning/mode", { mode: "open" }],
      ["PUT", "/api/settings/learning/skills/refund", { open: true }],
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
    // The control: the person's own session reaches the Bot and starts a run as them.
    await run(COOKIE);
    expect(loadedFor).toContain(owner);
    expect(threadsFor).toEqual([owner]);
    const loaded = loadedFor.length;
    const answer = await run({ authorization: `Bearer ${token}` });
    expect(answer.ok).toBe(false);
    expect(threadsFor).toEqual([owner]);
    expect(loadedFor.slice(loaded)).not.toContain(owner);
    const intelligence = config.runtime.intelligence.apiUrl;
    expect(dialled.filter((url) => url.startsWith(intelligence))).toEqual([]);
  });

  test("no gate rule matches a recorder path", () => {
    for (const path of ["/api/recorder/me", "/api/recorder/learning"]) {
      expect(runtimeRun(path)).toBeNull();
      const matched = GATED_ROUTES.filter((rule) => rule.path.test(path));
      expect([path, matched.length]).toEqual([path, 0]);
    }
  });
});
