import { useEffect, useRef } from "react";
import { tryClient } from "@/lib/client";

export type ResultReference = { threadId: string; messageId: string };
type ResultAction = "result_viewed" | "result_copied";

// A tab only suppresses redundant transport. The server owns durable deduplication and resolves
// the actor, deployment, run and outcome from these identifiers, including after a reload.
const pending = new Map<string, Promise<boolean>>();

export function recordResultAction(
  kind: ResultAction,
  reference: ResultReference,
): Promise<boolean> {
  const key = JSON.stringify([kind, reference.threadId, reference.messageId]);
  const existing = pending.get(key);
  if (existing) return existing;

  const request = (async () => {
    try {
      const response = await tryClient("/api/telemetry/product-events", {
        method: "POST",
        body: {
          kind,
          threadId: reference.threadId,
          messageId: reference.messageId,
          surface: "web",
        },
        signal: AbortSignal.timeout(5000),
      });
      // 202 means the server could not yet establish the durable message/run linkage. A later
      // visible observation may retry; it is not an accepted consumption event.
      if (!response.ok || response.status === 202) {
        if (!response.ok)
          console.warn("Result telemetry was not accepted.", response.status);
        return false;
      }
      return true;
    } catch {
      // Analytics must not interrupt a conversation or a successful clipboard operation.
      console.warn("Result telemetry could not be delivered.");
      return false;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, request);
  return request;
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
    let disposed = false;
    let recorded = false;
    let inFlight = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const clearRetry = () => {
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
    };
    const visible = () =>
      !disposed &&
      intersecting &&
      document.visibilityState === "visible" &&
      element.isConnected;
    const observeView = () => {
      if (
        !visible() ||
        recorded ||
        inFlight ||
        retry !== undefined ||
        attempts >= 3
      )
        return;
      inFlight = true;
      attempts += 1;
      void recordResultAction("result_viewed", { threadId, messageId }).then(
        (accepted) => {
          inFlight = false;
          recorded = accepted;
          if (!recorded && visible() && attempts < 3) {
            retry = setTimeout(() => {
              retry = undefined;
              observeView();
            }, 1000);
          }
        },
      );
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
        if (!intersecting) clearRetry();
        observeView();
      },
      {
        // A target touching the viewport edge can already be isIntersecting at ratio zero.
        // Include a positive threshold so moving into a nonzero visible area notifies us too.
        threshold: [0, Number.EPSILON],
      },
    );
    const onVisibility = () => {
      if (document.visibilityState !== "visible") clearRetry();
      else {
        attempts = 0;
        observeView();
      }
    };
    observer.observe(element);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearRetry();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [threadId, messageId, ready]);
  return ref;
}
