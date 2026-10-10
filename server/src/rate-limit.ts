import type { Context, MiddlewareHandler } from "hono";
import type { AppVariables } from "./auth/guards";

export type RateLimitOptions = {
  /** The sliding window, in milliseconds. */
  windowMs: number;
  /** How many requests one key may make inside the window. */
  max: number;
  /**
   * Who the budget belongs to. Defaults to the signed-in actor, so one person's
   * guessing never spends another's budget; callers without an actor share one
   * `anonymous` bucket, which fails in the safe direction.
   */
  keyOf?: (context: Context<{ Variables: AppVariables }>) => string;
  /** Injected by tests to move time without waiting out the window. */
  now?: () => number;
};

const MAX_TRACKED_KEYS = 10_000;

/**
 * A per-process sliding-window rate limiter, as Hono middleware.
 *
 * WHAT IT IS FOR. Endpoints that verify something guessable — a 2FA code on
 * `POST /api/sign-in-requests/:id/submit`, a saved-login code on `/:id/use-saved` —
 * had no bound on attempts at all: an authenticated caller could guess forever, one
 * request per guess, and the service would check each one. This bounds each key to
 * `max` requests per `windowMs` and answers the rest with 429 and a `Retry-After`
 * naming when the oldest attempt leaves the window.
 *
 * WHAT IT IS NOT. It is per-process memory, not shared state: a deployment running N
 * server replicas enforces roughly N times the budget, and a restart clears every
 * bucket. That is the documented trade, not a silent one — the day this needs a
 * shared backend (Redis, the database) the budgets stay the same and only the store
 * changes. It also counts requests, not failures, so a 429 never says whether any
 * earlier guess was close: there is no oracle in the refusal.
 */
export function createRateLimiter(
  options: RateLimitOptions,
): MiddlewareHandler<{ Variables: AppVariables }> {
  const windowMs = options.windowMs;
  const max = options.max;
  const keyOf =
    options.keyOf ??
    ((context: Context<{ Variables: AppVariables }>) =>
      context.var.actor?.id ?? "anonymous");
  const now = options.now ?? Date.now;
  const attempts = new Map<string, number[]>();

  function prune(key: string, at: number): number[] {
    const kept = (attempts.get(key) ?? []).filter(
      (seen) => seen > at - windowMs,
    );
    if (kept.length === 0) attempts.delete(key);
    else attempts.set(key, kept);
    return kept;
  }

  return async function rateLimit(context, next) {
    const key = keyOf(context);
    const at = now();
    // Bound the map itself: a caller minting distinct keys (rotating identities, if a
    // route ever keys on something caller-chosen) must not grow memory without end.
    if (attempts.size > MAX_TRACKED_KEYS) {
      for (const [other] of attempts) {
        prune(other, at);
        if (attempts.size <= MAX_TRACKED_KEYS) break;
      }
    }
    const recent = prune(key, at);
    if (recent.length >= max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(((recent[0] as number) + windowMs - at) / 1000),
      );
      return context.json(
        {
          error: `Too many attempts. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`,
        },
        429,
        { "Retry-After": String(retryAfterSeconds) },
      );
    }
    recent.push(at);
    attempts.set(key, recent);
    return next();
  };
}
