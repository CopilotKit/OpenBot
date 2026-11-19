import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Whether an element is clipped by its own height, measured after every render (the words decide
 * it) and again whenever it is resized, as opening a disclosure around it does.
 *
 * A stable ref callback with an empty dependency list runs only once, while a collapsed element
 * still has no layout, so the "Show all" beside long text never appears. See #1878.
 */
export function useOverflows<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null);
  const [long, setLong] = useState(false);
  const measure = useCallback(() => {
    const element = ref.current;
    if (element) setLong(element.scrollHeight > element.clientHeight + 1);
  }, []);
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [measure]);
  return { ref, long };
}
