import type { TrajectoryEvent } from "@copilotkit/learning";
import { createTrajectoryCollector } from "@copilotkit/learning";
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  maskCollectorEvent,
  sanitiseForIntelligence,
  trimEvent,
} from "@openbot/shared/recorder-masking";
import type { SensitivityTracker } from "./masking-context";

const COALESCE_MS = 750;
const DROP_REPORT_MS = 5_000;

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Mask, trim to EVENT_BUDGET_BYTES, then sanitise (NUL and lone surrogates), so the collector's own checks after beforeSend
 * (it refuses NUL with INVALID_EVENT and anything over 16 KiB with EVENT_TOO_LARGE) never drop an event; null only for an event
 * maskCollectorEvent cannot read, which is counted. */
export function collectorBeforeSend(
  tracker: SensitivityTracker,
  emitLater: (event: CapturedEvent) => void,
  onDropped?: (reason: string) => void,
): (event: TrajectoryEvent) => TrajectoryEvent | null {
  const prepare = (event: CapturedEvent): CapturedEvent | null => {
    const masked = maskCollectorEvent(
      event,
      { sensitive: tracker.sensitiveForEvent(event?.name ?? "") },
      { digests: tracker.digests() },
    );
    if (masked === null) {
      onDropped?.("unreadable");
      return null;
    }
    const trimmed = trimEvent(masked, EVENT_BUDGET_BYTES).event;
    return { ...trimmed, value: sanitiseForIntelligence(trimmed.value) };
  };

  return (event) => {
    const captured = event as CapturedEvent;
    if (captured?.name === "page") {
      // The collector emits one `page` event whenever it starts; the service worker records navigation for every frame.
      if (window !== window.top) return null;
      if (document.readyState === "loading") {
        // Injected as soon as the frame commits, so the title can still be empty.
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            const value = captured.value;
            const withTitle: CapturedEvent = {
              ...captured,
              value:
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value)
                  ? { ...value, title: document.title }
                  : value,
            };
            const ready = prepare(withTitle);
            if (ready) emitLater(ready);
          },
          { once: true },
        );
        return null;
      }
    }
    return prepare(captured) as TrajectoryEvent | null;
  };
}

const inputKey = (event: CapturedEvent): string => {
  const value = event.value as {
    target?: { tag?: string; attributes?: Record<string, string> };
    url?: string;
  } | null;
  return JSON.stringify([
    value?.target?.tag,
    value?.target?.attributes?.id,
    value?.target?.attributes?.name,
    value?.url,
  ]);
};

/** Captures clicks and inputs. `send` also receives one `recorder.dropped { count, reason }` event per 5 s while the collector
 * reported errors (INVALID_EVENT, EVENT_TOO_LARGE, PERSISTENCE_UNKNOWN, CAPTURE_FAILED) or beforeSend dropped one, so no event
 * vanishes uncounted. Network is off (the collector's patch of `fetch` sees nothing in this isolated world; the debugger or
 * the MAIN-world bundle capture it) and navigation is off (the service worker records it from `webNavigation`). */
export function startEventCapture(options: {
  tracker: SensitivityTracker;
  send(event: CapturedEvent): void;
  coalesceMs?: number;
  timers?: Timers;
}): { stop(): void } {
  const { tracker, send } = options;
  const coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const timers = options.timers ?? realTimers;
  const drops = new Map<string, number>();
  let dropTimer: unknown;
  const pending = new Map<string, { event: CapturedEvent; timer: unknown }>();

  const countDrop = (reason: string) => {
    drops.set(reason, (drops.get(reason) ?? 0) + 1);
    dropTimer ??= timers.set(reportDrops, DROP_REPORT_MS);
  };
  const deliver = (event: CapturedEvent) => {
    try {
      send(event);
    } catch {
      countDrop("PERSISTENCE_UNKNOWN");
    }
  };
  const flushInputs = () => {
    for (const [key, entry] of pending) {
      timers.clear(entry.timer);
      pending.delete(key);
      deliver(entry.event);
    }
  };
  function reportDrops() {
    dropTimer = undefined;
    const counted = [...drops];
    drops.clear();
    flushInputs();
    for (const [reason, count] of counted)
      deliver({
        type: "CUSTOM",
        name: "recorder.dropped",
        timestamp: Date.now(),
        value: { count, reason },
      });
  }

  const coalescing = (event: TrajectoryEvent) => {
    const captured = event as CapturedEvent;
    if (captured.name !== "input") {
      flushInputs();
      deliver(captured);
      return;
    }
    const key = inputKey(captured);
    if ((captured.value as { eventType?: string }).eventType === "change") {
      // The change event is the field's latest value: it replaces the field's own pending input.
      const own = pending.get(key);
      if (own) {
        timers.clear(own.timer);
        pending.delete(key);
      }
      flushInputs();
      deliver(captured);
      return;
    }
    const previous = pending.get(key);
    if (previous) timers.clear(previous.timer);
    pending.set(key, {
      event: captured,
      timer: timers.set(() => {
        const entry = pending.get(key);
        if (!entry) return;
        pending.delete(key);
        deliver(entry.event);
      }, coalesceMs),
    });
  };

  const collector = createTrajectoryCollector({
    capture: { clicks: true, inputs: true, navigation: false, network: false },
    beforeSend: collectorBeforeSend(tracker, deliver, countDrop),
    send: coalescing,
    onError: (error) => countDrop(error.code),
  });
  collector.start();

  return {
    stop() {
      collector.stop();
      flushInputs();
      if (dropTimer !== undefined) {
        timers.clear(dropTimer);
        reportDrops();
      }
    },
  };
}
