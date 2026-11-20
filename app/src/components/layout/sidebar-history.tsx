import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";
import {
  type createMemoryHistory,
  useCanGoBack,
  useRouter,
} from "@tanstack/react-router";
import { createContext, useCallback, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type History = ReturnType<typeof createMemoryHistory>;
const lastEntries = new WeakMap<History, number>();

/** TanStack exposes the current entry but has no forward-availability helper. Track app entries
 * across route changes. A push after going back replaces the forward branch. */
export function trackSidebarHistory(history: History) {
  if (lastEntries.has(history)) return;
  lastEntries.set(history, history.location.state.__TSR_index);
  history.subscribe(({ location, action }) => {
    const index = location.state.__TSR_index;
    const last = lastEntries.get(history) ?? index;
    lastEntries.set(
      history,
      action.type === "PUSH" ? index : Math.max(index, last),
    );
  });
}

export const SidebarHistoryContext = createContext(false);

export function SidebarHistoryButtons({
  divided = false,
  trailingDivider = false,
}: {
  divided?: boolean;
  trailingDivider?: boolean;
}) {
  const { history } = useRouter();
  const canGoBack = useCanGoBack();
  const subscribe = useCallback(
    (notify: () => void) => {
      trackSidebarHistory(history);
      return history.subscribe(notify);
    },
    [history],
  );
  const canGoForward = useSyncExternalStore(
    subscribe,
    () => history.location.state.__TSR_index < (lastEntries.get(history) ?? 0),
    () => false,
  );

  return (
    <fieldset
      className={cn(
        "m-0 flex min-w-0 shrink-0 items-center gap-0.5 border-0 p-0",
        divided && "mx-1 border-s border-sidebar-border ps-1.5",
        divided && trailingDivider && "border-e pe-1.5",
      )}
      aria-label="Navigation history"
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="cursor-pointer hover:bg-foreground/5"
        aria-label="Go back"
        title="Go back"
        disabled={!canGoBack}
        onClick={() => history.back()}
      >
        <IconArrowLeft />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="cursor-pointer hover:bg-foreground/5"
        aria-label="Go forward"
        title="Go forward"
        disabled={!canGoForward}
        onClick={() => history.forward()}
      >
        <IconArrowRight />
      </Button>
    </fieldset>
  );
}
