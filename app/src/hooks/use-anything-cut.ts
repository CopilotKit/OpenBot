import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Whether any `.truncate` line inside the element given `ref` is cut short: measured after every
 * render, since the words decide it, and again whenever the element is resized, as dragging the
 * sidebar or a menu growing to its words does. A tooltip with the whole words is offered only then.
 */
export function useAnythingCut<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null);
  const [cut, setCut] = useState(false);
  const measure = useCallback(() => {
    const lines = ref.current?.querySelectorAll<HTMLElement>(".truncate");
    setCut(
      [...(lines ?? [])].some((line) => line.scrollWidth > line.clientWidth),
    );
  }, []);
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [measure]);
  return { ref, cut };
}
