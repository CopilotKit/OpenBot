import { useEffect, useState } from "react";

export function currentPageVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden" && !document.hidden;
}

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(currentPageVisible);

  useEffect(() => {
    const update = () => setVisible(currentPageVisible());
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return visible;
}

export function useElementVisible<T extends Element>(): [
  (node: T | null) => void,
  boolean,
] {
  const [node, setNode] = useState<T | null>(null);
  const [visible, setVisible] = useState(() => {
    if (typeof window === "undefined") return true;
    return !("IntersectionObserver" in window);
  });

  useEffect(() => {
    if (!node) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(Boolean(entry?.isIntersecting));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, visible];
}
