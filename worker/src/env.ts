import { workOwner } from "../../shared/work-owner";

/**
 * What the worker needs from its environment, parsed and ready to use.
 *
 * `serverInternalUrl` never carries a trailing slash, so `routineRunUrl` cannot
 * produce the double-slash `//internal/routines/run` that a `SERVER_INTERNAL_URL`
 * with a trailing slash used to build — a 404 the sweep only reported as "the server
 * answered 404 rather than 202". `owner` always carries a random suffix, so two
 * workers on one host never share a lease name; see `shared/work-owner.ts`.
 */
export type WorkerEnv = {
  workerSharedSecret: string;
  serverInternalUrl: string;
  databaseUrl: string;
  owner: string;
  /** How often both sweep phases run. Defaults to 30s. */
  tickMs: number;
  /** Purge finished `routine.fire` items every N ticks. Defaults to 120 (~hourly). */
  purgeEveryNTicks: number;
  /** Purge `routine.fire` items older than this. Defaults to 24h. */
  purgeOlderThanMs: number;
  /** How many times a transient dispatch failure is retried. Defaults to 3. */
  dispatchRetries: number;
  /** Per-attempt timeout for handing a run to the server. Defaults to 30s. */
  dispatchTimeoutMs: number;
  /** Base delay for exponential backoff between dispatch retries. Defaults to 500ms. */
  dispatchRetryBaseMs: number;
};

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_PURGE_EVERY_N_TICKS = 120;
const DEFAULT_PURGE_OLDER_THAN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DISPATCH_RETRIES = 3;
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
const DEFAULT_DISPATCH_RETRY_BASE_MS = 500;

/**
 * Read and validate the worker's three settings, failing fast and loudly.
 *
 * Whitespace-only values are refused exactly like unset ones: the old `if (!value)`
 * guards let `"   "` through, and the loop then failed on every tick — `fetch` to
 * `"   /internal/..."`, `createDatabase("   ")` on the first query — logging
 * `routine-sweep-tick-failed` forever instead of saying at boot what was misconfigured.
 */
export function loadWorkerEnv(
  environment: Record<string, string | undefined> = process.env,
): WorkerEnv {
  const workerSharedSecret = environment.WORKER_SHARED_SECRET?.trim();
  if (!workerSharedSecret) {
    throw new Error(
      "WORKER_SHARED_SECRET is not set, so this worker cannot authenticate itself to /internal/routines/run and no routine could be fired.",
    );
  }

  const rawServerUrl = environment.SERVER_INTERNAL_URL?.trim();
  if (!rawServerUrl) {
    throw new Error(
      "SERVER_INTERNAL_URL is not set, so this worker does not know where to hand a routine run.",
    );
  }
  const serverInternalUrl = rawServerUrl.replace(/\/+$/, "");
  if (!serverInternalUrl) {
    throw new Error(
      "SERVER_INTERNAL_URL is not set, so this worker does not know where to hand a routine run.",
    );
  }
  try {
    const parsed = new URL(serverInternalUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http(s)");
    }
  } catch {
    throw new Error(
      "SERVER_INTERNAL_URL must be a valid http(s) URL, so this worker knows where to hand a routine run.",
    );
  }

  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set, so this worker has no database to read routines from or claim them in.",
    );
  }

  const tickMs = readPositiveInt(
    environment.WORKER_TICK_MS,
    DEFAULT_TICK_MS,
    "WORKER_TICK_MS",
    1_000,
    600_000,
  );
  const purgeEveryNTicks = readPositiveInt(
    environment.WORKER_PURGE_EVERY_N_TICKS,
    DEFAULT_PURGE_EVERY_N_TICKS,
    "WORKER_PURGE_EVERY_N_TICKS",
    1,
    10_000,
  );
  const purgeOlderThanMs = readPositiveInt(
    environment.WORKER_PURGE_OLDER_THAN_MS,
    DEFAULT_PURGE_OLDER_THAN_MS,
    "WORKER_PURGE_OLDER_THAN_MS",
    60_000,
    30 * 24 * 60 * 60 * 1000,
  );
  const dispatchRetries = readPositiveInt(
    environment.WORKER_DISPATCH_RETRIES,
    DEFAULT_DISPATCH_RETRIES,
    "WORKER_DISPATCH_RETRIES",
    0,
    10,
    true,
  );
  const dispatchTimeoutMs = readPositiveInt(
    environment.WORKER_DISPATCH_TIMEOUT_MS,
    DEFAULT_DISPATCH_TIMEOUT_MS,
    "WORKER_DISPATCH_TIMEOUT_MS",
    1_000,
    120_000,
  );
  const dispatchRetryBaseMs = readPositiveInt(
    environment.WORKER_DISPATCH_RETRY_BASE_MS,
    DEFAULT_DISPATCH_RETRY_BASE_MS,
    "WORKER_DISPATCH_RETRY_BASE_MS",
    100,
    10_000,
  );

  const owner = workOwner("routines", environment);

  return {
    workerSharedSecret,
    serverInternalUrl,
    databaseUrl,
    owner,
    tickMs,
    purgeEveryNTicks,
    purgeOlderThanMs,
    dispatchRetries,
    dispatchTimeoutMs,
    dispatchRetryBaseMs,
  };
}

/**
 * Read an optional positive integer setting, failing fast with the variable named.
 *
 * Blank means unset and reads as the default, so `WORKER_TICK_MS=` does not move the
 * loop. Anything else must be a run of digits in range: `30s`, `12abc` and `3.9` are
 * all refused rather than silently coerced, because a cadence that quietly went nowhere
 * would leave routines stale with nothing saying so.
 */
function readPositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
  allowZero = false,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `${name} must be a whole number of ${describeUnit(name)}, so this worker knows ${describePurpose(name)}. Got ${JSON.stringify(raw)}.`,
    );
  }
  const value = Number.parseInt(trimmed, 10);
  const lower = allowZero ? 0 : min;
  if (!Number.isSafeInteger(value) || value < lower || value > max) {
    throw new Error(
      `${name} must be a whole number between ${lower} and ${max}, so this worker knows ${describePurpose(name)}. Got ${JSON.stringify(raw)}.`,
    );
  }
  if (!allowZero && value < min) {
    throw new Error(
      `${name} must be at least ${min}, so this worker knows ${describePurpose(name)}. Got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

function describeUnit(name: string): string {
  if (name === "WORKER_PURGE_EVERY_N_TICKS") return "ticks";
  if (name === "WORKER_DISPATCH_RETRIES") return "retries";
  return "milliseconds";
}

function describePurpose(name: string): string {
  if (name === "WORKER_TICK_MS") return "how often to sweep for due routines";
  if (name === "WORKER_PURGE_EVERY_N_TICKS")
    return "how often to purge finished routine work";
  if (name === "WORKER_PURGE_OLDER_THAN_MS")
    return "how long to keep finished routine work";
  if (name === "WORKER_DISPATCH_RETRIES")
    return "how many times to retry handing a run to the server";
  if (name === "WORKER_DISPATCH_TIMEOUT_MS")
    return "how long one handoff may take before it is retried";
  return "how long to wait between dispatch retries";
}

/** Where a claimed run is handed to the server. Built on the normalised base URL. */
export function routineRunUrl(serverInternalUrl: string): string {
  return `${serverInternalUrl}/internal/routines/run`;
}
