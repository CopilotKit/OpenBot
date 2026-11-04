import { useEffect, useRef } from "react";
import { tryClient } from "@/lib/client";

export type ResultReference = { threadId: string; messageId: string };
type ResultAction = "result_viewed" | "result_copied";

/** Forward observed identifiers only; the server supplies authenticated actor metadata. */
export async function recordResultAction(
  kind: ResultAction,
  reference: ResultReference,
): Promise<void> {
  try {
    const response = await tryClient("/api/telemetry/product-events", {
      method: "POST",
      body: {
        kind,
        threadId: reference.threadId,
        messageId: reference.messageId,
        surface: "web",
      },
    });
    if (!response.ok)
      console.warn("Result telemetry was not accepted.", response.status);
  } catch {
    // This best-effort observation must not interrupt chat or a successful copy.
    console.warn("Result telemetry could not be delivered.");
  }
}

/**
 * A settled assistant answer with nonempty rendered content counts only when some of its box
 * intersects the viewport and its document is visible. IntersectionObserver also accounts for
 * clipping by the conversation's scroll container. No observer support means coverage is unknown.
 */
export function useResultVisibility(
  reference: ResultReference | undefined,
  ready: boolean,
) {
  const ref = useRef<HTMLDivElement>(null);
  const observed = useRef<string | undefined>(undefined);
  const threadId = reference?.threadId;
  const messageId = reference?.messageId;
  useEffect(() => {
    const element = ref.current;
    if (
      !ready ||
      !threadId ||
      !messageId ||
      !element ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let intersecting = false;
    const key = JSON.stringify([threadId, messageId]);
    const observeView = () => {
      if (
        observed.current === key ||
        !intersecting ||
        document.visibilityState !== "visible" ||
        !element.isConnected
      )
        return;
      // One observation per mounted body. Reload/remount duplicates are identified in PostHog
      // by the stable event ID emitted by the server, not by browser persistence or retries.
      observed.current = key;
      void recordResultAction("result_viewed", { threadId, messageId });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target !== element) continue;
          intersecting =
            entry.isIntersecting &&
            entry.intersectionRatio > 0 &&
            entry.intersectionRect.width > 0 &&
            entry.intersectionRect.height > 0;
        }
        observeView();
      },
      {
        // A target touching the viewport edge can already be isIntersecting at ratio zero.
        // Include a positive threshold so moving into a nonzero visible area notifies us too.
        threshold: [0, Number.EPSILON],
      },
    );
    observer.observe(element);
    document.addEventListener("visibilitychange", observeView);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", observeView);
    };
  }, [threadId, messageId, ready]);
  return ref;
}
