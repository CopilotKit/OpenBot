import { afterEach, beforeEach, expect, test } from "bun:test";
import { inNoOrganization } from "@/lib/organizations/in-no-organization";
import { ownOrganizationsQueryOptions } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";

/**
 * Reading the person's organizations follows the app's retry rule like every other read: a screen
 * waiting on it settles when the rule says so, never a second later because the read kept a rule of
 * its own. Being in no organization is an answer and is never asked twice.
 */

const LIST_PATH = "/api/v2/people/me/organizations";
const originalFetch = globalThis.fetch;
const defaults = queryClient.getDefaultOptions();
/** How many times the list was asked for. */
let asked: number;
/** What the server answers the list with. */
let answer: () => Response;

beforeEach(() => {
  queryClient.clear();
  asked = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path !== LIST_PATH) return Response.json({});
      asked += 1;
      return answer();
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
});

/** The app's own rule, with `retry` changed and no wait between tries. */
function retrying(retry: boolean | number) {
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry, retryDelay: 0 },
  });
}

test("with retries off, a list the server fails to give is asked for once and fails at once", async () => {
  retrying(false);
  answer = () =>
    Response.json(
      { code: "INTERNAL", message: "Something went wrong." },
      { status: 500 },
    );

  await expect(
    queryClient.fetchQuery(ownOrganizationsQueryOptions()),
  ).rejects.toBeDefined();
  expect(asked).toBe(1);
  expect(queryClient.isFetching()).toBe(0);
});

test("with retries off, an answer that isn't a list fails at once instead of being asked again", async () => {
  retrying(false);
  answer = () => Response.json({});

  await expect(
    queryClient.fetchQuery(ownOrganizationsQueryOptions()),
  ).rejects.toBeDefined();
  expect(asked).toBe(1);
  expect(queryClient.isFetching()).toBe(0);
});

test("the app's rule of one retry still asks a failed list again once", async () => {
  retrying(1);
  answer = () =>
    Response.json(
      { code: "INTERNAL", message: "Something went wrong." },
      { status: 500 },
    );

  await expect(
    queryClient.fetchQuery(ownOrganizationsQueryOptions()),
  ).rejects.toBeDefined();
  expect(asked).toBe(2);
});

test("being in no organization is asked once, even where failures are retried", async () => {
  retrying(3);
  answer = () =>
    Response.json({ organizations: [], canCreate: false, nextCursor: null });

  const failure = await queryClient
    .fetchQuery(ownOrganizationsQueryOptions())
    .catch((error: unknown) => error);
  expect(inNoOrganization(failure)).toBe(true);
  expect(asked).toBe(1);
});
