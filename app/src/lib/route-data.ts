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

/** Starts one first-screen query; the promise it returns may reject, and callers settle it. */
function startQuery(queryClient: QueryClient, options: AnyFirstScreenQuery) {
  return isInfinite(options)
    ? queryClient.ensureInfiniteQueryData(options)
    : queryClient.ensureQueryData(options);
}

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
  const all = queries.map(async (options) => startQuery(queryClient, options));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, withinMs);
  });
  await Promise.race([Promise.allSettled(all), wait]);
  clearTimeout(timer);
}

/**
 * Warm a first screen whose conditional reads depend on answers the page has to read first.
 *
 * The deciding reads, the unconditional ones in `always` and, once the deciding answers are in, the
 * ones `choose` picks once they are in the cache all share ONE budget of `withinMs`: a deciding read that is slow
 * (or, with the connection lost, retried without end) never holds the page, it only means the
 * conditional reads are not warmed and the page's own queries take over. `choose` reads the answers
 * from the query cache, where a read that failed has left nothing, which the page treats as unknown.
 *
 * NEVER REJECTS, like `loadFirstScreen`.
 */
export async function loadFirstScreenAfter(
  queryClient: QueryClient,
  {
    deciding,
    always = [],
    choose,
  }: {
    deciding: ReadonlyArray<AnyFirstScreenQuery>;
    always?: ReadonlyArray<AnyFirstScreenQuery>;
    choose: () => ReadonlyArray<AnyFirstScreenQuery>;
  },
  withinMs = FIRST_SCREEN_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + withinMs;
  const alwaysDone = loadFirstScreen(queryClient, always, withinMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), withinMs);
  });
  const answers = Promise.allSettled(
    deciding.map((options) => startQuery(queryClient, options)),
  );
  const result = await Promise.race([answers, wait]);
  clearTimeout(timer);
  if (result === "late") {
    await alwaysDone;
    return;
  }
  let chosen: ReadonlyArray<AnyFirstScreenQuery> = [];
  try {
    chosen = choose();
  } catch {
    // A choice that cannot be made leaves the page to ask for its own reads.
  }
  await Promise.all([
    alwaysDone,
    loadFirstScreen(queryClient, chosen, Math.max(0, deadline - Date.now())),
  ]);
}
