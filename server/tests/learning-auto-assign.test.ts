import { describe, expect, test } from "bun:test";
import {
  type CopilotKitIntelligence,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  type ContainerCreation,
  type ContainerProbe,
  classifyProbeError,
  createLearningAutoAssign,
  keyProject,
  probeLearningContainer,
  withLearningAutoAssign,
} from "../src/learning/auto-assign";
import { createLearningSettingsStore } from "../src/learning/settings";
import { skillSnapshot } from "./fixtures/learned-skills";

function harness(
  options: {
    enabled?: boolean;
    probe?: ContainerProbe | (() => Promise<ContainerProbe>);
    now?: () => number;
    minIntervalMs?: number;
    create?: () => Promise<ContainerCreation>;
    instructions?: string;
  } = {},
) {
  const store = createLearningSettingsStore();
  const events: AuditEventInput[] = [];
  const audit: AuditStore = {
    insert: async (event) => void events.push(event),
  };
  const logs: Record<string, unknown>[] = [];
  const probes: string[] = [];
  const probe = options.probe ?? "present";
  const autoAssign = createLearningAutoAssign({
    enabled: options.enabled ?? true,
    store,
    audit,
    probe: async (containerId) => {
      probes.push(containerId);
      return typeof probe === "function" ? probe() : probe;
    },
    log: (entry) => logs.push(entry),
    ...(options.create ? { create: options.create } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.minIntervalMs !== undefined
      ? { minIntervalMs: options.minIntervalMs }
      : {}),
  });
  return { store, events, logs, probes, autoAssign };
}

describe("probing a Learning container with the runtime key", () => {
  test.each([
    ["CONTAINER_NOT_FOUND", "absent"],
    ["REVISION_NOT_FOUND", "present"],
    ["DELIVERY_DISABLED", "present"],
    ["REVISION_REVOKED", "present"],
    ["ENTITLEMENT_REQUIRED", "not_entitled"],
    ["AUTHENTICATION_FAILED", "unavailable"],
    ["AUTHORIZATION_FAILED", "unavailable"],
    ["UNSUPPORTED_SERVER", "unavailable"],
  ] as const)("%s means %s", (code, expected) => {
    expect(classifyProbeError(new LearnedSkillsError(code, false))).toBe(
      expected,
    );
  });

  test("errors without a code, and non-errors, are unavailable", () => {
    expect(classifyProbeError(new Error("network down"))).toBe("unavailable");
    expect(classifyProbeError(null)).toBe("unavailable");
    expect(classifyProbeError("CONTAINER_NOT_FOUND")).toBe("unavailable");
  });

  test("a published snapshot means the container is there", async () => {
    const asked: string[] = [];
    expect(
      await probeLearningContainer(
        {
          getLearnedSkillsSnapshot: async (request) => {
            asked.push(request.containerId);
            expect(request.signal).toBeInstanceOf(AbortSignal);
            return skillSnapshot();
          },
        },
        "openbot",
      ),
    ).toBe("present");
    expect(asked).toEqual(["openbot"]);
  });

  test("a missing container and a timeout are told apart", async () => {
    expect(
      await probeLearningContainer(
        {
          getLearnedSkillsSnapshot: async () => {
            throw new LearnedSkillsError("CONTAINER_NOT_FOUND", false);
          },
        },
        "openbot",
      ),
    ).toBe("absent");
    expect(
      await probeLearningContainer(
        {
          getLearnedSkillsSnapshot: ({ signal }) =>
            new Promise((_, reject) =>
              signal?.addEventListener("abort", () => reject(signal.reason)),
            ),
        },
        "openbot",
        5,
      ),
    ).toBe("unavailable");
  });
});

describe("which project a runtime key belongs to", () => {
  const snapshot = (learning: string) =>
    ({ links: { learning, candidates: null, runs: null } }) as Awaited<
      ReturnType<CopilotKitIntelligence["getInspectorLearning"]>
    >;

  test("is read from the project's Learning link", async () => {
    for (const link of [
      "https://intelligence.copilotkit.ai/o/acme/support%20bots/learning",
      "https://intelligence.copilotkit.ai/o/acme/support%20bots/learning/openbot",
    ])
      expect(
        await keyProject({ getInspectorLearning: async () => snapshot(link) }),
      ).toEqual({ organizationSlug: "acme", projectSlug: "support bots" });
  });

  test("anything unreadable, failing or slow cannot prove a project", async () => {
    expect(
      await keyProject({
        getInspectorLearning: async () =>
          snapshot("https://intelligence.copilotkit.ai/settings"),
      }),
    ).toBeUndefined();
    expect(
      await keyProject({
        getInspectorLearning: async () => {
          throw new Error("403");
        },
      }),
    ).toBeUndefined();
    expect(
      await keyProject(
        { getInspectorLearning: () => new Promise(() => {}) },
        5,
      ),
    ).toBeUndefined();
  });
});

describe("automatic Learning container assignment", () => {
  test("assigns the openbot container when it exists and nobody chose one", async () => {
    const h = harness();
    expect(h.autoAssign.state()).toEqual({ state: "pending" });
    expect(await h.autoAssign.check()).toEqual({
      state: "assigned",
      containerId: "openbot",
    });
    expect(await h.store.read()).toEqual({
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      agents: {},
    });
    expect(h.probes).toEqual(["openbot"]);
    expect(h.events).toEqual([
      {
        eventType: "configuration.changed",
        targetType: "learning",
        initiator: { kind: "deployment" },
        payload: {
          change: "default_container_assigned_automatically",
          enabled: true,
          defaultContainerId: "openbot",
          botMappingCount: 0,
        },
      },
    ]);
    expect(h.logs).toEqual([
      expect.objectContaining({
        type: "learning-auto-assign",
        outcome: "assigned",
        containerId: "openbot",
      }),
    ]);
    // Settled: later checks do not ask Intelligence again.
    expect(await h.autoAssign.check()).toEqual({
      state: "assigned",
      containerId: "openbot",
    });
    expect(h.probes).toHaveLength(1);
  });

  test.each([
    [
      "a saved choice",
      { enabled: true, defaultTarget: { containerId: "mine" }, agents: {} },
    ],
    ["a saved off", { enabled: false, defaultTarget: null, agents: {} }],
    [
      "a saved on with no container",
      { enabled: true, defaultTarget: null, agents: {} },
    ],
  ] as const)("never overrides %s", async (_, saved) => {
    const h = harness();
    await h.store.write(saved);
    expect(await h.autoAssign.check()).toEqual({ state: "saved" });
    expect(await h.store.read()).toEqual(saved);
    expect(h.probes).toEqual([]);
    expect(h.events).toEqual([]);
  });

  test("does nothing when switched off or the environment names a container", async () => {
    const h = harness({ enabled: false });
    expect(h.autoAssign.state()).toEqual({ state: "off" });
    h.autoAssign.start();
    h.autoAssign.kick();
    expect(await h.autoAssign.check()).toEqual({ state: "off" });
    expect(h.probes).toEqual([]);
    expect((await h.store.read()).defaultTarget).toBeNull();
  });

  test.each([
    [
      "absent",
      {
        state: "absent",
        containerId: "openbot",
        canCreate: false,
        instructions: expect.stringContaining("bun scripts/setup-learning.ts"),
      },
    ],
    ["not_entitled", { state: "not_entitled" }],
    ["unavailable", { state: "unavailable" }],
  ] as const)(
    "%s leaves settings alone, logs once and keeps trying",
    async (probe, expected) => {
      const h = harness({ probe });
      expect(await h.autoAssign.check()).toEqual(expected);
      expect(await h.autoAssign.check()).toEqual(expected);
      expect(h.probes).toHaveLength(2);
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toMatchObject({
        outcome: probe,
        containerId: "openbot",
      });
      expect((await h.store.read()).defaultTarget).toBeNull();
      expect(h.events).toEqual([]);
    },
  );

  test("the absent message tells the operator how to create the container", async () => {
    const h = harness({ probe: "absent" });
    await h.autoAssign.check();
    expect(String(h.logs[0]?.message)).toContain(
      "bun scripts/setup-learning.ts",
    );
  });

  test("with a credential that can, a fresh deployment creates the container and assigns it", async () => {
    let probe: ContainerProbe = "absent";
    let creates = 0;
    const h = harness({
      probe: async () => probe,
      create: async () => {
        creates++;
        probe = "present";
        return "created";
      },
    });
    expect(await h.autoAssign.check()).toEqual({
      state: "assigned",
      containerId: "openbot",
    });
    expect(creates).toBe(1);
    expect(h.probes).toEqual(["openbot", "openbot"]);
    expect((await h.store.read()).defaultTarget).toEqual({
      containerId: "openbot",
    });
    expect(h.logs.map((entry) => entry.outcome)).toEqual([
      "container_created",
      "assigned",
    ]);
  });

  test("without one, it says exactly what to run, once, and offers no button", async () => {
    const instructions = "Run exactly this.";
    const h = harness({
      probe: "absent",
      instructions,
      create: async () => "skipped",
    });
    const state = await h.autoAssign.check();
    expect(state).toEqual({
      state: "absent",
      containerId: "openbot",
      instructions,
      canCreate: true,
    });
    await h.autoAssign.check();
    expect(h.logs).toHaveLength(1);
    expect(String(h.logs[0]?.message)).toEndWith(instructions);
  });

  test("a failed creation is reported, tried once per process, and again only when Admin asks", async () => {
    let creates = 0;
    let probe: ContainerProbe = "absent";
    const h = harness({
      probe: async () => probe,
      create: async () => {
        creates++;
        if (creates === 1) throw new Error("Intelligence refused the token.");
        probe = "present";
        return "created";
      },
    });
    expect(await h.autoAssign.check()).toMatchObject({
      state: "absent",
      createError: "Intelligence refused the token.",
    });
    await h.autoAssign.check();
    expect(creates).toBe(1);
    expect(await h.autoAssign.createNow()).toEqual({
      state: "assigned",
      containerId: "openbot",
    });
    expect(creates).toBe(2);
    // Assigned is settled: asking again creates nothing.
    expect((await h.autoAssign.createNow()).state).toBe("assigned");
    expect(creates).toBe(2);
  });

  test("creation never overrides a saved setting", async () => {
    let creates = 0;
    const h = harness({
      probe: "absent",
      create: async () => {
        creates++;
        return "created";
      },
    });
    await h.store.write({ enabled: false, defaultTarget: null, agents: {} });
    expect(await h.autoAssign.check()).toEqual({ state: "saved" });
    expect(await h.autoAssign.createNow()).toEqual({ state: "saved" });
    expect(creates).toBe(0);
  });

  test("a container created later is assigned on the next check", async () => {
    let probe: ContainerProbe = "absent";
    const h = harness({ probe: async () => probe });
    expect((await h.autoAssign.check()).state).toBe("absent");
    probe = "present";
    expect((await h.autoAssign.check()).state).toBe("assigned");
    expect((await h.store.read()).defaultTarget).toEqual({
      containerId: "openbot",
    });
  });

  test("a failing probe or store never throws and is logged once", async () => {
    const h = harness({
      probe: async () => {
        throw new TypeError("boom");
      },
    });
    expect(await h.autoAssign.check()).toEqual({ state: "unavailable" });
    expect(await h.autoAssign.check()).toEqual({ state: "unavailable" });
    expect(h.logs).toEqual([
      expect.objectContaining({ outcome: "error", errorType: "TypeError" }),
    ]);
  });

  test("concurrent checks share one probe", async () => {
    const gate = Promise.withResolvers<ContainerProbe>();
    const h = harness({ probe: () => gate.promise });
    const checks = [h.autoAssign.check(), h.autoAssign.check()];
    gate.resolve("present");
    expect(await Promise.all(checks)).toEqual([
      { state: "assigned", containerId: "openbot" },
      { state: "assigned", containerId: "openbot" },
    ]);
    expect(h.probes).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });

  test("kick is rate-limited and never waits", async () => {
    let clock = 0;
    const h = harness({
      probe: "absent",
      now: () => clock,
      minIntervalMs: 1_000,
    });
    h.autoAssign.kick();
    await Bun.sleep(0);
    h.autoAssign.kick();
    await Bun.sleep(0);
    expect(h.probes).toHaveLength(1);
    clock = 1_000;
    h.autoAssign.kick();
    await Bun.sleep(0);
    expect(h.probes).toHaveLength(2);
  });

  test("replicas racing on one database assign once and write one audit row", async () => {
    let saved = false;
    let adopted = 0;
    const store = {
      saved: async () => saved,
      adoptDefault: async () => {
        await Bun.sleep(0);
        if (saved) return false;
        saved = true;
        adopted++;
        return true;
      },
    };
    const events: AuditEventInput[] = [];
    const audit: AuditStore = {
      insert: async (event) => void events.push(event),
    };
    const replicas = [0, 1, 2].map(() =>
      createLearningAutoAssign({
        enabled: true,
        store,
        audit,
        probe: async () => "present",
        log: () => {},
      }),
    );
    const results = await Promise.all(replicas.map((r) => r.check()));
    expect(adopted).toBe(1);
    expect(events).toHaveLength(1);
    expect(results.filter((r) => r.state === "assigned")).toHaveLength(1);
    expect(results.filter((r) => r.state === "saved")).toHaveLength(2);
  });
});

describe("reading settings nudges assignment", () => {
  test("a read with no default kicks a check; a read with one does not", async () => {
    const h = harness({ probe: "present", minIntervalMs: 0 });
    const store = withLearningAutoAssign(h.store, h.autoAssign);
    expect((await store.read()).defaultTarget).toBeNull();
    await Bun.sleep(0);
    await h.autoAssign.check();
    expect((await store.read()).defaultTarget).toEqual({
      containerId: "openbot",
    });
    const probes = h.probes.length;
    await store.read();
    await Bun.sleep(0);
    expect(h.probes).toHaveLength(probes);
    expect(probes).toBe(1);
  });

  test("a disabled deployment never kicks", async () => {
    const h = harness({ probe: "present", minIntervalMs: 0 });
    await h.store.write({ enabled: false, defaultTarget: null, agents: {} });
    const store = withLearningAutoAssign(h.store, h.autoAssign);
    await store.read();
    await Bun.sleep(0);
    expect(h.probes).toEqual([]);
  });
});
