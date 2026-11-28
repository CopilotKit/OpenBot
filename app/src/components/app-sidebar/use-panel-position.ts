import { useLocation } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";

/** Return to the same search and scroll position when Back reopens a native list. */
const positions = new Map<string, { search: string; scrollTop: number }>();

export function usePanelPosition(standalone: boolean, rowCount: number) {
  const entry = useLocation({ select: (location) => location.state.__TSR_key });
  const key = standalone ? entry : undefined;
  const saved = key ? positions.get(key) : undefined;
  const [search, setSearch] = useState(saved?.search ?? "");
  const scrollRoot = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef(saved?.scrollTop ?? 0);

  useLayoutEffect(() => {
    const scroller = scrollRoot.current;
    if (rowCount && scroller && pendingScroll.current > 0) {
      scroller.scrollTop = pendingScroll.current;
      if (scroller.scrollTop >= pendingScroll.current - 1)
        pendingScroll.current = 0;
    }
  }, [rowCount]);

  useLayoutEffect(() => {
    if (!key) return;
    const scroller = scrollRoot.current;
    return () => {
      positions.set(key, { search, scrollTop: scroller?.scrollTop ?? 0 });
      if (positions.size > 50) {
        const oldest = positions.keys().next().value;
        if (oldest !== undefined) positions.delete(oldest);
      }
    };
  }, [key, search]);

  return { search, setSearch, scrollRoot };
}
