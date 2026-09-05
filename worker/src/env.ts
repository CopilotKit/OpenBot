import { randomUUID } from "node:crypto";

/**
 * What the worker needs from its environment, parsed and ready to use.
 *
 * `serverInternalUrl` never carries a trailing slash, so `routineRunUrl` cannot
 * produce the double-slash `//internal/routines/run` that a `SERVER_INTERNAL_URL`
 * with a trailing slash used to build — a 404 the sweep only reported as "the server
 * answered 404 rather than 202". `owner` falls back to a random suffix whenever
 * `HOSTNAME` is absent, empty or whitespace-only, so two workers never share a lease
 * name the way `routines/` alone would.
 */
export type WorkerEnv = {
  workerSharedSecret: string;
  serverInternalUrl: string;
  databaseUrl: string;
  owner: string;
};

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
  generateId: () => string = () => randomUUID().slice(0, 8),
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

  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set, so this worker has no database to read routines from or claim them in.",
    );
  }

  const host = environment.HOSTNAME?.trim();
  const owner = `routines/${host || generateId()}`;

  return { workerSharedSecret, serverInternalUrl, databaseUrl, owner };
}

/** Where a claimed run is handed to the server. Built on the normalised base URL. */
export function routineRunUrl(serverInternalUrl: string): string {
  return `${serverInternalUrl}/internal/routines/run`;
}
