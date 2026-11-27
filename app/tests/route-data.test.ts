import { expect, test } from "bun:test";
import { infiniteQueryOptions, QueryClient } from "@tanstack/react-query";
import { ClientError } from "@/lib/client";
import {
  FIRST_SCREEN_WAIT_MS,
  loadFirstScreen,
  loadFirstScreenAfter,
} from "@/lib/route-data";

/** A loader helper never hands the router an error, and never keeps a page waiting past its limit. */

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("resolves once every query is in", async () => {
  const queryClient = new QueryClient();
  const answer = (value: string) => async () => {
    await delay(10);
    return value;
  };
  await loadFirstScreen(queryClient, [
    { queryKey: ["a"], queryFn: answer("one") },
    { queryKey: ["b"], queryFn: answer("two") },
  ]);
  expect(queryClient.getQueryData<unknown>(["a"])).toBe("one");
  expect(queryClient.getQueryData<unknown>(["b"])).toBe("two");
});

test("hands over after the wait", async () => {
  const queryClient = new QueryClient();
  const started = Date.now();
  await loadFirstScreen(
    queryClient,
    [
      {
        queryKey: ["slow"],
        queryFn: async () => {
          await delay(1_000);
          return "late";
        },
      },
    ],
    50,
  );
  const took = Date.now() - started;
  expect(took).toBeGreaterThanOrEqual(45);
  expect(took).toBeLessThan(500);
  expect(queryClient.isFetching()).toBe(1);
  queryClient.clear();
});

test("waits 300 ms by default", () => {
  expect(FIRST_SCREEN_WAIT_MS).toBe(300);
});

test("never rejects", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await loadFirstScreen(queryClient, [
    {
      queryKey: ["missing"],
      queryFn: async () => {
        throw new ClientError("Not found.", 404);
      },
    },
    {
      queryKey: ["held"],
      queryFn: async () => {
        throw new ClientError(
          "Try again in a moment.",
          503,
          undefined,
          undefined,
          10_000,
        );
      },
    },
  ]);
  expect(
    (queryClient.getQueryState(["missing"])?.error as ClientError | null)
      ?.status,
  ).toBe(404);
  expect(
    (queryClient.getQueryState(["held"])?.error as ClientError | null)?.status,
  ).toBe(503);
});

test("an answer already cached is not asked again", async () => {
  const queryClient = new QueryClient();
  let calls = 0;
  queryClient.setQueryData(["cached"], "here");
  await loadFirstScreen(queryClient, [
    {
      queryKey: ["cached"],
      queryFn: async () => {
        calls += 1;
        return "again";
      },
    },
  ]);
  expect(calls).toBe(0);
  expect(queryClient.getQueryData<unknown>(["cached"])).toBe("here");
});

test("takes an infinite query", async () => {
  const queryClient = new QueryClient();
  await loadFirstScreen(queryClient, [
    infiniteQueryOptions({
      queryKey: ["pages"],
      initialPageParam: "",
      queryFn: async () => ({ items: [1, 2] }),
      getNextPageParam: () => undefined,
    }),
  ]);
  expect(queryClient.getQueryData<unknown>(["pages"])).toEqual({
    pages: [{ items: [1, 2] }],
    pageParams: [""],
  });
});

test("never rejects, even without a query client", async () => {
  await loadFirstScreen(undefined as never, [
    { queryKey: ["a"], queryFn: async () => "one" },
  ]);
});

test("a deciding read that never answers holds neither the conditional reads nor the page", async () => {
  const queryClient = new QueryClient();
  let chose = false;
  const started = Date.now();
  await loadFirstScreenAfter(
    queryClient,
    {
      deciding: [{ queryKey: ["stuck"], queryFn: () => new Promise(() => {}) }],
      always: [{ queryKey: ["own"], queryFn: async () => "own" }],
      choose: () => {
        chose = true;
        return [];
      },
    },
    50,
  );
  expect(Date.now() - started).toBeLessThan(150);
  expect(chose).toBe(false);
  expect(queryClient.getQueryData<unknown>(["own"])).toBe("own");
  queryClient.clear();
});

test("conditional reads are chosen from the deciding answers and share the one budget", async () => {
  const queryClient = new QueryClient();
  const started = Date.now();
  await loadFirstScreenAfter(
    queryClient,
    {
      deciding: [
        {
          queryKey: ["d"],
          queryFn: async () => {
            await delay(30);
            return "yes";
          },
        },
      ],
      choose: () => [
        {
          queryKey: ["c"],
          queryFn: async () => {
            await delay(1_000);
            return "late";
          },
        },
      ],
    },
    80,
  );
  expect(queryClient.getQueryData<unknown>(["d"])).toBe("yes");
  expect(Date.now() - started).toBeLessThan(150);
  queryClient.clear();
});

test("a failed deciding read still lets the conditional reads be chosen, and never rejects", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await loadFirstScreenAfter(queryClient, {
    deciding: [
      {
        queryKey: ["bad"],
        queryFn: async () => {
          throw new ClientError("Nope.", 500);
        },
      },
    ],
    choose: () => [{ queryKey: ["after"], queryFn: async () => "ok" }],
  });
  expect(queryClient.getQueryData<unknown>(["after"])).toBe("ok");
});
