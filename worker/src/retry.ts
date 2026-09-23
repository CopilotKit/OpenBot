/**
 * Retrying the handoff of one routine run to the server.
 *
 * `dispatch` in `index.ts` used to throw on the first non-202, so a single 502, 503
 * or 429 during a sweep marked the run failed and left the retry to the next sweep's
 * re-dispatch — or to nothing, when the claim had already been consumed. A transient
 * transport failure is worth retrying inside the handoff itself, with exponential
 * backoff and jitter, before the sweep reports it.
 *
 * Everything here is pure and injected (fetch, sleep, randomness) so the backoff and
 * the retry decision are unit-testable without a server, a database, or timers.
 */

export type DispatchRetryOptions = {
  /** Retries after the first attempt. 0 means try once and throw. */
  retries: number;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Base delay in milliseconds; retry N waits base * 2^(N-1) plus jitter. */
  baseMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number }>;

/** Statuses worth retrying: the server is busy, wedged, or asking us to slow down. */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/**
 * How long to wait before retry number `retry` (1-based), in milliseconds.
 *
 * Exponential backoff with jitter: `base * 2^(retry-1)` plus up to `base` extra, so
 * N workers restarted together do not retry in lockstep and thundering-herd the
 * server they just watched fail.
 */
export function computeBackoffMs(
  retry: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  const exponential = baseMs * 2 ** (retry - 1);
  return exponential + Math.floor(random() * baseMs);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/answered (\d+) rather than 202/);
  if (!match) return null;
  return Number.parseInt(match[1] ?? "", 10);
}

export function dispatchError(status: number): Error {
  return new Error(
    `the server answered ${status} rather than 202 when handed a routine run`,
  );
}

function isNonRetryableDispatchError(error: unknown): boolean {
  const status = statusOf(error);
  return status !== null && !isRetryableStatus(status);
}

/**
 * POST one routine run id, retrying transient failures.
 *
 * Retried: network errors (the fetch threw) and retryable statuses above. Not retried:
 * anything else — a 400, 401 or 404 is the deployment telling us the handoff itself is
 * wrong, and repeating it only fills the audit trail. The last failure is what throws,
 * carrying the status, because that is the whole diagnosis a person reading
 * `last_error` needs.
 */
export async function dispatchWithRetry(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: string,
  options: DispatchRetryOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(computeBackoffMs(attempt, options.baseMs, random));
    }
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.status === 202) return;
      lastError = dispatchError(response.status);
      if (!isRetryableStatus(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
      if (isNonRetryableDispatchError(error)) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        `failed to hand a routine run to the server: ${String(lastError)}`,
      );
}
