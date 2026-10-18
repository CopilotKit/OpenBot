import { describe, expect, test } from "bun:test";
import {
  type CopilotKitIntelligence,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import type { LearningSpaceState } from "@openbot/shared/recorder-api";
import {
  classifyLearningSpaceProbe,
  createLearningSpaceCheck,
  type LearningSpaceCheck,
} from "../src/recorder/learning-space";
import { createTrajectoryLearningSelector } from "../src/recorder/trajectory-gate";
import { skillSnapshot } from "./fixtures/learned-skills";

type Snapshots = Pick<CopilotKitIntelligence, "getLearnedSkillsSnapshot">;
type Call = { containerId: string; signal?: AbortSignal };

const enabled: LearningSettings = {
  enabled: true,
  defaultTarget: { containerId: "openbot" },
  agents: {},
};

function harness(
  options: {
    settings?: LearningSettings | (() => Promise<LearningSettings>);
    probe?: (call: Call) => Promise<unknown>;
    probeTimeoutMs?: number;
  } = {},
) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const snapshots = {
    getLearnedSkillsSnapshot: async (call: Call) => {
      calls.push(call);
      return options.probe ? options.probe(call) : skillSnapshot();
    },
  } as unknown as Snapshots;
  const settings = options.settings ?? enabled;
  const check = createLearningSpaceCheck({
    readSettings:
      typeof settings === "function" ? settings : async () => settings,
    snapshots,
    probeTimeoutMs: options.probeTimeoutMs,
    now: () => clock,
  });
  return {
    check,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const failWith = (code: string) => async () => {
  throw new LearnedSkillsError(code as never, false);
};

describe("the Learning space check", () => {
  test("a Bot with no target is unassigned and Intelligence is never asked", async () => {
    const off = harness({ settings: { ...enabled, enabled: false } });
    expect(await off.check("bot")).toEqual({
      state: "unassigned",
      containerId: null,
    });
    const excluded = harness({
      settings: { ...enabled, agents: { bot: null } },
    });
    expect(await excluded.check("bot")).toEqual({
      state: "unassigned",
      containerId: null,
    });
    expect(off.calls).toHaveLength(0);
    expect(excluded.calls).toHaveLength(0);
  });

  test("a published snapshot is assigned with the container id", async () => {
    const { check, calls } = harness();
    expect(await check("bot")).toEqual({
      state: "assigned",
      containerId: "openbot",
    });
    expect(calls[0]?.containerId).toBe("openbot");
  });

  test("a Bot's own container is the one probed", async () => {
    const { check, calls } = harness({
      settings: { ...enabled, agents: { bot: { containerId: "sales" } } },
    });
    expect(await check("bot")).toEqual({
      state: "assigned",
      containerId: "sales",
    });
    expect(calls[0]?.containerId).toBe("sales");
  });

  test.each([
    ["REVISION_NOT_FOUND", "assigned"],
    ["DELIVERY_DISABLED", "assigned"],
    ["REVISION_REVOKED", "assigned"],
    ["CONTAINER_NOT_FOUND", "missing"],
    ["ENTITLEMENT_REQUIRED", "learning-off"],
    ["AUTHORIZATION_FAILED", "learning-off"],
    ["UNSUPPORTED_SERVER", "learning-off"],
    ["TIMEOUT", "unverified"],
    ["NETWORK_ERROR", "unverified"],
    ["AUTHENTICATION_FAILED", "unverified"],
    ["INVALID_CONFIG", "unverified"],
    ["INVALID_SNAPSHOT", "unverified"],
  ] as const)(
    "%s is %s, and the container id is still reported",
    async (code, state) => {
      const { check } = harness({ probe: failWith(code) });
      expect(await check("bot")).toEqual({ state, containerId: "openbot" });
    },
  );

  test("a probe that throws anything else is unverified", async () => {
    const { check } = harness({
      probe: async () => {
        throw new Error("boom");
      },
    });
    expect(await check("bot")).toEqual({
      state: "unverified",
      containerId: "openbot",
    });
  });

  test("settings that cannot be read are unverified with no container", async () => {
    const { check, calls } = harness({
      settings: async () => {
        throw new Error("database down");
      },
    });
    expect(await check("bot")).toEqual({
      state: "unverified",
      containerId: null,
    });
    expect(calls).toHaveLength(0);
  });

  test("the probe's signal aborts after probeTimeoutMs", async () => {
    const { check, calls } = harness({
      probeTimeoutMs: 20,
      probe: (call) =>
        new Promise((_, reject) => {
          call.signal?.addEventListener("abort", () =>
            reject(new LearnedSkillsError("TIMEOUT", true)),
          );
        }),
    });
    expect(await check("bot")).toEqual({
      state: "unverified",
      containerId: "openbot",
    });
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  test("the probe's signal aborts when the caller's does", async () => {
    const caller = new AbortController();
    const { check, calls } = harness({
      probe: (call) =>
        new Promise((_, reject) => {
          call.signal?.addEventListener("abort", () =>
            reject(new LearnedSkillsError("TIMEOUT", true)),
          );
        }),
    });
    const answer = check("bot", caller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls[0]?.signal?.aborted).toBe(false);
    caller.abort();
    expect(await answer).toEqual({
      state: "unverified",
      containerId: "openbot",
    });
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  test("an answer is cached for 60 seconds per container", async () => {
    const { check, calls, advance } = harness();
    await check("bot");
    advance(59_000);
    await check("bot");
    expect(calls).toHaveLength(1);
    advance(2_000);
    await check("bot");
    expect(calls).toHaveLength(2);
  });

  test("another container is probed separately", async () => {
    const { check, calls } = harness({
      settings: { ...enabled, agents: { other: { containerId: "sales" } } },
    });
    await check("bot");
    await check("other");
    expect(calls.map((call) => call.containerId)).toEqual(["openbot", "sales"]);
  });

  test("an unverified answer is not cached, so Intelligence coming back is seen at once", async () => {
    let up = false;
    const { check, calls } = harness({
      probe: async () => {
        if (!up) throw new LearnedSkillsError("NETWORK_ERROR", true);
        return skillSnapshot();
      },
    });
    expect((await check("bot")).state).toBe("unverified");
    up = true;
    expect((await check("bot")).state).toBe("assigned");
    expect(calls).toHaveLength(2);
  });
});

describe("classifyLearningSpaceProbe", () => {
  test("success is assigned and an unknown code is unverified", () => {
    expect(classifyLearningSpaceProbe("ok")).toBe("assigned");
    expect(classifyLearningSpaceProbe({ code: "SOMETHING_NEW" })).toBe(
      "unverified",
    );
  });
});

describe("the trajectory Learning space selector", () => {
  const TRAJECTORY = "0b6c1c0e-6f0a-4f6e-9a55-1d1c2f3f4a5b";
  const PERSON = { id: "person-1", name: "Ada" };
  const OTHER = { id: "person-2", name: "Grace" };
  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const answers =
    (learning: LearningSpaceState): LearningSpaceCheck =>
    async () =>
      learning;
  /** A check that keeps going until its signal aborts, then answers what it knows. */
  const stopsOnAbort =
    (learning: LearningSpaceState): LearningSpaceCheck =>
    (_botId, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve(learning));
      });

  function selector(
    options: {
      check?: LearningSpaceCheck;
      botFor?: (trajectoryId: string, userId: string) => Promise<string | null>;
      budgetMs?: number;
    } = {},
  ) {
    const checks: { botId: string; signal?: AbortSignal }[] = [];
    const check =
      options.check ?? answers({ state: "assigned", containerId: "openbot" });
    const select = createTrajectoryLearningSelector({
      botFor:
        options.botFor ??
        (async (trajectoryId, userId) =>
          userId === PERSON.id && trajectoryId === TRAJECTORY ? "bot" : null),
      learningSpace: (botId, signal) => {
        checks.push({ botId, signal });
        return check(botId, signal);
      },
      budgetMs: options.budgetMs,
    });
    const pick = async (signal?: AbortSignal, user = PERSON) =>
      select({ trajectoryId: TRAJECTORY, user }, signal);
    return { pick, checks };
  }

  test("returns the bound Bot's own container, through its Learning target", async () => {
    const probed: string[] = [];
    const check = createLearningSpaceCheck({
      readSettings: async () => ({
        ...enabled,
        agents: { bot: { containerId: "bot-space" } },
      }),
      snapshots: {
        getLearnedSkillsSnapshot: async ({ containerId }: Call) => {
          probed.push(containerId);
          return skillSnapshot();
        },
      } as unknown as Snapshots,
    });
    const { pick } = selector({ check });

    expect(await pick()).toEqual(["bot-space"]);
    expect(probed).toEqual(["bot-space"]);
  });

  test("returns null when Learning is off, and asks Intelligence nothing", async () => {
    const probed: string[] = [];
    const check = createLearningSpaceCheck({
      readSettings: async () => ({ ...enabled, enabled: false }),
      snapshots: {
        getLearnedSkillsSnapshot: async ({ containerId }: Call) => {
          probed.push(containerId);
          return skillSnapshot();
        },
      } as unknown as Snapshots,
    });
    const { pick } = selector({ check });

    expect(await pick()).toBeNull();
    expect(probed).toEqual([]);
  });

  test("a container Intelligence says is missing returns null", async () => {
    const { pick } = selector({
      check: answers({ state: "missing", containerId: "openbot" }),
    });

    expect(await pick()).toBeNull();
  });

  test.each(["assigned", "learning-off", "unverified"] as const)(
    "%s returns the container, so a pass joins the same space whatever one probe found",
    async (state) => {
      const { pick, checks } = selector({
        check: answers({ state, containerId: "openbot" }),
      });

      expect(await pick()).toEqual(["openbot"]);
      expect(checks.map((check) => check.botId)).toEqual(["bot"]);
    },
  );

  test("a Bot with no Learning target returns null", async () => {
    const { pick } = selector({
      check: answers({ state: "unassigned", containerId: null }),
    });

    expect(await pick()).toBeNull();
  });

  test("a trajectory bound to nobody, or to another person, returns null and is never checked", async () => {
    const { pick, checks } = selector();

    expect(await pick(undefined, OTHER)).toBeNull();
    await wait(5);
    expect(checks).toEqual([]);
  });

  test("a binding lookup that fails returns null", async () => {
    const { pick, checks } = selector({
      botFor: async () => {
        throw new Error("database down");
      },
    });

    expect(await pick()).toBeNull();
    await wait(5);
    expect(checks).toEqual([]);
  });

  test("a check that throws still answers, with no container", async () => {
    const { pick } = selector({
      check: async () => {
        throw new Error("boom");
      },
    });

    expect(await pick()).toBeNull();
  });

  test("a state without a container id returns null, never [null]", async () => {
    const check = createLearningSpaceCheck({
      readSettings: async () => {
        throw new Error("database down");
      },
      snapshots: {
        getLearnedSkillsSnapshot: async () => skillSnapshot(),
      } as unknown as Snapshots,
    });
    const { pick } = selector({ check });

    expect(await pick()).toBeNull();
  });

  test("Intelligence slower than its probe still sends the container before the budget ends", async () => {
    const check = createLearningSpaceCheck({
      readSettings: async () => enabled,
      snapshots: {
        getLearnedSkillsSnapshot: ({ signal }: Call) =>
          new Promise((_, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new LearnedSkillsError("TIMEOUT", true)),
            );
          }),
      } as unknown as Snapshots,
      probeTimeoutMs: 20,
    });
    const { pick } = selector({ check, budgetMs: 1_000 });

    const started = performance.now();
    expect(await pick()).toEqual(["openbot"]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a check that stops when the budget nears its end still sends its container", async () => {
    const { pick, checks } = selector({
      check: stopsOnAbort({ state: "unverified", containerId: "openbot" }),
      budgetMs: 30,
    });

    expect(await pick()).toEqual(["openbot"]);
    expect(checks[0]?.signal?.aborted).toBe(true);
  });

  test("a check that never answers is cut at the budget with no container", async () => {
    const { pick, checks } = selector({
      check: () => new Promise(() => {}),
      budgetMs: 30,
    });

    const started = performance.now();
    expect(await pick()).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(checks[0]?.signal?.aborted).toBe(true);
  });

  test("a binding lookup slower than the budget answers null and checks nothing", async () => {
    const { pick, checks } = selector({
      botFor: async () => {
        await wait(60);
        return "bot";
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
      check: stopsOnAbort({ state: "unverified", containerId: "openbot" }),
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
