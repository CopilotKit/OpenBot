import type {
  FetchInfiniteQueryOptions,
  FetchQueryOptions,
  QueryClient,
} from "@tanstack/react-query";

/** Any query a first screen can warm: each brings its own data and key types. */
type AnyFirstScreenQuery =
  // biome-ignore lint/suspicious/noExplicitAny: the query's own types are not the helper's business.
  | FetchQueryOptions<any, any, any, any>
  // biome-ignore lint/suspicious/noExplicitAny: the query's own types are not the helper's business.
  | FetchInfiniteQueryOptions<any, any, any, any, any>;

/** An infinite query is the one that says where its first page starts. */
function isInfinite(
  options: AnyFirstScreenQuery,
  // biome-ignore lint/suspicious/noExplicitAny: the query's own types are not the helper's business.
): options is FetchInfiniteQueryOptions<any, any, any, any, any> & {
  initialPageParam: unknown;
} {
  return "initialPageParam" in options;
}

/** How long a page's route waits for its first screen's data before the page takes over. */
export const FIRST_SCREEN_WAIT_MS = 300;

/**
 * Warm the data a page's first screen draws, waiting no longer than `withinMs` for it.
 *
 * A fast answer is in the cache when the page draws, so the page opens with its content instead of
 * a skeleton; a slow one is left to finish while the page draws its own loading state.
 *
 * NEVER REJECTS. The page shows its own error and hold states for a read that fails, and the
 * router's error screen must never show for data, so every failure is left in the query cache for
 * the page to read and nothing is thrown at the router.
 */
export async function loadFirstScreen(
  queryClient: QueryClient,
  queries: ReadonlyArray<AnyFirstScreenQuery>,
  withinMs = FIRST_SCREEN_WAIT_MS,
): Promise<void> {
  const all = queries.map(async (options) =>
    isInfinite(options)
      ? queryClient.ensureInfiniteQueryData(options)
      : queryClient.ensureQueryData(options),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, withinMs);
  });
  await Promise.race([Promise.allSettled(all), wait]);
  clearTimeout(timer);
}
