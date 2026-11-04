import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import {
  CopilotKitIntelligence,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import type {
  LearningSettings,
  PersonalLearningSharing,
} from "@openbot/shared/learning";
import { eq, inArray } from "drizzle-orm";
import { createEnterpriseStore } from "../src/admin/settings-store";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { loadConfig } from "../src/config";
import {
  createRequestAgents,
  type RegisteredAgent,
  standingRoleMessage,
} from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema";
import { users } from "../src/db/schema/core";
import { personalLearningContainerId } from "../src/learning/personal-space";
import { createLearningRuntime } from "../src/learning/runtime";
import type { LearningSettingsStore } from "../src/learning/settings";
import {
  createLearningSharingStore,
  createOpenSkillIndex,
} from "../src/learning/sharing";
import { skillArchive } from "./fixtures/learned-skill-archive";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/*
 * Settings, Learning end to end: the routes a person's screen calls, the Postgres rows they write, the audit trail, the
 * administrator's Skill sharing switch (the enterprise settings row Admin saves), and what a run of a Bot is offered, on
 * two replicas sharing one database. A run is built the way a person's chat turn builds it (the runtime's request
 * factory and the actor resolver) and its Skills are read from the request the model receives. Intelligence and the
 * model are faked: each person's space publishes a fixed set of Skills, and the model answers "Done.".
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `learning-sharing-${randomUUID()}`;
const ada = `${prefix}-ada`;
const grace = `${prefix}-grace`;
const config = loadConfig(testEnvironment());
const roleRepository = { rolesForUser: async () => ["user" as const] };
const audits: AuditEventInput[] = [];
const auditStore = {
  insert: async (event: AuditEventInput) => {
    audits.push(event);
  },
};
const store = createLearningSharingStore(database);
let invalidations = 0;
let clock = 1_000_000;
/** Two replicas' indexes over one database; only the first is told about changes made through its routes. */
const thisReplica = createOpenSkillIndex({
  read: () => store.openSources(),
  now: () => clock,
});
const otherReplica = createOpenSkillIndex({
  read: () => store.openSources(),
  now: () => clock,
});
const published: Record<string, ReturnType<typeof skillArchive>> = {
  [personalLearningContainerId(grace)]: skillArchive("grace-r1", [
    { name: "grace-picked", description: "Picked by Grace." },
    { name: "grace-private", description: "Kept by Grace." },
  ]),
  [personalLearningContainerId(ada)]: skillArchive("ada-r1", [
    { name: "ada-only" },
  ]),
};
let deliveryUp = true;
const client = new CopilotKitIntelligence({ apiKey: "synthetic-never-sent" });
client.getLearnedSkillsSnapshot = async ({ containerId }) => {
  const answer = deliveryUp ? published[containerId] : undefined;
  // Intelligence with its Learning delivery switched off.
  if (!answer) throw new LearnedSkillsError("DELIVERY_DISABLED", false);
  return answer;
};
const settings: LearningSettings = {
  enabled: true,
  defaultTarget: null,
  agents: {},
};
/** Admin, Enterprise controls, Skill sharing: the row the administrator's switch saves, read fresh as production does. */
const enterprise = createEnterpriseStore(database);
const sharingAllowed = async () => (await enterprise.settings()).skillSharing;
const setSharing = (on: boolean) =>
  enterprise.setSetting("skillSharing", on, "admin@example.test");
const runtimeFor = (index: typeof thisReplica) =>
  createLearningRuntime({
    store: { read: async () => settings } as unknown as LearningSettingsStore,
    client,
    freshnessWindowMs: 0,
    people: {
      containerFor: personalLearningContainerId,
      openSkills: () => index.sources(),
      sharingAllowed,
    },
  });
const learning = runtimeFor(thisReplica);
const learningElsewhere = runtimeFor(otherReplica);

/*
 * createApp is positional. Placed by index rather than after a spread of `undefined`s, whose length
 * TypeScript cannot see, so each dependency is type-checked against the parameter it lands on: the
 * audit store this file's audit-row tests read is `auditStore`, not `credentialService`.
 */
const args = new Array(createApp.length) as unknown as Parameters<
  typeof createApp
>;
args[0] = config;
/** The signed-in person a request's session names. */
const personIn = (headers: Headers) => {
  const cookie = headers.get("cookie") ?? "";
  return cookie.includes("person=ada")
    ? ada
    : cookie.includes("person=grace")
      ? grace
      : null;
};
args[1] = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = personIn(headers);
      return id
        ? { user: { id, email: `${id}@example.test`, name: id } }
        : null;
    },
  },
} as never;
args[2] = roleRepository;
args[12] = auditStore;
args[34] = {
  personalLearning: {
    store,
    skillsOf: (userId: string) => learning.personalSkills(userId),
    invalidate: () => {
      invalidations++;
      thisReplica.invalidate();
    },
    sharingAllowed,
  },
};
const app = createApp(...args);

/*
 * The Bots every person here can use: one built in, one at a remote AG-UI endpoint this file serves. Built per request
 * by the actor resolver with the Learning runtime's reader, exactly as index.ts wires it, so nothing here passes a
 * person to the reader by hand.
 */
const model = new LLMock();
model.onMessage(/.*/, () => ({ content: "Done." }));
const remoteRuns: unknown[] = [];
const remote = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const body = (await request.json()) as { threadId: string; runId: string };
    remoteRuns.push(body);
    return new Response(
      [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const roster: RegisteredAgent[] = [
  {
    id: "helper",
    name: "Helper",
    type: "built_in",
    systemPrompt: "Help the person.",
  },
  {
    id: "remote-helper",
    name: "Remote Helper",
    type: "remote_ag_ui",
    endpoint: `http://127.0.0.1:${remote.port}/`,
    standingMessage: standingRoleMessage({
      id: "remote-helper",
      name: "Remote Helper",
      title: "Helper",
      roleDescription: "Help the person.",
    }),
  },
];
const resolverFor = (runtime: typeof learning) =>
  createActorAgentResolver({
    loadAgents: async () => roster,
    model: { provider: "openai", defaultModel: "gpt-4o-mini" },
    resolveModelApiKey: async () => "synthetic-model-key",
    acquireLearnedSkills: runtime.acquire,
  });
const resolvers = new Map([
  [learning, resolverFor(learning)],
  [learningElsewhere, resolverFor(learningElsewhere)],
]);
const identifyActor = async (request: Request) => ({
  id: personIn(request.headers) ?? "",
  role: "user" as const,
});

/** The learned Skills a request put in front of a model: the names in the catalog a run adds, or none without one. */
function catalogIn(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const listed =
      /Available learned skills \(names and descriptions\):\n(\[.*\])\n<\/copilotkit_learned_skills>/s.exec(
        value,
      );
    if (listed?.[1])
      return (JSON.parse(listed[1]) as { name: string }[]).map(
        (skill) => skill.name,
      );
    return value.includes("<copilotkit_learned_skills>") ? [] : undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const found = catalogIn(entry);
      if (found) return found;
    }
  }
  return undefined;
}

/** Runs a built Bot once and says which learned Skills the model was offered. */
async function skillsOfferedBy(built: AbstractAgent): Promise<string[]> {
  const agent = built.clone();
  agent.setMessages([{ id: randomUUID(), role: "user", content: "Help me." }]);
  model.clearRequests();
  await agent.runAgent();
  const [request] = model.getRequests();
  return catalogIn(request?.body) ?? [];
}

const as = (person: "ada" | "grace") => ({ cookie: `person=${person}` });
const call = (
  path: string,
  person: "ada" | "grace" | null,
  init: { method?: string; json?: unknown } = {},
) =>
  app.request(`http://openbot.test${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(person ? as(person) : {}),
      ...(init.json === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
const read = async (person: "ada" | "grace") =>
  (await (
    await call("/api/settings/learning", person)
  ).json()) as PersonalLearningSharing;
/**
 * Which learned Skills the person's chat turn with the built-in Bot is offered, on the replica `runtime` runs on: the
 * Bot built for their request by the runtime's own request factory, run, and the model's request read.
 */
const offered = async (
  runtime: typeof learning,
  person: "ada" | "grace",
): Promise<string[]> => {
  const resolver = resolvers.get(runtime);
  if (!resolver) throw new Error("No resolver for that replica.");
  const agents = await createRequestAgents(
    identifyActor,
    resolver,
  )({
    request: new Request("http://openbot.test/api/copilotkit", {
      headers: as(person),
    }),
  });
  const helper = agents.helper;
  if (!helper) throw new Error("The built-in Bot was not built.");
  return skillsOfferedBy(helper);
};
const sharingAudits = () =>
  audits.filter((event) => event.eventType.startsWith("learning."));

const sharingRow = eq(enterpriseSettings.key, "skill_sharing");
let modelUrl: string | undefined;

beforeAll(async () => {
  await database.insert(users).values([
    { id: ada, email: `${ada}@example.test` },
    { id: grace, email: `${grace}@example.test` },
  ]);
  // Never saved: the default an administrator has not changed.
  await database.delete(enterpriseSettings).where(sharingRow);
  modelUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await model.start();
});

afterAll(async () => {
  if (modelUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = modelUrl;
  await model.stop();
  remote.stop(true);
  await database.delete(enterpriseSettings).where(sharingRow);
  await database.delete(users).where(inArray(users.id, [ada, grace]));
  await database.$client.close();
});

describe("Settings, Learning", () => {
  test("needs a signed-in person", async () => {
    expect((await call("/api/settings/learning", null)).status).toBe(401);
  });

  test("until an administrator turns on Skill sharing, opening anything to every Bot is refused, saying why, and nothing is written", async () => {
    expect(await read("grace")).toMatchObject({
      mode: "closed",
      sharingAllowed: false,
    });
    const refusals = [
      await call("/api/settings/learning/mode", "grace", {
        method: "PUT",
        json: { mode: "open" },
      }),
      await call("/api/settings/learning/mode", "grace", {
        method: "PUT",
        json: { mode: "choose" },
      }),
      await call("/api/settings/learning/skills/grace-picked", "grace", {
        method: "PUT",
        json: { open: true },
      }),
    ];
    for (const refused of refusals) {
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({
        error:
          "An admin hasn't turned on sharing Skills with every Bot, so your Skills stay with your own Bots.",
      });
    }
    expect(await store.read(grace)).toEqual({ mode: "closed", openSkills: [] });
    expect(sharingAudits()).toEqual([]);
    // Keeping them to their own Bots is always allowed.
    expect(
      (
        await call("/api/settings/learning/mode", "grace", {
          method: "PUT",
          json: { mode: "closed" },
        })
      ).status,
    ).toBe(200);
    await setSharing(true);
    expect((await read("grace")).sharingAllowed).toBe(true);
  });

  test("starts closed, listing the Skills in the person's own space, none open", async () => {
    expect(await read("grace")).toEqual({
      mode: "closed",
      sharingAllowed: true,
      skills: [
        { name: "grace-picked", description: "Picked by Grace.", open: false },
        { name: "grace-private", description: "Kept by Grace.", open: false },
      ],
    });
  });

  test("closed: only the person's own runs use their Skills", async () => {
    expect(await offered(learning, "grace")).toEqual([
      "grace-picked",
      "grace-private",
    ]);
    expect(await offered(learning, "ada")).toEqual(["ada-only"]);
  });

  test("open: every Bot uses them, at once on this replica, and on another within the index's TTL", async () => {
    const before = invalidations;
    const saved = await call("/api/settings/learning/mode", "grace", {
      method: "PUT",
      json: { mode: "open" },
    });
    expect(saved.status).toBe(200);
    expect(invalidations).toBe(before + 1);
    expect(await offered(learning, "ada")).toEqual([
      "ada-only",
      "grace-picked",
      "grace-private",
    ]);
    // The other replica read its index before the change and keeps it for its TTL.
    expect(await offered(learningElsewhere, "ada")).toEqual([
      "ada-only",
      "grace-picked",
      "grace-private",
    ]);
  });

  test("changing the choice writes one audit row naming the old and new choice; saving the same choice writes none", async () => {
    expect(sharingAudits()).toEqual([
      expect.objectContaining({
        eventType: "learning.sharing_changed",
        targetType: "learning_sharing",
        targetId: grace,
        actorUserId: grace,
        payload: { from: "closed", to: "open" },
      }),
    ]);
    await call("/api/settings/learning/mode", "grace", {
      method: "PUT",
      json: { mode: "open" },
    });
    expect(sharingAudits()).toHaveLength(1);
  });

  test("choose: only the Skills the person opens are used by every Bot", async () => {
    // The other replica has an index from the open step; let it age out first.
    await offered(learningElsewhere, "ada");
    await call("/api/settings/learning/mode", "grace", {
      method: "PUT",
      json: { mode: "choose" },
    });
    expect(await offered(learning, "ada")).toEqual(["ada-only"]);
    const opened = await call(
      "/api/settings/learning/skills/grace-picked",
      "grace",
      { method: "PUT", json: { open: true } },
    );
    expect(opened.status).toBe(200);
    expect(await offered(learning, "ada")).toEqual([
      "ada-only",
      "grace-picked",
    ]);
    expect((await read("grace")).skills).toEqual([
      { name: "grace-picked", description: "Picked by Grace.", open: true },
      { name: "grace-private", description: "Kept by Grace.", open: false },
    ]);
    // Grace's own runs still have both.
    expect(await offered(learning, "grace")).toEqual([
      "grace-picked",
      "grace-private",
    ]);
  });

  test("another replica sees a change once its index's TTL has passed", async () => {
    // Still the index it read while Grace's choice was open.
    expect(await offered(learningElsewhere, "ada")).toEqual([
      "ada-only",
      "grace-picked",
      "grace-private",
    ]);
    clock += 30_001;
    expect(await offered(learningElsewhere, "ada")).toEqual([
      "ada-only",
      "grace-picked",
    ]);
  });

  test("opening and closing a Skill each write an audit row; repeating one writes none", async () => {
    await call("/api/settings/learning/skills/grace-picked", "grace", {
      method: "PUT",
      json: { open: true },
    });
    await call("/api/settings/learning/skills/grace-picked", "grace", {
      method: "PUT",
      json: { open: false },
    });
    const skillRows = sharingAudits().filter(
      (event) => event.eventType !== "learning.sharing_changed",
    );
    expect(skillRows).toEqual([
      expect.objectContaining({
        eventType: "learning.skill_opened",
        targetType: "learned_skill",
        targetId: "grace-picked",
        actorUserId: grace,
        payload: { skill: "grace-picked" },
      }),
      expect.objectContaining({
        eventType: "learning.skill_closed",
        targetId: "grace-picked",
        payload: { skill: "grace-picked" },
      }),
    ]);
    expect(await offered(learning, "ada")).toEqual(["ada-only"]);
  });

  test("a closed choice keeps the picks, so choosing again opens the same Skills", async () => {
    await call("/api/settings/learning/skills/grace-picked", "grace", {
      method: "PUT",
      json: { open: true },
    });
    await call("/api/settings/learning/mode", "grace", {
      method: "PUT",
      json: { mode: "closed" },
    });
    expect(await offered(learning, "ada")).toEqual(["ada-only"]);
    await call("/api/settings/learning/mode", "grace", {
      method: "PUT",
      json: { mode: "choose" },
    });
    expect(await offered(learning, "ada")).toEqual([
      "ada-only",
      "grace-picked",
    ]);
  });

  test("a person's choice is theirs: another person's screen neither shows nor changes it", async () => {
    expect((await read("ada")).mode).toBe("closed");
    await call("/api/settings/learning/mode", "ada", {
      method: "PUT",
      json: { mode: "open" },
    });
    expect((await read("grace")).mode).toBe("choose");
  });

  test("refuses a choice that is not closed, open or choose, and a Skill name that is not one", async () => {
    expect(
      (
        await call("/api/settings/learning/mode", "grace", {
          method: "PUT",
          json: { mode: "everyone" },
        })
      ).status,
    ).toBe(400);
    for (const name of ["a/b", "x".repeat(201), " padded"]) {
      expect(
        (
          await call(
            `/api/settings/learning/skills/${encodeURIComponent(name)}`,
            "grace",
            { method: "PUT", json: { open: true } },
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await call("/api/settings/learning/skills/fine", "grace", {
          method: "PUT",
          json: { open: "yes" },
        })
      ).status,
    ).toBe(400);
  });

  test("Skills Intelligence does not deliver show as unavailable, and the choice still saves", async () => {
    deliveryUp = false;
    try {
      expect(await read("grace")).toEqual({
        mode: "choose",
        sharingAllowed: true,
        skills: null,
        unavailable: "unavailable",
      });
    } finally {
      deliveryUp = true;
    }
  });

  test("opening a Skill the person does not have is refused, and nothing is written", async () => {
    const before = await store.read(grace);
    const audited = sharingAudits().length;
    // Another person's Skill, and one not learned yet.
    for (const name of ["ada-only", "not-learned-yet"]) {
      const refused = await call(
        `/api/settings/learning/skills/${name}`,
        "grace",
        { method: "PUT", json: { open: true } },
      );
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({
        error: "You have no Skill by that name.",
      });
    }
    expect(
      (
        await call("/api/settings/learning/skills/not-learned-yet", "grace", {
          method: "PUT",
          json: { open: false },
        })
      ).status,
    ).toBe(404);
    // While Intelligence cannot say which Skills are hers, nothing is opened.
    deliveryUp = false;
    try {
      const unchecked = await call(
        "/api/settings/learning/skills/grace-private",
        "grace",
        { method: "PUT", json: { open: true } },
      );
      expect(unchecked.status).toBe(503);
    } finally {
      deliveryUp = true;
    }
    // With Automatic Learning off there are no Skills to open.
    settings.enabled = false;
    try {
      const off = await call(
        "/api/settings/learning/skills/grace-private",
        "grace",
        { method: "PUT", json: { open: true } },
      );
      expect(off.status).toBe(409);
      expect(await off.json()).toEqual({
        error:
          "An admin has turned off Automatic Learning, so you have no Skills to change.",
      });
    } finally {
      settings.enabled = true;
    }
    expect(await store.read(grace)).toEqual(before);
    expect(sharingAudits()).toHaveLength(audited);
  });

  test("a Skill opened before it left the person's space can still be closed", async () => {
    // Opened while it was published, and unpublished since.
    await store.setSkillOpen(grace, "retired-skill", true);
    const closed = await call(
      "/api/settings/learning/skills/retired-skill",
      "grace",
      { method: "PUT", json: { open: false } },
    );
    expect(closed.status).toBe(200);
    expect((await store.read(grace)).openSkills).not.toContain("retired-skill");
  });

  test("turning Skill sharing off takes every opened Skill out of other people's runs at once, keeps each choice, and still lets a person close theirs", async () => {
    await store.setMode(grace, "choose");
    await store.setSkillOpen(grace, "grace-picked", true);
    await store.setMode(ada, "closed");
    thisReplica.invalidate();
    expect(await offered(learning, "ada")).toEqual([
      "ada-only",
      "grace-picked",
    ]);

    await setSharing(false);
    // Asked on every run, so no index has to be read again first.
    expect(await offered(learning, "ada")).toEqual(["ada-only"]);
    expect(await offered(learning, "grace")).toEqual([
      "grace-picked",
      "grace-private",
    ]);
    expect(await read("grace")).toEqual({
      mode: "choose",
      sharingAllowed: false,
      skills: [
        { name: "grace-picked", description: "Picked by Grace.", open: true },
        { name: "grace-private", description: "Kept by Grace.", open: false },
      ],
    });
    const closed = await call(
      "/api/settings/learning/skills/grace-picked",
      "grace",
      { method: "PUT", json: { open: false } },
    );
    expect(closed.status).toBe(200);

    await setSharing(true);
    expect(await offered(learning, "ada")).toEqual(["ada-only"]);
    await call("/api/settings/learning/skills/grace-picked", "grace", {
      method: "PUT",
      json: { open: true },
    });
    expect(await offered(learning, "ada")).toEqual([
      "ada-only",
      "grace-picked",
    ]);
  });
});

/*
 * The run boundary itself. Nothing here hands a person to the Learning runtime: each Bot is built the way production
 * builds it for one person (agents/agent-resolver.ts), and what the model or the remote endpoint receives is read.
 */
describe("every path that builds a Bot for a person gives its runs their Skills and the ones others opened", () => {
  beforeAll(async () => {
    await setSharing(true);
    await store.setMode(grace, "choose");
    await store.setSkillOpen(grace, "grace-picked", true);
    await store.setMode(ada, "closed");
    thisReplica.invalidate();
  });

  test("a chat turn: the Bot the runtime builds for the signed-in person's request", async () => {
    expect(await offered(learning, "ada")).toEqual([
      "ada-only",
      "grace-picked",
    ]);
    expect(await offered(learning, "grace")).toEqual([
      "grace-picked",
      "grace-private",
    ]);
  });

  test("a routine, a channel's turn, an approval's continuation or a hop: the Bot built for its person without a request", async () => {
    const resolver = resolvers.get(learning);
    if (!resolver) throw new Error("No resolver for this replica.");
    const built = await resolver.resolveAgentForActor(
      { id: ada, role: "user" },
      "helper",
      { initiator: { kind: "routine", id: "routine-1" } },
    );
    expect(await skillsOfferedBy(built)).toEqual(["ada-only", "grace-picked"]);
  });

  test("a remote Bot: the catalog goes to its endpoint with the person's run", async () => {
    const resolver = resolvers.get(learning);
    if (!resolver) throw new Error("No resolver for this replica.");
    const agents = await createRequestAgents(
      identifyActor,
      resolver,
    )({
      request: new Request("http://openbot.test/api/copilotkit", {
        headers: as("ada"),
      }),
    });
    const remoteHelper = agents["remote-helper"];
    if (!remoteHelper) throw new Error("The remote Bot was not built.");
    const agent = remoteHelper.clone();
    agent.setMessages([
      { id: randomUUID(), role: "user", content: "Help me." },
    ]);
    remoteRuns.length = 0;
    await agent.runAgent();
    expect(remoteRuns).toHaveLength(1);
    expect(catalogIn(remoteRuns[0])).toEqual(["ada-only", "grace-picked"]);
  });
});

describe("the open-Skill index", () => {
  test("reads once per TTL, again at once after invalidate, and keeps its last answer when a read fails", async () => {
    let reads = 0;
    let fail = false;
    let now = 0;
    const index = createOpenSkillIndex({
      read: async () => {
        reads++;
        if (fail) throw new Error("database down");
        return [{ userId: "g", containerId: "user-g", skills: "all" }];
      },
      ttlMs: 1_000,
      now: () => now,
    });
    await index.sources();
    await index.sources();
    expect(reads).toBe(1);
    now += 1_001;
    await index.sources();
    expect(reads).toBe(2);
    index.invalidate();
    await index.sources();
    expect(reads).toBe(3);
    now += 1_001;
    fail = true;
    expect(await index.sources()).toEqual([
      { userId: "g", containerId: "user-g", skills: "all" },
    ]);
  });

  test("a read that began before a change never replaces what came after it", async () => {
    let release: () => void = () => {};
    let call = 0;
    const index = createOpenSkillIndex({
      read: async () => {
        call++;
        if (call === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return [];
        }
        return [{ userId: "g", containerId: "user-g", skills: "all" }];
      },
    });
    const stale = index.sources();
    index.invalidate();
    release();
    await stale;
    expect(await index.sources()).toHaveLength(1);
  });

  test("lists people who opened all or picked some; closed people and empty picks are left out", async () => {
    await store.setMode(ada, "open");
    await store.setMode(grace, "choose");
    await store.setSkillOpen(grace, "grace-picked", true);
    const sources = await store.openSources();
    const mine = sources.filter((source) =>
      [ada, grace].includes(source.userId),
    );
    expect(
      mine
        .map((source) => ({
          userId: source.userId,
          containerId: source.containerId,
          skills: source.skills === "all" ? "all" : [...source.skills].sort(),
        }))
        .sort((a, b) => a.userId.localeCompare(b.userId)),
    ).toEqual([
      {
        userId: ada,
        containerId: personalLearningContainerId(ada),
        skills: "all",
      },
      {
        userId: grace,
        containerId: personalLearningContainerId(grace),
        skills: ["grace-picked"],
      },
    ]);
    await store.setSkillOpen(grace, "grace-picked", false);
    expect(
      (await store.openSources()).some((source) => source.userId === grace),
    ).toBe(false);
  });
});
