import { describe, expect, test } from "bun:test";
import * as network from "../src/computer/policy-network";
import type {
  ComputerLocation,
  ComputerProvider,
} from "../src/computer/provider";

/**
 * A computer that wakes is pushed its network policy before the action that woke it runs.
 *
 * The computer keeps its policy in memory, so a suspended computer that resumes has none, and the
 * periodic push only reaches computers `list()` already reported as running. Without a push on
 * `locate()`, the first actions after every wake ran before any policy had arrived.
 */
type Wrap = (
  provider: ComputerProvider,
  options: {
    policyForBot: (
      botId: string,
    ) => Promise<network.EgressPolicy | undefined> | undefined;
    token?: string;
    fetchImpl?: typeof fetch;
  },
) => ComputerProvider;

function suspendedComputer() {
  let session = "run-1";
  let running = false;
  const provider: ComputerProvider = {
    name: "fake",
    isolation: "per-bot",
    async locate() {
      running = true;
      return "http://computer.test:4100";
    },
    async status(botId) {
      return { botId, state: running ? "ready" : "stopped" } as never;
    },
    async stop() {
      running = false;
      session = `run-${Number(session.slice(4)) + 1}`;
      return { wasRunning: true };
    },
    async reset() {
      return { cleared: true };
    },
    async list(): Promise<ComputerLocation[]> {
      return [
        {
          botId: "sales",
          status: running ? "running" : "stopped",
          url: "http://computer.test:4100",
        },
      ];
    },
    async sessionOf() {
      return session;
    },
  };
  return provider;
}

function recorder(fail = false) {
  const pushes: { url: string; bot: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (fail) throw new Error("the computer is not answering");
    pushes.push({
      url,
      bot: new Headers(init?.headers).get("x-openbot-bot-id"),
      body: JSON.parse(String(init?.body)),
    });
    return new Response("{}");
  }) as unknown as typeof fetch;
  return { pushes, fetchImpl };
}

const wrap = (network as { withPolicyPushOnWake?: Wrap }).withPolicyPushOnWake;

describe("a computer woken by an action", () => {
  test("is pushed its policy before locate() answers, once per run", async () => {
    const raw = suspendedComputer();
    const { pushes, fetchImpl } = recorder();
    const policy = { mode: "deny_all" as const, rules: [] };
    const provider = wrap
      ? wrap(raw, { policyForBot: async () => policy, token: "t", fetchImpl })
      : raw;

    // The periodic push sees a suspended computer and skips it.
    expect(
      (
        await network.pushEgressPolicies({
          provider,
          policyForBot: async () => policy,
          fetchImpl,
        })
      ).pushed,
    ).toEqual([]);

    await provider.locate("sales");
    expect(pushes).toEqual([
      {
        url: "http://computer.test:4100/egress-policy",
        bot: "sales",
        body: { policy: { mode: "deny_all", rules: [] } },
      },
    ]);

    // Same run: no second push on every action.
    await provider.locate("sales");
    expect(pushes).toHaveLength(1);

    // Suspended and woken again: a new run, an empty filter, a new push.
    await provider.stop("sales");
    await provider.locate("sales");
    expect(pushes).toHaveLength(2);
  });

  test("a push that fails does not fail the action; the computer refuses egress on its own", async () => {
    const raw = suspendedComputer();
    const { fetchImpl } = recorder(true);
    const provider = wrap
      ? wrap(raw, {
          policyForBot: async () => ({ mode: "allow_all", rules: [] }),
          fetchImpl,
        })
      : raw;
    expect(await provider.locate("sales")).toBe("http://computer.test:4100");
  });
});

test("a policy that cannot be read is logged, and the action still gets its computer", async () => {
  const wrap = network.withPolicyPushOnWake as unknown as Wrap;
  const provider = wrap(suspendedComputer(), {
    policyForBot: async () => {
      throw new Error("the database is unreachable");
    },
    fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
  });
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (line: string) => void warned.push(line);
  try {
    expect(await provider.locate("sales")).toBe("http://computer.test:4100");
  } finally {
    console.warn = warn;
  }
  expect(warned.join("")).toContain("egress-policy-push-on-wake-failed");
});
