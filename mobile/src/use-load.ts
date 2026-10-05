import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
export function useLoad<T>(load: () => Promise<T>, enabled = true) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const refresh = useCallback(async () => {
    setPending(true);
    try {
      setData(await load());
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not load this screen.",
      );
    } finally {
      setPending(false);
    }
  }, [load]);
  useEffect(() => {
    if (!enabled) {
      setData(undefined);
      setError(undefined);
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 10_000);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  return { data, error, pending, refresh };
}
