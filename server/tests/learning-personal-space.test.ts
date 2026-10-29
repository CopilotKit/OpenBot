import { describe, expect, test } from "bun:test";
import {
  type CopilotKitIntelligence,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import {
  isLearningContainerId,
  type LearningSettings,
} from "@openbot/shared/learning";
import type { LearningSpaceState } from "@openbot/shared/recorder-api";
import type { LearningContainerSpec } from "../src/learning/ensure-container";
import {
  classifyLearningSpaceProbe,
  createPersonalLearningSpaces,
  type PersonalLearningSpaces,
  type PersonSpaceStore,
  personalLearningContainerId,
} from "../src/learning/personal-space";
import { createTrajectoryLearningSelector } from "../src/recorder/trajectory-gate";
import { skillSnapshot } from "./fixtures/learned-skills";

type Snapshots = Pick<CopilotKitIntelligence, "getLearnedSkillsSnapshot">;
type Call = { containerId: string; signal?: AbortSignal };

const enabled: LearningSettings = {
  enabled: true,
  defaultTarget: { containerId: "openbot" },
  agents: {},
};
const ADA = "person-ada";
const ADA_SPACE = personalLearningContainerId(ADA);
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const failWith = (code: string) => async () => {
  throw new LearnedSkillsError(code as never, false);
};

function memoryStore(): PersonSpaceStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    confirmed: async (userId) => rows.has(userId),
    confirm: async (userId, containerId) => {
      if (!rows.has(userId)) rows.set(userId, containerId);
    },
    forget: async (userId) => {
      rows.delete(userId);
    },
  };
}

function harness(
  options: {
    settings?: LearningSettings | (() => Promise<LearningSettings>);
    probe?: (call: Call) => Promise<unknown>;
    create?: (
      container: LearningContainerSpec,
    ) => Promise<"created" | "present" | "skipped">;
    probeTimeoutMs?: number;
  } = {},
) {
  const probes: Call[] = [];
  const creates: LearningContainerSpec[] = [];
  const logs: Record<string, unknown>[] = [];
  let clock = 1_000_000;
  const store = memoryStore();
  const settings = options.settings ?? enabled;
  const spaces = createPersonalLearningSpaces({
    readSettings:
      typeof settings === "function" ? settings : async () => settings,
    snapshots: {
      getLearnedSkillsSnapshot: async (call: Call) => {
        probes.push(call);
        return options.probe ? options.probe(call) : skillSnapshot();
      },
    } as unknown as Snapshots,
    store,
    ...(options.create
      ? {
          create: async (container: LearningContainerSpec) => {
            creates.push(container);
            return (options.create as NonNullable<typeof options.create>)(
              container,
            );
          },
        }
      : {}),
    nameFor: async (userId) => (userId === ADA ? "Ada Lovelace" : null),
    probeTimeoutMs: options.probeTimeoutMs,
    now: () => clock,
    log: (entry) => logs.push(entry),
  });
  return {
    spaces,
    probes,
    creates,
    logs,
    store,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("a person's Learning space id", () => {
  test("is a valid Intelligence container id, derived from the person, the same on every call", () => {
    for (const userId of [
      "dev-local-user",
      "aB3dE9fGhIjKlMnOpQrStUvWxYz01234",
      "someone@example.com",
      "x".repeat(500),
    ]) {
      const id = personalLearningContainerId(userId);
      expect(isLearningContainerId(id)).toBe(true);
      expect(id).toMatch(/^user-[0-9a-f]{32}$/);
      expect(personalLearningContainerId(userId)).toBe(id);
    }
  });

  test("two people never share one, even when their ids differ only in case", () => {
    expect(personalLearningContainerId("AbC")).not.toBe(
      personalLearningContainerId("abc"),
    );
  });
});

describe("the person's Learning space", () => {
  test("Automatic Learning off is unassigned: nothing is asked or created", async () => {
    const h = harness({
      settings: { ...enabled, enabled: false },
      create: async () => "created",
    });
    expect(await h.spaces.state(ADA)).toEqual({
      state: "unassigned",
      containerId: null,
    });
    expect(h.probes).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
  });

  test("a space Intelligence has is assigned, probed by the person's own id, and remembered", async () => {
    const h = harness();
    expect(await h.spaces.state(ADA)).toEqual({
      state: "assigned",
      containerId: ADA_SPACE,
    });
    expect(h.probes.map((call) => call.containerId)).toEqual([ADA_SPACE]);
    await wait(1);
    expect(h.store.rows.get(ADA)).toBe(ADA_SPACE);
  });

  test("a missing space is created on first need, named for the person, and then assigned", async () => {
    let exists = false;
    const h = harness({
      probe: async () => {
        if (!exists) throw new LearnedSkillsError("CONTAINER_NOT_FOUND", false);
        throw new LearnedSkillsError("REVISION_NOT_FOUND", false);
      },
      create: async () => {
        exists = true;
        return "created";
      },
    });
    expect(await h.spaces.state(ADA)).toEqual({
      state: "assigned",
      containerId: ADA_SPACE,
    });
    expect(h.creates).toEqual([
      { id: ADA_SPACE, name: "OpenBot: Ada Lovelace" },
    ]);
    expect(h.store.rows.get(ADA)).toBe(ADA_SPACE);
  });

  test("concurrent requests for one person create the space once", async () => {
    let exists = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      probe: async () => {
        if (!exists) throw new LearnedSkillsError("CONTAINER_NOT_FOUND", false);
        return skillSnapshot();
      },
      create: async () => {
        await gate;
        exists = true;
        return "created";
      },
    });
    const answers = Promise.all(
      Array.from({ length: 10 }, () => h.spaces.state(ADA)),
    );
    await wait(5);
    release();
    for (const answer of await answers)
      expect(answer).toEqual({ state: "assigned", containerId: ADA_SPACE });
    expect(h.creates).toHaveLength(1);
  });

  test("a space that is missing with no credential to make it is missing, and joins nothing", async () => {
    const h = harness({ probe: failWith("CONTAINER_NOT_FOUND") });
    expect(await h.spaces.state(ADA)).toEqual({
      state: "missing",
      containerId: null,
    });
  });

  test("a failed creation is missing, is not tried again for a minute, then is", async () => {
    const h = harness({
      probe: failWith("CONTAINER_NOT_FOUND"),
      create: async () => {
        throw new Error("Intelligence refused the service token for Learning.");
      },
    });
    expect((await h.spaces.state(ADA)).state).toBe("missing");
    expect((await h.spaces.state(ADA)).state).toBe("missing");
    expect(h.creates).toHaveLength(1);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        type: "learning-personal-space",
        outcome: "create_failed",
        containerId: ADA_SPACE,
      }),
    );
    h.advance(60_001);
    await h.spaces.state(ADA);
    expect(h.creates).toHaveLength(2);
  });

  test("a creation still running when the caller stops waiting is unverified with no container, and finishes anyway", async () => {
    let exists = false;
    const h = harness({
      probe: async () => {
        if (!exists) throw new LearnedSkillsError("CONTAINER_NOT_FOUND", false);
        return skillSnapshot();
      },
      create: async () => {
        await wait(40);
        exists = true;
        return "created";
      },
    });
    expect(await h.spaces.state(ADA, AbortSignal.timeout(10))).toEqual({
      state: "unverified",
      containerId: null,
    });
    await wait(60);
    expect(h.store.rows.get(ADA)).toBe(ADA_SPACE);
    expect(await h.spaces.state(ADA)).toEqual({
      state: "assigned",
      containerId: ADA_SPACE,
    });
    expect(h.creates).toHaveLength(1);
  });

  test("a space made in another project is a failure, not a space", async () => {
    const h = harness({
      probe: failWith("CONTAINER_NOT_FOUND"),
      create: async () => "created",
    });
    expect((await h.spaces.state(ADA)).state).toBe("missing");
    expect(h.store.rows.has(ADA)).toBe(false);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ outcome: "create_failed" }),
    );
  });

  test.each(["UNSUPPORTED_SERVER", "TIMEOUT"] as const)(
    "Intelligence unable to say (%s) still names the person's container, so a pass joins it when it is there",
    async (code) => {
      const h = harness({ probe: failWith(code) });
      expect(await h.spaces.state(ADA)).toEqual({
        state: classifyLearningSpaceProbe({
          code,
        }) as LearningSpaceState["state"],
        containerId: ADA_SPACE,
      });
    },
  );

  test("Intelligence unable to say, with a credential, makes the space (already there counts) and calls it assigned", async () => {
    const h = harness({
      probe: failWith("UNSUPPORTED_SERVER"),
      create: async () => "present",
    });
    expect(await h.spaces.state(ADA)).toEqual({
      state: "assigned",
      containerId: ADA_SPACE,
    });
    expect(h.store.rows.get(ADA)).toBe(ADA_SPACE);
  });

  test("a space seen before is named without asking a credential again", async () => {
    const h = harness({
      probe: failWith("UNSUPPORTED_SERVER"),
      create: async () => "created",
    });
    await h.store.confirm(ADA, ADA_SPACE);
    expect(await h.spaces.state(ADA)).toEqual({
      state: "learning-off",
      containerId: ADA_SPACE,
    });
    expect(h.creates).toHaveLength(0);
  });

  test("a space removed in Intelligence is forgotten and made again", async () => {
    let exists = false;
    const h = harness({
      probe: async () => {
        if (!exists) throw new LearnedSkillsError("CONTAINER_NOT_FOUND", false);
        return skillSnapshot();
      },
      create: async () => {
        exists = true;
        return "created";
      },
    });
    await h.store.confirm(ADA, "stale-row");
    expect((await h.spaces.state(ADA)).state).toBe("assigned");
    expect(h.store.rows.get(ADA)).toBe(ADA_SPACE);
  });

  test("an answer is cached for a minute; an unverified one is not", async () => {
    const h = harness();
    await h.spaces.state(ADA);
    await h.spaces.state(ADA);
    expect(h.probes).toHaveLength(1);
    h.advance(60_001);
    await h.spaces.state(ADA);
    expect(h.probes).toHaveLength(2);

    const flaky = harness({ probe: failWith("NETWORK_ERROR") });
    await flaky.spaces.state(ADA);
    await flaky.spaces.state(ADA);
    expect(flaky.probes).toHaveLength(2);
  });

  test("settings that cannot be read are unverified with no container", async () => {
    const h = harness({
      settings: async () => {
        throw new Error("database down");
      },
    });
    expect(await h.spaces.state(ADA)).toEqual({
      state: "unverified",
      containerId: null,
    });
  });

  test("the probe stops at its timeout, and when the caller's signal aborts", async () => {
    const hangs = (call: Call) =>
      new Promise((_, reject) => {
        call.signal?.addEventListener("abort", () =>
          reject(new LearnedSkillsError("TIMEOUT", true)),
        );
      });
    const timed = harness({ probe: hangs, probeTimeoutMs: 20 });
    expect((await timed.spaces.state(ADA)).state).toBe("unverified");
    const caller = new AbortController();
    const cut = harness({ probe: hangs, probeTimeoutMs: 10_000 });
    const answer = cut.spaces.state(ADA, caller.signal);
    await wait(5);
    caller.abort(new Error("stop"));
    expect((await answer).state).toBe("unverified");
  });

  test("kick makes the space in the background and never throws", async () => {
    let exists = false;
    const h = harness({
      probe: async () => {
        if (!exists) throw new LearnedSkillsError("CONTAINER_NOT_FOUND", false);
        return skillSnapshot();
      },
      create: async () => {
        exists = true;
        return "created";
      },
    });
    h.spaces.kick(ADA);
    await wait(5);
    expect(h.store.rows.get(ADA)).toBe(ADA_SPACE);
  });
});

describe("classifyLearningSpaceProbe", () => {
  test.each([
    ["REVISION_NOT_FOUND", "assigned"],
    ["DELIVERY_DISABLED", "assigned"],
    ["REVISION_REVOKED", "assigned"],
    ["CONTAINER_NOT_FOUND", "missing"],
    ["ENTITLEMENT_REQUIRED", "learning-off"],
    ["AUTHORIZATION_FAILED", "learning-off"],
    ["UNSUPPORTED_SERVER", "learning-off"],
    ["TIMEOUT", "unverified"],
    ["SOMETHING_NEW", "unverified"],
  ] as const)("%s is %s", (code, state) => {
    expect(classifyLearningSpaceProbe({ code })).toBe(state);
  });

  test("success is assigned", () => {
    expect(classifyLearningSpaceProbe("ok")).toBe("assigned");
  });
});

describe("the trajectory Learning space selector", () => {
  const TRAJECTORY = "0b6c1c0e-6f0a-4f6e-9a55-1d1c2f3f4a5b";
  const PERSON = { id: ADA, name: "Ada" };
  const OTHER = { id: "person-grace", name: "Grace" };
  type State = PersonalLearningSpaces["state"];
  const answers =
    (learning: LearningSpaceState): State =>
    async () =>
      learning;
  /** A check that keeps going until its signal aborts, then answers what it knows. */
  const stopsOnAbort =
    (learning: LearningSpaceState): State =>
    (_userId, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve(learning));
      });

  function selector(
    options: {
      state?: State;
      isBoundTo?: (trajectoryId: string, userId: string) => Promise<boolean>;
      budgetMs?: number;
    } = {},
  ) {
    const checks: { userId: string; signal?: AbortSignal }[] = [];
    const state =
      options.state ?? answers({ state: "assigned", containerId: ADA_SPACE });
    const select = createTrajectoryLearningSelector({
      isBoundTo:
        options.isBoundTo ??
        (async (trajectoryId, userId) =>
          userId === PERSON.id && trajectoryId === TRAJECTORY),
      personalSpace: {
        state: (userId, signal) => {
          checks.push({ userId, signal });
          return state(userId, signal);
        },
      },
      budgetMs: options.budgetMs,
    });
    const pick = async (signal?: AbortSignal, user = PERSON) =>
      select({ trajectoryId: TRAJECTORY, user }, signal);
    return { pick, checks };
  }

  test("returns the person's own container, whichever Bot they later use", async () => {
    const { pick, checks } = selector();
    expect(await pick()).toEqual([ADA_SPACE]);
    expect(checks.map((check) => check.userId)).toEqual([ADA]);
  });

  test("returns the person's container end to end, created on the spot by the real space check", async () => {
    let exists = false;
    const h = harness({
      probe: async () => {
        if (!exists) throw new LearnedSkillsError("CONTAINER_NOT_FOUND", false);
        return skillSnapshot();
      },
      create: async () => {
        exists = true;
        return "created";
      },
    });
    const { pick } = selector({ state: h.spaces.state });
    expect(await pick()).toEqual([ADA_SPACE]);
    expect(h.creates).toHaveLength(1);
  });

  test.each([
    { state: "unassigned", containerId: null },
    { state: "missing", containerId: null },
    { state: "unverified", containerId: null },
  ] as const)("$state with no container joins none", async (learning) => {
    const { pick } = selector({ state: answers(learning) });
    expect(await pick()).toBeNull();
  });

  test.each(["assigned", "learning-off", "unverified"] as const)(
    "%s with the container returns it, so a pass joins the same space whatever one probe found",
    async (state) => {
      const { pick } = selector({
        state: answers({ state, containerId: ADA_SPACE }),
      });
      expect(await pick()).toEqual([ADA_SPACE]);
    },
  );

  test("a trajectory bound to nobody, or to another person, returns null and is never checked", async () => {
    const { pick, checks } = selector();
    expect(await pick(undefined, OTHER)).toBeNull();
    await wait(5);
    expect(checks).toEqual([]);
  });

  test("a binding lookup that fails returns null", async () => {
    const { pick, checks } = selector({
      isBoundTo: async () => {
        throw new Error("database down");
      },
    });
    expect(await pick()).toBeNull();
    await wait(5);
    expect(checks).toEqual([]);
  });

  test("a check that throws still answers, with no container", async () => {
    const { pick } = selector({
      state: async () => {
        throw new Error("boom");
      },
    });
    expect(await pick()).toBeNull();
  });

  test("a check that stops when the budget nears its end still sends its container", async () => {
    const { pick, checks } = selector({
      state: stopsOnAbort({ state: "unverified", containerId: ADA_SPACE }),
      budgetMs: 30,
    });
    expect(await pick()).toEqual([ADA_SPACE]);
    expect(checks[0]?.signal?.aborted).toBe(true);
  });

  test("a check that never answers is cut at the budget with no container", async () => {
    const { pick, checks } = selector({
      state: () => new Promise(() => {}),
      budgetMs: 30,
    });
    const started = performance.now();
    expect(await pick()).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(checks[0]?.signal?.aborted).toBe(true);
  });

  test("a binding lookup slower than the budget answers null and checks nothing", async () => {
    const { pick, checks } = selector({
      isBoundTo: async () => {
        await wait(60);
        return true;
      },
      budgetMs: 20,
    });
    expect(await pick()).toBeNull();
    await wait(80);
    expect(checks).toEqual([]);
  });

  test("the runtime giving up mid-check answers at once and stops the check", async () => {
    const runtime = new AbortController();
    const { pick, checks } = selector({
      state: stopsOnAbort({ state: "unverified", containerId: ADA_SPACE }),
      budgetMs: 10_000,
    });
    const answer = pick(runtime.signal);
    await wait(10);
    runtime.abort(new Error("deadline"));
    expect(await answer).toBeNull();
    expect(checks[0]?.signal?.aborted).toBe(true);
  });

  test("a signal already aborted answers without checking", async () => {
    const runtime = new AbortController();
    runtime.abort(new Error("gone"));
    const { pick, checks } = selector();
    expect(await pick(runtime.signal)).toBeNull();
    await wait(5);
    expect(checks).toEqual([]);
  });
});
