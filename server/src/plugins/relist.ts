/**
 * Brings an upgraded install's brokered apps up to this build's reading of a listing, at startup.
 *
 * Not awaited by the start: listing asks the broker, and an offline start must still start. While
 * an app is behind, its stored actions keep working and ask as they did, and this tries again on a
 * timer until every app is listed, so nobody has to press Refresh tools. See
 * `relistOutdatedBrokeredApps` in `plugin-store/servers.ts`.
 */

/** How long to wait before each retry while an app is still behind. The last one repeats. */
export const RELIST_RETRY_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 300_000,
]);

/** Answers a function that stops the retries. */
export function startBrokeredRelist(
  store: { relistOutdatedBrokeredApps(): Promise<string[]> },
  retryMs: readonly number[] = RELIST_RETRY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let warned = false;
  const attempt = async (retry: number) => {
    let behind: string[];
    try {
      behind = await store.relistOutdatedBrokeredApps();
    } catch (error) {
      behind = ["(all)"];
      if (!warned)
        console.warn(
          `OpenBot couldn't list its apps again after the upgrade (${error instanceof Error ? error.message : String(error)}). It will keep trying.`,
        );
      warned = true;
    }
    if (behind.length === 0 || stopped) return;
    if (!warned)
      console.warn(
        `${behind.join(", ")} couldn't be listed again after the upgrade, so its actions ask as they did before. OpenBot will keep trying.`,
      );
    warned = true;
    const delay = retryMs[Math.min(retry, retryMs.length - 1)] ?? 300_000;
    timer = setTimeout(() => void attempt(retry + 1), delay);
    timer.unref?.();
  };
  void attempt(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
