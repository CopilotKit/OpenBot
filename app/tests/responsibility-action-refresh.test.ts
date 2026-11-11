import { expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import {
  responsibilityActionMutationOptions,
  responsibilityKeys,
  updateResponsibilityMutationOptions,
} from "../src/lib/responsibilities";
import { routineKeys } from "../src/lib/routines/queries";

function invalidationRecorder() {
  const invalidated: unknown[] = [];
  const queryClient = {
    invalidateQueries: async (filter: unknown) => {
      invalidated.push(filter);
    },
  } as unknown as QueryClient;
  return { queryClient, invalidated };
}

const context = (queryClient: QueryClient) => ({
  client: queryClient,
  meta: undefined,
});

async function settle(
  options: { onSuccess?: unknown },
  queryClient: QueryClient,
  variables: unknown,
) {
  await (
    options.onSuccess as (
      data: unknown,
      variables: unknown,
      onMutateResult: unknown,
      context: unknown,
    ) => Promise<unknown>
  )({}, variables, undefined, context(queryClient));
}

const keys = (invalidated: unknown[]) =>
  invalidated.map((filter) => (filter as { queryKey: unknown }).queryKey);

test("completing a goal refreshes its routines as well as the goals", async () => {
  const { queryClient, invalidated } = invalidationRecorder();
  const options = responsibilityActionMutationOptions(queryClient);
  await settle(options, queryClient, { id: "g1", action: "complete" });
  expect(keys(invalidated)).toContainEqual(responsibilityKeys.all);
  expect(keys(invalidated)).toContainEqual(routineKeys.all);
});

test.each(["pause", "resume", "run"] as const)(
  "%s does not refresh routines: pause and resume leave them, and a run finishes after the response",
  async (action) => {
    const { queryClient, invalidated } = invalidationRecorder();
    const options = responsibilityActionMutationOptions(queryClient);
    await settle(options, queryClient, { id: "g1", action });
    expect(keys(invalidated)).toEqual([responsibilityKeys.all]);
  },
);

test("editing a goal does not refresh routines", async () => {
  const { queryClient, invalidated } = invalidationRecorder();
  const options = updateResponsibilityMutationOptions(queryClient);
  await settle(options, queryClient, { id: "g1", patch: {} });
  expect(keys(invalidated)).toEqual([responsibilityKeys.all]);
});
