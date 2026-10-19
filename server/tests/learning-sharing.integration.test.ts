import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CopilotKitIntelligence,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import type {
  LearningSettings,
  PersonalLearningSharing,
} from "@openbot/shared/learning";
import { inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
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
 * Settings, Learning end to end: the routes a person's screen calls, the Postgres rows they write, the audit trail, and
 * the open-Skill index a run reads, on two replicas sharing one database. Intelligence is faked: each person's space
 * publishes a fixed set of Skills.
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
const runtimeFor = (index: typeof thisReplica) =>
  createLearningRuntime({
    store: { read: async () => settings } as unknown as LearningSettingsStore,
    client,
    freshnessWindowMs: 0,
    people: {
      containerFor: personalLearningContainerId,
      openSkills: () => index.sources(),
    },
  });
const learning = runtimeFor(thisReplica);
const learningElsewhere = runtimeFor(otherReplica);

const app = createApp(
  config,
  {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get("cookie") ?? "";
        const id = cookie.includes("person=ada")
          ? ada
          : cookie.includes("person=grace")
            ? grace
            : null;
        return id
          ? { user: { id, email: `${id}@example.test`, name: id } }
          : null;
      },
    },
  } as never,
  roleRepository,
  ...(Array.from({ length: 9 }) as never[]),
  auditStore,
  ...(Array.from({ length: 21 }) as never[]),
  {
    personalLearning: {
      store,
      skillsOf: (userId: string) => learning.personalSkills(userId),
      invalidate: () => {
        invalidations++;
        thisReplica.invalidate();
      },
    },
  },
);

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
const offered = async (
  runtime: typeof learning,
  person: string,
): Promise<string[]> => {
  const run = await runtime.acquire("bot", undefined, person);
  const json = run?.catalog.match(/\[.*\]/s)?.[0];
  return json
    ? (JSON.parse(json) as { name: string }[]).map((skill) => skill.name)
    : [];
};
const sharingAudits = () =>
  audits.filter((event) => event.eventType.startsWith("learning."));

beforeAll(async () => {
  await database.insert(users).values([
    { id: ada, email: `${ada}@example.test` },
    { id: grace, email: `${grace}@example.test` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [ada, grace]));
  await database.$client.close();
});

describe("Settings, Learning", () => {
  test("needs a signed-in person", async () => {
    expect((await call("/api/settings/learning", null)).status).toBe(401);
  });

  test("starts closed, listing the Skills in the person's own space, none open", async () => {
    expect(await read("grace")).toEqual({
      mode: "closed",
      skills: [
        { name: "grace-picked", description: "Picked by Grace.", open: false },
        { name: "grace-private", description: "Kept by Grace.", open: false },
      ],
    });
  });

  test("closed: only the person's own runs use their Skills", async () => {
    expect(await offered(learning, grace)).toEqual([
      "grace-picked",
      "grace-private",
    ]);
    expect(await offered(learning, ada)).toEqual(["ada-only"]);
  });

  test("open: every Bot uses them, at once on this replica, and on another within the index's TTL", async () => {
    const before = invalidations;
    const saved = await call("/api/settings/learning/mode", "grace", {
      method: "PUT",
      json: { mode: "open" },
    });
    expect(saved.status).toBe(200);
    expect(invalidations).toBe(before + 1);
    expect(await offered(learning, ada)).toEqual([
      "ada-only",
      "grace-picked",
      "grace-private",
    ]);
    // The other replica read its index before the change and keeps it for its TTL.
    expect(await offered(learningElsewhere, ada)).toEqual([
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
    await offered(learningElsewhere, ada);
    await call("/api/settings/learning/mode", "grace", {
      method: "PUT",
      json: { mode: "choose" },
    });
    expect(await offered(learning, ada)).toEqual(["ada-only"]);
    const opened = await call(
      "/api/settings/learning/skills/grace-picked",
      "grace",
      { method: "PUT", json: { open: true } },
    );
    expect(opened.status).toBe(200);
    expect(await offered(learning, ada)).toEqual(["ada-only", "grace-picked"]);
    expect((await read("grace")).skills).toEqual([
      { name: "grace-picked", description: "Picked by Grace.", open: true },
      { name: "grace-private", description: "Kept by Grace.", open: false },
    ]);
    // Grace's own runs still have both.
    expect(await offered(learning, grace)).toEqual([
      "grace-picked",
      "grace-private",
    ]);
  });

  test("another replica sees a change once its index's TTL has passed", async () => {
    // Still the index it read while Grace's choice was open.
    expect(await offered(learningElsewhere, ada)).toEqual([
      "ada-only",
      "grace-picked",
      "grace-private",
    ]);
    clock += 30_001;
    expect(await offered(learningElsewhere, ada)).toEqual([
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
    expect(await offered(learning, ada)).toEqual(["ada-only"]);
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
    expect(await offered(learning, ada)).toEqual(["ada-only"]);
    await call("/api/settings/learning/mode", "grace", {
      method: "PUT",
      json: { mode: "choose" },
    });
    expect(await offered(learning, ada)).toEqual(["ada-only", "grace-picked"]);
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
        skills: null,
        unavailable: "unavailable",
      });
    } finally {
      deliveryUp = true;
    }
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
