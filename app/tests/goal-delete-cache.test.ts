import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  deleteResponsibilityMutationOptions,
  responsibilityKeys,
} from "@/lib/responsibilities";

/**
 * A deleted goal's triggers and runs stop existing. Refetching them asks the server for a goal that
 * is gone and answers 404, which the open dialog still watching them used to do.
 */
test("deleting a goal drops its triggers and runs and refetches the other goals", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const fetched: string[] = [];
  const watch = (queryKey: readonly unknown[], label: string) => {
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => {
        fetched.push(label);
        return [];
      },
    });
    return observer.subscribe(() => {});
  };
  const stops = [
    watch(responsibilityKeys.triggers("gone"), "gone triggers"),
    watch(responsibilityKeys.runs("gone"), "gone runs"),
    watch(responsibilityKeys.triggers("kept"), "kept triggers"),
    watch(responsibilityKeys.all, "goals"),
  ];
  await new Promise((resolve) => setTimeout(resolve, 20));
  fetched.length = 0;

  const options = deleteResponsibilityMutationOptions(queryClient);
  await options.onSuccess?.(new Response(null), "gone", undefined, {
    client: queryClient,
    meta: undefined,
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(fetched.sort()).toEqual(["goals", "kept triggers"]);
  expect(
    queryClient.getQueryCache().find({
      queryKey: responsibilityKeys.triggers("gone"),
      exact: true,
    }),
  ).toBeUndefined();
  for (const stop of stops) stop();
});
