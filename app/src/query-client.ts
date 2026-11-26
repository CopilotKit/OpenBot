import {
  type DefaultError,
  type DefaultedQueryObserverOptions,
  focusManager,
  hashKey,
  MutationCache,
  type Query,
  QueryCache,
  QueryClient,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";
import {
  pendingDeletionRefusal,
  showPendingDeletion,
} from "@/lib/account-deletion/pending";
import {
  HELD_OUT_NOW,
  heldOutBySso,
  holdOut,
  releaseHold,
} from "@/lib/auth/held-out";
import {
  holdReadsWhileConnectionLost,
  retryWhileConnectionLost,
} from "@/lib/desktop/connection-lost";
import { askAgainAfterMs } from "@/lib/load-failure";
import {
  currentOrganizationId,
  onOrganizationChange,
} from "@/lib/organizations/current";
import { inNoOrganization } from "@/lib/organizations/in-no-organization";
import { refusedInOrganization } from "@/lib/organizations/left";
import { askWhetherStillMember } from "@/lib/organizations/queries";

/**
 * What is the same whichever organization the person works in: the list of their organizations,
 * what the deployment can do, and deleting their account, which is theirs, not an organization's.
 * Everything else is an organization's own.
 */
const EVERY_ORGANIZATION: ReadonlySet<unknown> = new Set([
  "organizations",
  "deployment",
  "account-deletion",
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

/**
 * The app's client. Every query's retry rule is its own, wrapped once here so that a read failing
 * while OpenBot Desktop can't reach the OpenBot it is connected to waits for it instead of failing
 * (`lib/desktop/connection-lost.ts`). Wrapped where options are resolved, so a query that turns its
 * retries off is held the same way.
 *
 * Being in no organization is an answer, not a failure: asking again at once says the same and only
 * holds the page back, so it is never retried. So is being held out until signing in through the
 * company (`heldOutBySso`), and a refusal that may mean the person left the organization
 * (`refusedInOrganization`), which reads their organizations instead. A 503 that says when to ask
 * again is not retried at once either: the screen shows its sentence, and the read is asked again
 * after the time it gave, and again after each refusal until it answers (`askAgainWhenTold`). Not
 * through `retry` and `retryDelay`: a read that is being retried keeps its failure to itself until
 * the last try (TanStack Query hands it over as `failureReason`, not `error`), and the screen would
 * say nothing about the hold while it waits. Said here rather than in one query's options, where it
 * would replace the retry rule this client was given.
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
    const retry = resolved.retry ?? false;
    return {
      ...resolved,
      ...retryWhileConnectionLost<TError>(
        this,
        (failureCount, error) => {
          if (
            inNoOrganization(error) ||
            heldOutBySso(error) ||
            pendingDeletionRefusal(error) ||
            refusedInOrganization(error) ||
            askAgainAfterMs(error) !== undefined
          )
            return false;
          if (typeof retry === "function") return retry(failureCount, error);
          if (typeof retry === "number") return failureCount < retry;
          return retry;
        },
        resolved.retryDelay,
      ),
    };
  }
}

/**
 * A refusal for being held out, from any read or write while the app is open: the hold began since the page loaded,
 * and the app gives way to the held page at once (lib/auth/held-out.ts). In the server's own sentence.
 */
function holdOutWhenRefusedForIt(error: unknown): void {
  if (!heldOutBySso(error)) return;
  holdOut(error instanceof Error ? error.message : HELD_OUT_NOW);
}

/**
 * A refusal because the person's account is scheduled to be deleted, from any read or write while
 * the app is open: the app gives way to the pending page at once (lib/account-deletion/pending.ts).
 */
function showPendingWhenRefusedForIt(error: unknown): void {
  if (pendingDeletionRefusal(error)) showPendingDeletion();
}

/** Any read in the cache, as its events hand it over. */
type AnyQuery = Query<unknown, unknown, unknown>;

/** The reads waiting to be asked again after a 503's Retry-After: one wait each, never two. */
const askingAgain = new WeakSet<AnyQuery>();

/** The soonest a held read is asked again, whatever Retry-After said: never in a tight loop. */
const SOONEST_ASK_AGAIN_MS = 1_000;
/** The longest a held read waits before it is asked again, whatever Retry-After said. */
const LONGEST_ASK_AGAIN_MS = 60_000;

/**
 * A read refused 503 with a Retry-After (an organization being moved, or its database out of reach,
 * `lib/load-failure.ts`): asked again by itself after that long, and again after each refusal for as
 * long as the hold lasts, so the screen fills in within one Retry-After of OpenBot being back. Not
 * when the read is gone by then (the person works in another organization now) or nobody shows it
 * any more: the next screen that wants it asks for it afresh.
 *
 * It was asked again only once. A hold longer than one Retry-After (a database down for a few
 * minutes) left the screen saying the hold until the person reloaded.
 *
 * One read, one wait: a read refused again while its wait runs (a second screen asking for it)
 * waits the same wait, and the server is asked about it once per Retry-After at most.
 */
function askAgainWhenTold(error: unknown, query: AnyQuery): void {
  const wait = askAgainAfterMs(error);
  if (wait === undefined || askingAgain.has(query)) return;
  askingAgain.add(query);
  setTimeout(
    () => {
      askingAgain.delete(query);
      if (queryClient.getQueryCache().get(query.queryHash) !== query) return;
      // Answered meanwhile (Try again was pressed): nothing to ask.
      if (!query.isActive() || query.state.status !== "error") return;
      // Refused again, the cache's onError brings it back here for the next wait.
      void query.fetch().catch(() => undefined);
    },
    Math.min(Math.max(wait, SOONEST_ASK_AGAIN_MS), LONGEST_ASK_AGAIN_MS),
  );
}

/**
 * A refusal that may mean the person is no longer a member of the organization they work in: their
 * organizations are read again, which moves them to one they are still in when it is so
 * (lib/organizations/left.ts). Not for a read of that list itself, which would ask it again forever.
 */
function askWhetherStillMemberWhenRefused(
  error: unknown,
  queryKey: QueryKey | undefined,
): void {
  if (!refusedInOrganization(error) || queryKey?.[0] === "organizations")
    return;
  void askWhetherStillMember(queryClient);
}

export const queryClient = new OpenBotQueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      holdOutWhenRefusedForIt(error);
      showPendingWhenRefusedForIt(error);
      askAgainWhenTold(error, query);
      askWhetherStillMemberWhenRefused(error, query.queryKey);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      holdOutWhenRefusedForIt(error);
      showPendingWhenRefusedForIt(error);
      askWhetherStillMemberWhenRefused(error, undefined);
    },
  }),
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
  // A hold is the organization's that found it: working in another, nothing holds the person out.
  releaseHold();
  if (next === undefined || previous === undefined) return;
  const left = {
    predicate: (query: { queryKey: QueryKey }) =>
      belongsToOrganization(query.queryKey),
  };
  void queryClient.cancelQueries(left);
  queryClient.removeQueries(left);
});
