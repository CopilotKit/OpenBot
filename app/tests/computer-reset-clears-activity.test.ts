import { afterEach, beforeEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import {
  activityFor,
  clearActivity,
  recordActivity,
} from "../src/lib/computers/activity";
import { setComputerStateMutationOptions } from "../src/lib/computers/mutations";

const realFetch = globalThis.fetch;

const queryClient = {
  invalidateQueries: async () => undefined,
} as unknown as QueryClient;

beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(null, { status: 200 })) as unknown as typeof fetch;
  clearActivity("general-assistant");
  recordActivity("general-assistant", {
    kind: "command",
    subject: "echo repro-marker-bravo",
    output: "repro-marker-bravo\n",
    exitCode: 0,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearActivity("general-assistant");
});

async function run(action: "stop" | "reset") {
  const options = setComputerStateMutationOptions(queryClient);
  const variables = { action, botId: "general-assistant" } as const;
  await options.mutationFn?.(variables);
  await options.onSuccess?.(
    undefined as never,
    variables,
    undefined as never,
    undefined as never,
  );
}

test("resetting a computer forgets what the Bot did on the profile it deleted", async () => {
  expect(activityFor("general-assistant")).toHaveLength(1);

  await run("reset");

  expect(activityFor("general-assistant")).toEqual([]);
});

test("stopping a browser keeps the history, because the profile survives it", async () => {
  await run("stop");

  expect(activityFor("general-assistant")).toHaveLength(1);
  expect(activityFor("general-assistant")[0]?.subject).toBe(
    "echo repro-marker-bravo",
  );
});

test("one Bot's reset leaves another Bot's history alone", async () => {
  recordActivity("knowledge", {
    kind: "list_files",
    subject: "the workspace",
    output: "notes.md\n",
  });

  await run("reset");

  expect(activityFor("general-assistant")).toEqual([]);
  expect(activityFor("knowledge")).toHaveLength(1);
  clearActivity("knowledge");
});
