/**
 * Where this process should listen.
 *
 * The ports table, `scripts/start.sh`, and the Vite `/api` proxy all name `SERVER_PORT`. The process
 * used to read only `PORT`, which is what `.env.example` used to set, so a clone that followed the
 * docs moved the proxy and the health check but not the listener.
 *
 * `SERVER_PORT` first, then `PORT`, then 3001. Existing files that only set `PORT` keep working.
 */
export function resolveListenPort(
  environment: Record<string, string | undefined> = process.env,
): number {
  const raw =
    environment.SERVER_PORT?.trim() || environment.PORT?.trim() || "3001";
  return Number.parseInt(raw, 10);
}
