import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { AgentProfile } from "../src/lib/agents/queries";
import { agentKeys } from "../src/lib/agents/queries";
import { authKeys } from "../src/lib/auth/queries";
import { activityFor, recordActivity } from "../src/lib/computers/activity";
import {
  type ComputerAction,
  setComputerStateMutationOptions,
} from "../src/lib/computers/mutations";

const realFetch = globalThis.fetch;

/** The person signed in, and the Bots they use, as the app has them cached when Admin is open. */
const ME = "dev-local-user";
let queryClient: QueryClient;

function bot(id: string, isolated = false): AgentProfile {
  return {
    id,
    isolated,
    isolationActive: isolated,
  } as AgentProfile;
}

/*
 * The context TanStack Query hands a mutation callback alongside its variables. These tests drive
 * the callbacks directly rather than through a MutationObserver, so they have to supply it. Both
 * fields are the real thing rather than a stand-in: `meta` is undefined exactly as it is for a
 * mutation declared without one, and `mutationKey` is optional and genuinely absent, because none
 * of these options factories sets one.
 */
function mutationContext(queryClient: QueryClient) {
  return { client: queryClient, meta: undefined };
}

/** New Bots for each case, as every real one is: a wipe is an event with a time, not a reset of the page. */
let cases = 0;
let general = "";
let knowledge = "";
let isolated = "";

beforeEach(() => {
  cases += 1;
  general = `general-${cases}`;
  knowledge = `knowledge-${cases}`;
  isolated = `isolated-${cases}`;
  globalThis.fetch = (async () =>
    new Response(null, { status: 200 })) as unknown as typeof fetch;
  queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.currentUser(), {
    id: ME,
    email: "dev@openbot.local",
    role: "admin",
    onboarding: null,
  });
  queryClient.setQueryData(agentKeys.list(false), [
    bot(general),
    bot(knowledge),
    bot(isolated, true),
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  for (const id of [general, knowledge, isolated])
    recordActivity(id, [
      {
        id: `call-echo-${id}`,
        did: {
          kind: "command",
          subject: "echo repro-marker-bravo",
          output: "repro-marker-bravo\n",
          exitCode: 0,
        },
      },
    ]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function run(
  action: ComputerAction,
  target: { computer: string; botId?: string },
) {
  const options = setComputerStateMutationOptions(queryClient);
  const variables = { action, ...target };
  await options.mutationFn?.(variables, mutationContext(queryClient));
  await options.onSuccess?.(
    undefined as never,
    variables,
    undefined as never,
    undefined as never,
  );
}

test("resetting a Bot's own computer forgets what the Bot did on the profile it deleted", async () => {
  expect(activityFor(general)).toHaveLength(1);

  await run("reset", { computer: `bot:${general}` });

  expect(activityFor(general)).toEqual([]);
  expect(activityFor(knowledge)).toHaveLength(1);
});

test("stopping a browser keeps the history, because the profile survives it", async () => {
  await run("stop", { computer: `person:${ME}`, botId: general });

  expect(activityFor(general)).toHaveLength(1);
  expect(activityFor(general)[0]?.subject).toBe("echo repro-marker-bravo");
});

test("resetting one Bot's seat on the person's computer leaves another Bot's history alone", async () => {
  // Admin, Computers: "David · General Assistant" on a shared computer, which names the seat's Bot.
  await run("reset", { computer: `person:${ME}`, botId: general });

  expect(activityFor(general)).toEqual([]);
  expect(activityFor(knowledge)).toHaveLength(1);
});

test("resetting a whole person's computer forgets every Bot that ran on it, and not an isolated one", async () => {
  // "David's computer", which names no Bot: it runs every Bot the person uses but an isolated one.
  await run("reset", { computer: `person:${ME}` });

  expect(activityFor(general)).toEqual([]);
  expect(activityFor(knowledge)).toEqual([]);
  expect(activityFor(isolated)).toHaveLength(1);
});

test("resetting another person's computer leaves this person's Activity, which ran on their own", async () => {
  await run("reset", { computer: "person:someone-else", botId: general });
  await run("reset", { computer: "person:someone-else" });

  expect(activityFor(general)).toHaveLength(1);
  expect(activityFor(knowledge)).toHaveLength(1);
});
