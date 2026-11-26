import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { everyPage, ORGANIZATION_ID } from "./api";
import { listCheckInItems } from "./api/generated/check-ins/check-ins";
import { listTasks } from "./api/generated/tasks/tasks";
import { waitingTasks } from "./tasks";

const counted = new Set<(count: number) => void>();

/** What Needs you lists now, said by the screen itself once it has read the list: the badge follows at once. */
export function showNeedsYouCount(count: number) {
  for (const show of counted) show(count);
}

/**
 * How many things Needs you lists: what the Bots' check-ins found and the tasks that wait on the
 * person. The Needs you tab's badge. Read when the tabs open, each time the person moves to another tab,
 * and when the app comes back to the front; it doesn't poll, as the badge is a hint and Needs you
 * itself reads the full list, and says its count here as it changes ({@link showNeedsYouCount}).
 * A count that fails to read keeps the last one.
 */
export function useNeedsYouCount(enabled: boolean, readAgain: unknown) {
  const [count, setCount] = useState(0);
  const read = useCallback(async () => {
    try {
      const [items, tasks] = await Promise.all([
        everyPage(
          (page) => listCheckInItems(ORGANIZATION_ID, page),
          (page) => page.checkInItems,
        ),
        everyPage(
          (page) => listTasks(ORGANIZATION_ID, page),
          (page) => page.tasks,
        ),
      ]);
      setCount(items.length + waitingTasks(tasks).length);
    } catch {
      // The badge keeps what it last showed.
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: readAgain only says when to read again
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    void read();
    counted.add(setCount);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void read();
    });
    return () => {
      counted.delete(setCount);
      appState.remove();
    };
  }, [enabled, read, readAgain]);
  return count;
}
