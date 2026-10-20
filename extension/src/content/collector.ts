import type { JsonValue, TrajectoryEvent } from "@copilotkit/learning";
import { createTrajectoryCollector } from "@copilotkit/learning";
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  maskCollectorEvent,
  sanitiseForIntelligence,
  trimEvent,
} from "@openbot/shared/recorder-masking";
import { AGENT_TARGET_FIELD, type AgentTarget } from "../shared/agent-target";
import { installActionCapture } from "./actions";
import type { SensitivityTracker } from "./masking-context";
import { agentTargetOf, createElementTracker, enrichStep } from "./targeting";

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
 * maskCollectorEvent cannot read, which is counted. `enrich` adds a click's or an edit's targeting (targeting.ts) first, so
 * the masking covers it too. The collector's `page` event is not a step: the service worker records each page change. A
 * click inside a chat message or tool call carries `agentTarget` (the ids CopilotKit's enricher reads) in a private field
 * added after the masking, so the ids stay as the page wrote them for the service worker to match against the agent's
 * messages; the service worker removes it. */
export function collectorBeforeSend(
  tracker: SensitivityTracker,
  onDropped?: (reason: string) => void,
  enrich: (event: CapturedEvent) => CapturedEvent = (event) => event,
  agentTarget: () => AgentTarget | null = () => null,
): (event: TrajectoryEvent) => TrajectoryEvent | null {
  return (event) => {
    const captured = event as CapturedEvent;
    if (captured?.name === "page") return null;
    const masked = maskCollectorEvent(
      enrich(captured),
      { sensitive: tracker.sensitiveForEvent(captured?.name ?? "") },
      { digests: tracker.digests() },
    );
    if (masked === null) {
      onDropped?.("unreadable");
      return null;
    }
    const trimmed = trimEvent(masked, EVENT_BUDGET_BYTES).event;
    const value = sanitiseForIntelligence(trimmed.value);
    const target = captured.name === "click" ? agentTarget() : null;
    return {
      ...trimmed,
      value:
        target &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
          ? { ...value, [AGENT_TARGET_FIELD]: target }
          : value,
    } as TrajectoryEvent;
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

/** Captures the person's steps: clicks and edits through the collector, each with its targeting, plus form submits and
 * Enter in a field (actions.ts). `send` also receives one `recorder.dropped { count, reason }` event per 5 s while the collector
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

  // Installed before the collector's own listeners, so for every click and edit it knows the element first.
  const elements = createElementTracker();
  let uninstallElements: () => void = () => {};
  try {
    uninstallElements = elements.install();
  } catch {
    // The collector's own start fails on the same page and counts it as CAPTURE_FAILED.
  }
  const collector = createTrajectoryCollector({
    capture: { clicks: true, inputs: true, navigation: false, network: false },
    beforeSend: collectorBeforeSend(
      tracker,
      countDrop,
      (event) =>
        event.name === "click" || event.name === "input"
          ? enrichStep(
              event,
              elements.elementFor(
                event.name === "click"
                  ? "click"
                  : String(
                      (event.value as { eventType?: unknown } | null)
                        ?.eventType ?? "",
                    ),
              ),
            )
          : event,
      () => agentTargetOf(elements.elementFor("click")),
    ),
    send: coalescing,
    onError: (error) => countDrop(error.code),
  });
  collector.start();
  // Submit and Enter go through the collector too, so they are masked and trimmed like a click. A page that refused the
  // collector's own listeners has already been counted as CAPTURE_FAILED.
  const failed = drops.has("CAPTURE_FAILED");
  const installed = failed
    ? null
    : installActionCapture({
        emit: (name, value) => collector.emit(name, value as JsonValue),
      });
  if (!failed && !installed) countDrop("CAPTURE_FAILED");
  const uninstallActions = installed ?? (() => {});

  return {
    stop() {
      uninstallActions();
      collector.stop();
      uninstallElements();
      flushInputs();
      if (dropTimer !== undefined) {
        timers.clear(dropTimer);
        reportDrops();
      }
    },
  };
}
