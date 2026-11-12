import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { NEW_CONVERSATION } from "../src/lib/routines/form";
import {
  createFromPlanMutationOptions,
  SavedButRefused,
} from "../src/lib/routines/mutations";
import type { RoutinePlan } from "../src/lib/routines/plan";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = [method: string, path: string, body: unknown];

/** Records every request and answers like the server, unless `refuse` names a request to refuse. */
function stub(refuse: Record<string, { status: number; body: unknown }> = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url);
    calls.push([
      method,
      path,
      init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    ]);
    const refusal = refuse[`${method} ${path}`];
    const [status, body] = refusal
      ? [refusal.status, refusal.body]
      : method === "POST" && path === "/api/responsibilities"
        ? [200, { responsibility: { id: "g1", title: "Ship it" } }]
        : method === "POST" && path === "/api/channels"
          ? [200, { channel: { id: "c9" } }]
          : [200, { ok: true }];
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

function fakeQueryClient() {
  const invalidated: unknown[] = [];
  const queryClient = {
    invalidateQueries: async (filter: unknown) => {
      invalidated.push(filter);
    },
  } as unknown as QueryClient;
  return { queryClient, invalidated };
}

function mutationContext(queryClient: QueryClient) {
  return { client: queryClient, meta: undefined };
}

async function run(plan: RoutinePlan) {
  const { queryClient, invalidated } = fakeQueryClient();
  const options = createFromPlanMutationOptions(queryClient);
  const result = await options
    .mutationFn?.(plan, mutationContext(queryClient))
    .then(
      () => ({ error: undefined as Error | undefined }),
      (error: Error) => ({ error }),
    );
  return { options, queryClient, invalidated, error: result?.error };
}

const cron = "0 9 * * 1";
const timezone = "Europe/Paris";

function goalPlan(
  channelId: string,
  extra: { schedule?: boolean; runNow?: boolean } = {},
): RoutinePlan {
  return {
    kind: "goal",
    goal: {
      agentId: "a1",
      channelId,
      title: "Ship it",
      instruction: "Ship the release",
      successCriteria: "It is out",
      subscriptions: [],
      recurring: false,
      endsWhenMet: true,
    },
    schedule: extra.schedule ? { cron, timezone } : null,
    runNow: extra.runNow ?? false,
  };
}

const checkInPlan = (channelId: string): RoutinePlan => ({
  kind: "check-in",
  checkIn: {
    agentId: "a1",
    channelId,
    focus: "Watch the inbox",
    subject: "Inbox",
    intervalMinutes: 60,
  },
});

const methodsAndPaths = (calls: Call[]) =>
  calls.map(([method, path]) => `${method} ${path}`);

test("a routine: one POST /api/routines", async () => {
  const calls = stub();
  await run({
    kind: "routine",
    routine: {
      agentId: "a1",
      channelId: "c1",
      instruction: "Send the digest",
      cron,
      timezone,
    },
  });
  expect(methodsAndPaths(calls)).toEqual(["POST /api/routines"]);
  expect(calls[0]?.[2]).toEqual({
    agentId: "a1",
    channelId: "c1",
    instruction: "Send the digest",
    cron,
    timezone,
  });
});

test("a goal with a schedule: the goal, then a routine that names it", async () => {
  const calls = stub();
  await run(goalPlan("c1", { schedule: true }));
  expect(methodsAndPaths(calls)).toEqual([
    "POST /api/responsibilities",
    "POST /api/routines",
  ]);
  expect(calls[0]?.[2]).toMatchObject({ endsWhenMet: true });
  expect(calls[1]?.[2]).toEqual({
    goalId: "g1",
    instruction: 'Run the goal "Ship it" (g1) with run_goal.',
    title: "Ship it",
    cron,
    timezone,
    agentId: "a1",
    channelId: "c1",
  });
});

test("a goal run now: the goal, then POST /api/responsibilities/g1/run", async () => {
  const calls = stub();
  await run(goalPlan("c1", { runNow: true }));
  expect(methodsAndPaths(calls)).toEqual([
    "POST /api/responsibilities",
    "POST /api/responsibilities/g1/run",
  ]);
});

test("a check-in: one POST /api/proactive/settings, asking for a new one", async () => {
  const calls = stub();
  await run(checkInPlan("c1"));
  expect(methodsAndPaths(calls)).toEqual([
    "POST /api/proactive/settings?refuseExisting=true",
  ]);
  expect(calls[0]?.[2]).toEqual({
    agentId: "a1",
    channelId: "c1",
    focus: "Watch the inbox",
    subject: "Inbox",
    intervalMinutes: 60,
  });
});

test("a new conversation is started first and used by every write", async () => {
  const calls = stub();
  await run(goalPlan(NEW_CONVERSATION, { schedule: true }));
  expect(methodsAndPaths(calls)).toEqual([
    "POST /api/channels",
    "PUT /api/channels/c9/title",
    "POST /api/responsibilities",
    "POST /api/routines",
  ]);
  expect(calls[2]?.[2]).toMatchObject({ channelId: "c9" });
  expect(calls[3]?.[2]).toMatchObject({ channelId: "c9" });
});

test("a refused write takes the new conversation back", async () => {
  const calls = stub({
    "POST /api/proactive/settings?refuseExisting=true": {
      status: 400,
      body: { error: "x" },
    },
  });
  const { error } = await run(checkInPlan(NEW_CONVERSATION));
  expect(methodsAndPaths(calls)).toContain("DELETE /api/channels/c9");
  expect(error?.message).toBe("x");
});

test("a check-in the Bot already has is refused, says so, and takes the new conversation back", async () => {
  const same =
    "This Bot already checks in on this. Give this one a different name, or change that one on its row.";
  const calls = stub({
    "POST /api/proactive/settings?refuseExisting=true": {
      status: 409,
      body: { error: same },
    },
  });
  const { error } = await run(checkInPlan(NEW_CONVERSATION));
  expect(error).not.toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(same);
  expect(methodsAndPaths(calls)).toContain("DELETE /api/channels/c9");
});

const refusedSchedule = {
  "POST /api/routines": {
    status: 400,
    body: { error: "You have 20 routines switched on." },
  },
};

test("a refused schedule takes back the goal and its conversation, and says what was refused", async () => {
  const calls = stub(refusedSchedule);
  const { error } = await run(
    goalPlan(NEW_CONVERSATION, { schedule: true, runNow: true }),
  );
  expect(methodsAndPaths(calls)).toEqual([
    "POST /api/channels",
    "PUT /api/channels/c9/title",
    "POST /api/responsibilities",
    "POST /api/routines",
    "DELETE /api/responsibilities/g1",
    "DELETE /api/channels/c9",
  ]);
  // Nothing is kept, so the form stays editable and Create can be pressed again.
  expect(error).toBeDefined();
  expect(error).not.toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe("You have 20 routines switched on.");
});

test("a refused schedule in a conversation the person chose leaves that conversation", async () => {
  const calls = stub(refusedSchedule);
  const { error } = await run(goalPlan("c1", { schedule: true }));
  expect(methodsAndPaths(calls)).toEqual([
    "POST /api/responsibilities",
    "POST /api/routines",
    "DELETE /api/responsibilities/g1",
  ]);
  expect(error).not.toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe("You have 20 routines switched on.");
});

const goalNotDeleted = {
  "DELETE /api/responsibilities/g1": { status: 500, body: { error: "down" } },
};

test("a refused schedule whose goal can't be taken back pauses it and says so", async () => {
  const calls = stub({ ...refusedSchedule, ...goalNotDeleted });
  const { error } = await run(
    goalPlan(NEW_CONVERSATION, { schedule: true, runNow: true }),
  );
  const seen = methodsAndPaths(calls);
  expect(seen).toContain("POST /api/responsibilities/g1/pause");
  expect(seen).not.toContain("DELETE /api/channels/c9");
  expect(seen).not.toContain("POST /api/responsibilities/g1/run");
  expect(error).toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(
    "It's saved but paused, on the Routines page. Its schedule was refused. You have 20 routines switched on.",
  );
});

test("a failed pause still says the goal was saved", async () => {
  const calls = stub({
    ...refusedSchedule,
    ...goalNotDeleted,
    "POST /api/responsibilities/g1/pause": {
      status: 500,
      body: { error: "down" },
    },
  });
  const { error } = await run(goalPlan(NEW_CONVERSATION, { schedule: true }));
  expect(methodsAndPaths(calls)).not.toContain("DELETE /api/channels/c9");
  expect(error).toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(
    "It's saved on the Routines page, but it won't run on its own. Its schedule was refused. You have 20 routines switched on.",
  );
});

test("a schedule whose answer was lost leaves the goal running and says to check", async () => {
  const calls = stub({
    "POST /api/routines": { status: 500, body: {} },
  });
  const { error } = await run(
    goalPlan(NEW_CONVERSATION, { schedule: true, runNow: true }),
  );
  const requests = methodsAndPaths(calls);
  expect(requests).not.toContain("POST /api/responsibilities/g1/pause");
  expect(requests).not.toContain("POST /api/responsibilities/g1/run");
  expect(requests.some((l) => l.startsWith("DELETE"))).toBe(false);
  expect(error).toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(
    "It's saved on the Routines page, but its schedule may not have been set. Open it there to check.",
  );
});

test("a schedule request that never reached the server is not a refusal either", async () => {
  const calls = stub();
  const answered = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (init?.method === "POST" && String(url) === "/api/routines")
      throw new TypeError("Failed to fetch");
    return answered(url as never, init);
  }) as unknown as typeof fetch;
  const { error } = await run(
    goalPlan(NEW_CONVERSATION, { schedule: true, runNow: true }),
  );
  const requests = methodsAndPaths(calls);
  expect(requests).not.toContain("POST /api/responsibilities/g1/pause");
  expect(requests).not.toContain("POST /api/responsibilities/g1/run");
  expect(requests.some((l) => l.startsWith("DELETE"))).toBe(false);
  expect(error).toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(
    "It's saved on the Routines page, but its schedule may not have been set. Open it there to check.",
  );
});

test("a refused routine takes the new conversation back", async () => {
  const calls = stub({
    "POST /api/routines": { status: 400, body: { error: "x" } },
  });
  const { error } = await run({
    kind: "routine",
    routine: {
      agentId: "a1",
      channelId: NEW_CONVERSATION,
      instruction: "Send the digest",
      cron,
      timezone,
    },
  });
  expect(methodsAndPaths(calls)).toContain("DELETE /api/channels/c9");
  expect(error?.message).toBe("x");
});

test("a goal that fails to start says it was saved", async () => {
  const calls = stub({
    "POST /api/responsibilities/g1/run": {
      status: 400,
      body: { error: "This goal is busy." },
    },
  });
  const { error } = await run(goalPlan(NEW_CONVERSATION, { runNow: true }));
  expect(methodsAndPaths(calls).some((l) => l.startsWith("DELETE"))).toBe(
    false,
  );
  expect(error).toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(
    "It's saved on the Routines page, but it didn't start. This goal is busy.",
  );
});

test("a goal that fails to start with no word from the server says where to run it", async () => {
  stub({
    "POST /api/responsibilities/g1/run": { status: 400, body: {} },
  });
  const { error } = await run(goalPlan(NEW_CONVERSATION, { runNow: true }));
  expect(error).toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(
    "It's saved on the Routines page, but it didn't start. Open it there to run it.",
  );
});

test("a refused goal changes nothing it can't take back", async () => {
  const calls = stub({
    "POST /api/responsibilities": { status: 400, body: { error: "no" } },
  });
  const { error } = await run(goalPlan(NEW_CONVERSATION, { schedule: true }));
  const seen = methodsAndPaths(calls);
  expect(seen).toContain("DELETE /api/channels/c9");
  expect(seen).not.toContain("POST /api/routines");
  // Nothing was saved, so this must not read as "saved but refused".
  expect(error).toBeDefined();
  expect(error).not.toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe("no");
});

test("onSettled refreshes the lists even after a refusal", async () => {
  stub(refusedSchedule);
  const { options, queryClient, invalidated, error } = await run(
    goalPlan(NEW_CONVERSATION, { schedule: true }),
  );
  expect(error).toBeDefined();
  await options.onSettled?.(
    undefined,
    error as Error,
    goalPlan(NEW_CONVERSATION, { schedule: true }),
    undefined,
    mutationContext(queryClient),
  );
  expect(invalidated).toEqual([
    { queryKey: ["routines"] },
    { queryKey: ["responsibilities"] },
    { queryKey: ["proactive", "settings"] },
    { queryKey: ["channels"] },
  ]);
});

for (const kind of ["routine", "goal", "check-in"] as const) {
  for (const failure of ["server", "network"] as const) {
    test(`an uncertain ${kind} create (${failure}) keeps its conversation and prevents retry`, async () => {
      const path =
        kind === "routine"
          ? "/api/routines"
          : kind === "goal"
            ? "/api/responsibilities"
            : "/api/proactive/settings?refuseExisting=true";
      const calls = stub({
        [`POST ${path}`]: { status: 503, body: { error: "Unavailable" } },
      });
      if (failure === "network") {
        const respond = globalThis.fetch;
        globalThis.fetch = Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (String(input) === path) throw new TypeError("Response lost");
            return respond(input, init);
          },
          { preconnect: respond.preconnect },
        );
      }
      const plan: RoutinePlan =
        kind === "goal"
          ? goalPlan(NEW_CONVERSATION)
          : kind === "check-in"
            ? checkInPlan(NEW_CONVERSATION)
            : {
                kind: "routine",
                routine: {
                  agentId: "a1",
                  channelId: NEW_CONVERSATION,
                  instruction: "Send the digest",
                  cron,
                  timezone,
                },
              };
      const { error } = await run(plan);
      expect(methodsAndPaths(calls)).not.toContain("DELETE /api/channels/c9");
      expect(error).toBeInstanceOf(SavedButRefused);
      expect(error?.message).toContain("may have been saved");
    });
  }
}
