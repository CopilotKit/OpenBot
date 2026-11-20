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
    // The newest entry is the element as it is now. A panel sliding open delivers the frame it began
    // off-screen and the frame it arrived in together, and reading the first left it "hidden".
    const observer = new IntersectionObserver((entries) => {
      setVisible(Boolean(entries.at(-1)?.isIntersecting));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, visible];
}
