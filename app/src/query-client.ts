import {
  focusManager,
  hashKey,
  QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  currentOrganizationId,
  onOrganizationChange,
} from "@/lib/organizations/current";

/**
 * What is the same whichever organization the person works in: the list of their organizations,
 * and what the deployment can do. Everything else is an organization's own.
 */
const EVERY_ORGANIZATION: ReadonlySet<unknown> = new Set([
  "organizations",
  "deployment",
]);

/** Whether a query's answer belongs to the organization it was asked in. */
export function belongsToOrganization(queryKey: QueryKey): boolean {
  return !EVERY_ORGANIZATION.has(queryKey[0]);
}

/**
 * Every query's cache key, with the organization the person is working in put in front.
 *
 * WHY HERE. An answer belongs to the organization it was asked in, whether the request named the
 * organization in its address or the server read it from the session. Written into each key factory,
 * the organization would be one forgotten factory away from showing one organization's rows in
 * another. Put in front of every key where the client hashes it, no factory can leave it out: the
 * same key asked in two organizations is two cache entries.
 *
 * Invalidating by a key factory's root (`agentKeys.all`) still reaches the entries it always did.
 */
export function organizationScopedHash(queryKey: QueryKey): string {
  const organization = currentOrganizationId();
  return organization === undefined || !belongsToOrganization(queryKey)
    ? hashKey(queryKey)
    : hashKey([{ organization }, ...queryKey]);
}

/**
 * A query that refetches when the person comes back to OpenBot does so when the page is shown again
 * AND when its window is focused again.
 *
 * TanStack Query 5 listens only for the page being shown (`visibilitychange`). OpenBot Desktop's
 * window stays shown while the person works in their browser beside it, so coming back to it never
 * hid or showed anything: a membership or an invitation made on the web stayed unseen in Desktop
 * until a reload. Its window being focused again is the moment that says it. A browser window
 * beside another is the same.
 */
focusManager.setEventListener((handleFocus) => {
  if (typeof window === "undefined" || !window.addEventListener) return;
  const refocused = () => handleFocus();
  window.addEventListener("visibilitychange", refocused, false);
  window.addEventListener("focus", refocused, false);
  return () => {
    window.removeEventListener("visibilitychange", refocused);
    window.removeEventListener("focus", refocused);
  };
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      queryKeyHashFn: organizationScopedHash,
    },
  },
});

/**
 * Moving from one organization to another drops everything the app held for the one left, in
 * flight or answered, so a screen can only be drawn from what the new one answers. Becoming known
 * for the first time drops nothing.
 */
onOrganizationChange((next, previous) => {
  if (next === undefined || previous === undefined) return;
  const left = {
    predicate: (query: { queryKey: QueryKey }) =>
      belongsToOrganization(query.queryKey),
  };
  void queryClient.cancelQueries(left);
  queryClient.removeQueries(left);
});
