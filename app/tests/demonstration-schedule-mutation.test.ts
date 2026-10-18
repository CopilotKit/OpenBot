import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { scheduleDemonstrationMutationOptions } from "@/lib/demonstrations/mutations";
import { demonstrationKeys } from "@/lib/demonstrations/queries";
import { routineKeys } from "@/lib/routines/queries";

test("scheduling a demonstration refreshes the demonstrations and the routines from the mutation itself", async () => {
  const queryClient = new QueryClient();
  const invalidated: unknown[] = [];
  queryClient.invalidateQueries = ((filters: { queryKey?: unknown }) => {
    invalidated.push(filters.queryKey);
    return Promise.resolve();
  }) as QueryClient["invalidateQueries"];

  const options = scheduleDemonstrationMutationOptions(queryClient);
  await (options.onSuccess as () => Promise<unknown>)();

  expect(invalidated).toContainEqual(demonstrationKeys.all);
  expect(invalidated).toContainEqual(routineKeys.all);
});
