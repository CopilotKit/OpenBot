import { describe, expect, test } from "bun:test";
import {
  type CopilotKitIntelligence,
  LearnedSkillsError,
} from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import {
  classifyLearningSpaceProbe,
  createLearningSpaceCheck,
} from "../src/recorder/learning-space";
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
