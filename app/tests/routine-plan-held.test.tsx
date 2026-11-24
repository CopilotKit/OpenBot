import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { failureSaid, unavailableSaid } from "../src/lib/load-failure";
import { NEW_CONVERSATION } from "../src/lib/routines/form";
import {
  createFromPlanMutationOptions,
  SavedButRefused,
} from "../src/lib/routines/mutations";
import type { RoutinePlan } from "../src/lib/routines/plan";
import {
  CONVERSATIONS_PATH,
  conversationPath,
  problemBody,
} from "./conversations-api";

/**
 * A routine whose save meets OpenBot holding off: an organization being moved between databases,
 * or its database briefly out of reach. The server answers 503 with a sentence and `Retry-After`
 * before it writes anything.
 *
 * Found in the end-to-end test of database sharding: when the goal was saved but its first run
 * was then held, the server's sentence was folded into "It's saved on the Routines page, but it
 * didn't start. OpenBot is moving this organization. Try again in a moment." and drawn in red, as a
 * failure. It is drawn calmly now, like the sentence alone. And a hold that meets the first write
 * is a refusal: nothing was saved, so the form stays open to press Create again, instead of being
 * locked as though the routine may have been saved.
 */
const MOVING = "OpenBot is moving this organization. Try again in a moment.";
const NEW = conversationPath("c9");
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers like the server, and holds the requests named in `held` with a 503 and Retry-After. */
function stub(held: string[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url);
    const sent =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push(`${method} ${path}`);
    if (held.includes(`${method} ${path}`))
      return new Response(
        JSON.stringify(problemBody(503, MOVING, "SERVICE_UNAVAILABLE")),
        {
          status: 503,
          headers: {
            "content-type": "application/problem+json",
            "Retry-After": "2",
          },
        },
      );
    const [status, body] =
      method === "POST" && path === "/api/v2/organizations/default/goals"
        ? [200, { goal: { id: "g1", title: "Ship it" } }]
        : method === "POST" && path === CONVERSATIONS_PATH
          ? [
              201,
              {
                conversation: {
                  id: "c9",
                  name: "Assistant",
                  botIds: sent.botIds,
                  threadId: "t9",
                  active: true,
                  lastMessageAt: null,
                },
              },
            ]
          : method === "PATCH" && path === NEW
            ? [200, { summary: sent.title }]
            : method === "DELETE" && path === NEW
              ? [204, undefined]
              : [200, { ok: true }];
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

async function run(plan: RoutinePlan): Promise<Error | undefined> {
  const queryClient = {
    invalidateQueries: async () => {},
  } as unknown as QueryClient;
  const options = createFromPlanMutationOptions(queryClient);
  return options
    .mutationFn?.(plan, { client: queryClient, meta: undefined })
    .then(
      () => undefined,
      (error: Error) => error,
    );
}

const goal = (extra: {
  schedule?: boolean;
  runNow?: boolean;
}): RoutinePlan => ({
  kind: "goal",
  goal: {
    botId: "a1",
    conversationId: NEW_CONVERSATION,
    title: "Ship it",
    instruction: "Ship the release",
    successCriteria: "It is out",
    subscriptions: [],
    recurring: false,
    endsWhenMet: true,
  },
  schedule: extra.schedule ? { cron: "0 9 * * 1", timezone: "UTC" } : null,
  runNow: extra.runNow ?? false,
});

/** Whether the page draws `error` calmly: the new routine page says it through `failureSaid`. */
const drawnCalmly = (error: Error | undefined) =>
  renderToStaticMarkup(<p>{failureSaid(error)}</p>).includes("data-held");

test("a goal saved, whose first run is held, says so calmly", async () => {
  stub(["POST /api/v2/organizations/default/goals/g1/run"]);
  const error = await run(goal({ runNow: true }));
  expect(error).toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(
    `It's saved on the Routines page, but it didn't start. ${MOVING}`,
  );
  expect(unavailableSaid(error)).toBe(error?.message);
  expect(drawnCalmly(error)).toBe(true);
});

test("a goal saved, whose schedule is held and can't be taken back, says so calmly", async () => {
  stub([
    "POST /api/v2/organizations/default/routines",
    "DELETE /api/v2/organizations/default/goals/g1",
    "POST /api/v2/organizations/default/goals/g1/pause",
  ]);
  const error = await run(goal({ schedule: true }));
  expect(error).toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(
    `It's saved on the Routines page, but it won't run on its own. Its schedule was refused. ${MOVING}`,
  );
  expect(drawnCalmly(error)).toBe(true);
});

test("a routine held before anything is saved leaves the form open, and says it calmly", async () => {
  const calls = stub(["POST /api/v2/organizations/default/routines"]);
  const error = await run({
    kind: "routine",
    routine: {
      botId: "a1",
      conversationId: NEW_CONVERSATION,
      instruction: "Send the digest",
      cron: "0 9 * * 1",
      timezone: "UTC",
    },
  });
  // Not locked as "it may have been saved": the hold refused it before writing.
  expect(error).not.toBeInstanceOf(SavedButRefused);
  expect(error?.message).toBe(MOVING);
  expect(drawnCalmly(error)).toBe(true);
  // The conversation started for it is taken back.
  expect(calls).toContain(`DELETE ${NEW}`);
});

test("a run that fails for a real reason is still said as a failure", async () => {
  globalThis.fetch = realFetch;
  stub([]);
  const plain = new SavedButRefused("It's saved, but it didn't start.", {
    cause: new Error("This goal is busy."),
  });
  expect(unavailableSaid(plain)).toBeUndefined();
  expect(drawnCalmly(plain)).toBe(false);
});
