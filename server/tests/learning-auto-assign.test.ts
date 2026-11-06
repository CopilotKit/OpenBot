import { afterEach, describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  type ContainerProbe,
  classifyLearningRouteError,
  createLearningAutoAssign,
  type LearningAutoAssign,
  probeLearningContainer,
  runtimeKeyClient,
  withLearningAutoAssign,
} from "../src/learning/auto-assign";
import {
  type ContainerCreation,
  ensureLearningContainer,
  keyIntelligence,
} from "../src/learning/ensure-container";
import { createLearningSettingsStore } from "../src/learning/settings";
import {
  type FakeIntelligence,
  fakeIntelligence,
  RUNTIME_KEY,
} from "./support/intelligence-learning";

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

/** A refusal shaped like the runtime client's: Intelligence's HTTP status and error code. */
function refusal(status: number, code: string) {
  return Object.assign(new Error(code), { status, code });
}

describe("probing a Learning container with the runtime key", () => {
  test.each([
    [404, "LEARNING_CONTAINER_NOT_FOUND", "absent"],
    [404, "ROUTE_NOT_FOUND", "learning_off"],
    [403, "LEARNING_NOT_ENABLED", "not_entitled"],
    [401, "AUTH_UNAUTHENTICATED", "unavailable"],
    [500, "INTERNAL_SERVER_ERROR", "unavailable"],
  ] as const)("%i %s means %s", (status, code, expected) => {
    expect(classifyLearningRouteError(refusal(status, code))).toBe(expected);
  });

  test("errors without a code, and non-errors, are unavailable", () => {
    expect(classifyLearningRouteError(new Error("network down"))).toBe(
      "unavailable",
    );
    expect(classifyLearningRouteError(null)).toBe("unavailable");
  });

  test("reading the container means it is there", async () => {
    const asked: string[] = [];
    expect(
      await probeLearningContainer(
        {
          experimental: {
            learning: {
              getLearningContainer: async (request) => {
                asked.push(request.containerId);
                expect(request.signal).toBeInstanceOf(AbortSignal);
                return {
                  id: request.containerId,
                  name: "OpenBot",
                  projectId: 1,
                  promptContext: null,
                  createdAt: "2026-11-05T00:00:00.000Z",
                  updatedAt: "2026-11-05T00:00:00.000Z",
                };
              },
            },
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
          experimental: {
            learning: {
              getLearningContainer: async () => {
                throw refusal(404, "LEARNING_CONTAINER_NOT_FOUND");
              },
            },
          },
        },
        "openbot",
      ),
    ).toBe("absent");
    expect(
      await probeLearningContainer(
        {
          experimental: {
            learning: {
              getLearningContainer: ({ signal }) =>
                new Promise((_, reject) =>
                  signal?.addEventListener("abort", () =>
                    reject(signal.reason),
                  ),
                ),
            },
          },
        },
        "openbot",
        5,
      ),
    ).toBe("unavailable");
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
        instructions: expect.stringContaining('ID "openbot"'),
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
    expect(String(h.logs[0]?.message)).toContain('ID "openbot"');
  });

  test("a fresh deployment creates the container with the runtime key and assigns it", async () => {
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

  test("when creating fails, it says what to do instead, once, and still offers to try again", async () => {
    const instructions = "Do exactly this.";
    const h = harness({
      probe: "absent",
      instructions,
      create: async () => {
        throw new Error("This Intelligence is older than 0.16.0.");
      },
    });
    expect(await h.autoAssign.check()).toEqual({
      state: "absent",
      containerId: "openbot",
      instructions,
      canCreate: true,
      createError: "This Intelligence is older than 0.16.0.",
    });
    await h.autoAssign.check();
    expect(h.logs.map((entry) => entry.outcome)).toEqual([
      "create_failed",
      "absent",
    ]);
    expect(String(h.logs[1]?.message)).toEndWith(instructions);
  });

  test("a failed creation is reported, tried once per process, and again only when Admin asks", async () => {
    let creates = 0;
    let probe: ContainerProbe = "absent";
    const h = harness({
      probe: async () => probe,
      create: async () => {
        creates++;
        if (creates === 1) throw new Error("Intelligence refused the key.");
        probe = "present";
        return "created";
      },
    });
    expect(await h.autoAssign.check()).toMatchObject({
      state: "absent",
      createError: "Intelligence refused the key.",
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

describe("what an Intelligence that is up but not learning says, read through the runtime client", () => {
  const served: FakeIntelligence[] = [];
  afterEach(() => {
    for (const intelligence of served.splice(0)) intelligence.stop();
  });
  const client = (version: Parameters<typeof fakeIntelligence>[0]) => {
    const intelligence = fakeIntelligence(version);
    served.push(intelligence);
    return runtimeKeyClient(intelligence.url, RUNTIME_KEY, "ws://127.0.0.1:9");
  };

  test("Learning switched off is off, not Intelligence out of reach", async () => {
    const intelligence = client("learning-off");
    expect(await probeLearningContainer(intelligence, "openbot")).toBe(
      "learning_off",
    );
    const logs: Record<string, unknown>[] = [];
    const autoAssign = createLearningAutoAssign({
      enabled: true,
      store: createLearningSettingsStore(),
      probe: (containerId) => probeLearningContainer(intelligence, containerId),
      log: (entry) => logs.push(entry),
    });
    expect(await autoAssign.check()).toEqual({ state: "learning_off" });
    expect(logs.map((entry) => entry.outcome)).toEqual(["learning_off"]);
    expect(String(logs[0]?.message)).toContain("switched off");
    expect(String(logs[0]?.message)).not.toContain("could not be asked");
  });

  test("Learning on but not admitted for the organization is not entitled", async () => {
    expect(
      await probeLearningContainer(client("rollout-closed"), "openbot"),
    ).toBe("not_entitled");
  });

  test("an Intelligence that is not there at all is still unavailable", async () => {
    const intelligence = fakeIntelligence("current");
    intelligence.stop();
    expect(
      await probeLearningContainer(
        runtimeKeyClient(intelligence.url, RUNTIME_KEY, "ws://127.0.0.1:9"),
        "openbot",
      ),
    ).toBe("unavailable");
  });
});

/*
 * Kink 17 of the Helm bundle build. OpenBot's server is up before Intelligence's migrations and
 * bootstrap run, by design. The boot check asked once, logged "Intelligence could not be asked about
 * the Learning container" on every first install, and looked again only ten minutes later or when
 * something read the settings. Real HTTP and the real runtime client, on a clock that moves only
 * when the boot check sleeps.
 */
describe("the boot check on a first install, while Intelligence is still starting", () => {
  const served: FakeIntelligence[] = [];
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const intelligence of served.splice(0)) intelligence.stop();
  });

  function boot(
    intelligence: FakeIntelligence,
    create?: () => Promise<ContainerCreation>,
  ) {
    served.push(intelligence);
    const client = runtimeKeyClient(
      intelligence.url,
      RUNTIME_KEY,
      "ws://127.0.0.1:9",
    );
    let at = 0;
    const logs: Record<string, unknown>[] = [];
    const autoAssign = createLearningAutoAssign({
      enabled: true,
      store: createLearningSettingsStore(),
      probe: (containerId) => probeLearningContainer(client, containerId),
      ...(create ? { create } : {}),
      log: (entry) => logs.push(entry),
      startup: {
        now: () => at,
        sleep: async (ms) => {
          at += ms;
        },
      },
    });
    stops.push(() => autoAssign.stop());
    autoAssign.start();
    return { autoAssign, logs };
  }

  async function settled(autoAssign: LearningAutoAssign) {
    for (let i = 0; i < 400 && autoAssign.state().state !== "assigned"; i++)
      await Bun.sleep(5);
    return autoAssign.state();
  }

  test("the migrations and the wait for the bootstrap pass quietly, then its container is assigned", async () => {
    const intelligence = fakeIntelligence("current", {
      containers: ["openbot"],
      starting: { migrating: 4, keyless: 2 },
    });
    const { autoAssign, logs } = boot(intelligence);
    expect(await settled(autoAssign)).toEqual({
      state: "assigned",
      containerId: "openbot",
    });
    expect(logs.map((entry) => entry.outcome)).toEqual(["assigned"]);
  });

  test("a creation Intelligence could not answer is tried again, not given up on", async () => {
    const intelligence = fakeIntelligence("current", { failCreates: 1 });
    const key = keyIntelligence(
      intelligence.url,
      RUNTIME_KEY,
      "ws://127.0.0.1:9",
    );
    const { autoAssign, logs } = boot(intelligence, () =>
      ensureLearningContainer({ key }),
    );
    expect(await settled(autoAssign)).toEqual({
      state: "assigned",
      containerId: "openbot",
    });
    expect(
      intelligence.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(2);
    expect(logs.map((entry) => entry.outcome)).toEqual([
      "container_created",
      "assigned",
    ]);
  });

  test("an Intelligence still unavailable when the window closes is said to be, once", async () => {
    const intelligence = fakeIntelligence("current", {
      containers: ["openbot"],
    });
    intelligence.stop();
    const { autoAssign, logs } = boot(intelligence);
    for (let i = 0; i < 400 && logs.length === 0; i++) await Bun.sleep(5);
    expect(autoAssign.state()).toEqual({ state: "unavailable" });
    expect(logs.map((entry) => entry.outcome)).toEqual(["unavailable"]);
  });
});
