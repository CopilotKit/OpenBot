import { describe, expect, test } from "bun:test";
import {
  CopilotKitIntelligence,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import {
  createLearningRuntime,
  clearLearningRevisionFallback,
  selectLearningTarget,
} from "../src/learning/runtime";
import type { LearningSettingsStore } from "../src/learning/settings";
import type { LearningSettings } from "../../shared/learning";
import { skillSnapshot } from "./fixtures/learned-skills";

function fixture() {
  let settings: LearningSettings = {
    enabled: true,
    defaultTarget: { containerId: "openbot" },
    agents: {},
  };
  const bindings = new Map<string, string | null>();
  const store: LearningSettingsStore = {
    read: async () => settings,
    write: async (next) => {
      settings = next;
      return settings;
    },
    bindThread: async ({ userId, threadId, containerId }) => {
      const key = JSON.stringify([userId, threadId]);
      if (!bindings.has(key)) bindings.set(key, containerId);
      return bindings.get(key) ?? null;
    },
  };
  const client = new CopilotKitIntelligence({ apiKey: "synthetic-never-sent" });
  let exists = false;
  client.getThread = async ({ threadId }) => {
    if (exists) return { id: threadId, name: null };
    const error = new Error("Missing synthetic Thread");
    error.name = "PlatformRequestError";
    Object.assign(error, { status: 404 });
    throw error;
  };
  return {
    store,
    client,
    bindings,
    exists: () => {
      exists = true;
    },
  };
}

describe("Automatic Learning runtime", () => {
  test("disabled and excluded agents make no delivery request", async () => {
    const f = fixture();
    let requests = 0;
    f.client.getLearnedSkillsSnapshot = async () => {
      requests++;
      return skillSnapshot();
    };
    const learning = createLearningRuntime({
      store: f.store,
      client: f.client,
    });
    await f.store.write({
      enabled: false,
      defaultTarget: { containerId: "openbot" },
      agents: {},
    });
    expect(await learning.acquire("bot")).toBeUndefined();
    await f.store.write({
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      agents: { bot: null },
    });
    expect(await learning.acquire("bot")).toBeUndefined();
    expect(requests).toBe(0);
  });

  test("shares verified cache while each invocation keeps its own revision and supporting files", async () => {
    const f = fixture();
    let requests = 0;
    let revision: "r1" | "r2" = "r1";
    f.client.getLearnedSkillsSnapshot = async () => {
      requests++;
      return skillSnapshot(revision);
    };
    const learning = createLearningRuntime({
      store: f.store,
      client: f.client,
      freshnessWindowMs: 0,
    });
    const first = await learning.acquire("bot");
    expect(first?.catalog).toContain("public-answer");
    expect(
      await first?.execute("copilotkit_load_skill", {
        skill_name: "public-answer",
      }),
    ).toContain("guidance r1");
    expect(
      await first?.execute("copilotkit_read_skill_file", {
        skill_name: "public-answer",
        path: "reference.txt",
      }),
    ).toBe("Public supporting fact r1.");
    revision = "r2";
    const second = await learning.acquire("bot");
    expect(
      await second?.execute("copilotkit_load_skill", {
        skill_name: "public-answer",
      }),
    ).toContain("guidance r2");
    expect(
      await first?.execute("copilotkit_load_skill", {
        skill_name: "public-answer",
      }),
    ).toContain("guidance r1");
    expect(requests).toBe(2);
    await expect(
      first?.execute("copilotkit_read_skill_file", {
        skill_name: "public-answer",
        path: "../secret",
      }),
    ).rejects.toThrow();
  });

  test("SDK freshness cache survives callers and confirmed denial blocks fresh invocations", async () => {
    const f = fixture();
    let requests = 0;
    f.client.getLearnedSkillsSnapshot = async () => {
      requests++;
      return skillSnapshot();
    };
    const learning = createLearningRuntime({
      store: f.store,
      client: f.client,
    });
    await learning.acquire("first");
    await learning.acquire("second");
    expect(requests).toBe(1);
    const alwaysRefresh = createLearningRuntime({
      store: f.store,
      client: f.client,
      freshnessWindowMs: 0,
    });
    const captured = await alwaysRefresh.acquire("first");
    f.client.getLearnedSkillsSnapshot = async () => {
      throw new LearnedSkillsError("DELIVERY_DISABLED", false);
    };
    await expect(alwaysRefresh.acquire("first")).rejects.toThrow();
    expect(
      await captured?.execute("copilotkit_load_skill", {
        skill_name: "public-answer",
      }),
    ).toContain("guidance r1");
  });

  test("thread assignment remains stable after admin edits and preexisting Threads stay unassigned", async () => {
    const f = fixture();
    const learning = createLearningRuntime({
      store: f.store,
      client: f.client,
    });
    const first = { agentId: "bot", threadId: "new-thread", userId: "person" };
    expect(await learning.containerForThread(first)).toBe("openbot");
    f.exists();
    await f.store.write({
      enabled: true,
      defaultTarget: { containerId: "changed" },
      agents: {},
    });
    expect(await learning.containerForThread(first)).toBe("openbot");
    expect(
      await learning.containerForThread({ ...first, threadId: "preexisting" }),
    ).toBeUndefined();
  });

  test("per-agent override is independent of provider and null excludes", () => {
    const settings = {
      enabled: true,
      defaultTarget: { containerId: "general" },
      agents: {
        bot: { containerId: "focused", revision: "r1" },
        excluded: null,
      },
    };
    expect(selectLearningTarget(settings, "bot")).toEqual({
      containerId: "focused",
      revision: "r1",
    });
    expect(selectLearningTarget(settings, "other")).toEqual({
      containerId: "general",
    });
    expect(selectLearningTarget(settings, "excluded")).toBeUndefined();
  });

  test("the selector scopes first bindings to the verified user before SDK ownership checks", async () => {
    const f = fixture();
    await f.store.write({
      enabled: true,
      defaultTarget: { containerId: "general" },
      agents: { specialist: { containerId: "specialist" } },
    });
    const identities: string[] = [];
    const getThread = f.client.getThread.bind(f.client);
    f.client.getThread = async (input) => {
      identities.push(input.userId);
      return getThread(input);
    };
    const learning = createLearningRuntime({
      client: f.client,
      store: f.store,
    });
    const threadId = "shared-looking-client-thread-id";
    expect(
      await learning.containerForThread({
        userId: "other-person",
        threadId,
        agentId: "specialist",
      }),
    ).toBe("specialist");
    expect(
      await learning.containerForThread({
        userId: "thread-owner",
        threadId,
        agentId: "bot",
      }),
    ).toBe("general");
    expect(identities).toEqual(["other-person", "thread-owner"]);
    expect(f.bindings.size).toBe(2);
    await expect(
      learning.containerForThread({ userId: "", threadId, agentId: "bot" }),
    ).rejects.toThrow("requires a verified user");
    expect(identities).toHaveLength(2);
  });
});

test("Admin can clear an environment-seeded pin and follow latest", async () => {
  const previous = process.env.CPK_INTELLIGENCE_SKILLS_REVISION;
  try {
    process.env.CPK_INTELLIGENCE_SKILLS_REVISION = "r1";
    const captured = {
      containerId: "openbot",
      revision: process.env.CPK_INTELLIGENCE_SKILLS_REVISION,
    };
    clearLearningRevisionFallback();
    const f = fixture();
    await f.store.write({ enabled: true, defaultTarget: captured, agents: {} });
    await f.store.write({
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      agents: {},
    });
    let requestedRevision: string | undefined;
    f.client.getLearnedSkillsSnapshot = async (request) => {
      requestedRevision = request.revision;
      return skillSnapshot("r2");
    };
    const invocation = await createLearningRuntime({
      client: f.client,
      store: f.store,
    }).acquire("bot");
    expect(requestedRevision).toBeUndefined();
    expect(
      await invocation?.execute("copilotkit_load_skill", {
        skill_name: "public-answer",
      }),
    ).toContain("guidance r2");
  } finally {
    if (previous === undefined)
      delete process.env.CPK_INTELLIGENCE_SKILLS_REVISION;
    else process.env.CPK_INTELLIGENCE_SKILLS_REVISION = previous;
  }
});

test("disabled routing does not query Intelligence or bind a Thread", async () => {
  const f = fixture();
  await f.store.write({ enabled: false, defaultTarget: null, agents: {} });
  let reads = 0;
  f.client.getThread = async () => {
    reads++;
    throw new Error("No network when disabled");
  };
  expect(
    await createLearningRuntime({
      client: f.client,
      store: f.store,
    }).containerForThread({
      threadId: "off",
      agentId: "bot",
      userId: "person",
    }),
  ).toBeUndefined();
  expect(reads).toBe(0);
  expect(f.bindings.size).toBe(0);
});

test("cancelling one acquisition leaves another run's shared refresh alive", async () => {
  const f = fixture();
  const snapshot = Promise.withResolvers<ReturnType<typeof skillSnapshot>>();
  let reads = 0;
  f.client.getLearnedSkillsSnapshot = async () => {
    reads++;
    return snapshot.promise;
  };
  const runtime = createLearningRuntime({ client: f.client, store: f.store });
  const controller = new AbortController();
  const first = runtime.acquire("first", controller.signal);
  const second = runtime.acquire("second");
  controller.abort(new Error("Selected run stopped"));
  await expect(first).rejects.toThrow("Selected run stopped");
  snapshot.resolve(skillSnapshot());
  expect((await second)?.catalog).toContain("public-answer");
  expect(reads).toBe(1);
});
