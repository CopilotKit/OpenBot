import { useCallback, useRef, useState } from "react";

/**
 * Pull to refresh that spins only while the person's own pull is loading. `useLoad` reads again
 * every ten seconds by itself, and a spinner on each of those would flicker for nothing.
 */
export function usePull(...refreshes: (() => Promise<unknown>)[]) {
  const [refreshing, setRefreshing] = useState(false);
  // The screen's latest loads, read when the pull happens.
  const latest = useRef(refreshes);
  latest.current = refreshes;
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.allSettled(latest.current.map((refresh) => refresh())).finally(
      () => setRefreshing(false),
    );
  }, []);
  return { refreshing, onRefresh };
}
