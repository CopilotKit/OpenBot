import {
  type DefaultError,
  type DefaultedQueryObserverOptions,
  hashKey,
  QueryClient,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";
import {
  holdReadsWhileConnectionLost,
  retryWhileConnectionLost,
} from "@/lib/desktop/connection-lost";
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
 * The app's client. Every query's retry rule is its own, wrapped once here so that a read failing
 * while OpenBot Desktop can't reach the OpenBot it is connected to waits for it instead of failing
 * (`lib/desktop/connection-lost.ts`). Wrapped where options are resolved, so a query that turns its
 * retries off is held the same way.
 */
class OpenBotQueryClient extends QueryClient {
  override defaultQueryOptions<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options:
      | QueryObserverOptions<
          TQueryFnData,
          TError,
          TData,
          TQueryData,
          TQueryKey,
          TPageParam
        >
      | DefaultedQueryObserverOptions<
          TQueryFnData,
          TError,
          TData,
          TQueryData,
          TQueryKey
        >,
  ): DefaultedQueryObserverOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  > {
    if (options._defaulted)
      return options as DefaultedQueryObserverOptions<
        TQueryFnData,
        TError,
        TData,
        TQueryData,
        TQueryKey
      >;
    const resolved = super.defaultQueryOptions(options);
    return {
      ...resolved,
      ...retryWhileConnectionLost<TError>(
        this,
        resolved.retry ?? false,
        resolved.retryDelay,
      ),
    };
  }
}

export const queryClient = new OpenBotQueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      queryKeyHashFn: organizationScopedHash,
    },
  },
});

holdReadsWhileConnectionLost(queryClient);

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
