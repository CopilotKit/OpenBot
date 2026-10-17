// Feature off until Task 17 replaces it.
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  trimEvent,
} from "@openbot/shared/recorder-masking";
import type { DrainRecord } from "../../shared/storage";
import type { PageFallback } from "./fallback";

export type NetworkMode = "debugger" | "page" | "waiting" | "off";
export type RecordingContext = {
  openbotUrl: string;
  token: string;
  demonstrationId: string;
};
export type NetworkCaptureDeps = {
  context(): RecordingContext | null;
  emit(event: CapturedEvent): void;
  step(action: DemonstrationAction): void;
  status(mode: NetworkMode | "stopped", reason?: string): void;
  digests(): ReadonlySet<string>;
};
export type NetworkCapture = {
  start(tabId: number, url: string): Promise<NetworkMode>;
  addTab(tabId: number, url: string): Promise<void>;
  /** Every committed navigation in a followed tab (any frame): lets a tab that started on chrome:// attach once it reaches a site. */
  onCommitted(tabId: number, frameId: number, url: string): Promise<void>;
  /** After a service-worker restart: re-attach to every followed tab (detaching a stale session of ours first). */
  resume(tabs: { tabId: number; url: string }[]): Promise<NetworkMode>;
  /** A page-level fallback event (Task 18), already re-masked: stored and emitted exactly like a debugger event, large bodies through the same body store. */
  recordPageEvent(event: CapturedEvent): Promise<void>;
  stop(): Promise<void>;
};

/** The capture owns the page-level fallback it is given: it alone starts it (when attach is refused on a real site),
 * forwards addTab and onCommitted to it while the mode is `page`, resumes it, and stops it. Task 9 creates the fallback with
 * createPageFallback() and hands it over here; it never calls the fallback itself. */
export function createNetworkCapture(
  deps: NetworkCaptureDeps,
  _options?: { fallback?: PageFallback },
): NetworkCapture {
  return {
    start: async () => "off",
    addTab: async () => {},
    onCommitted: async () => {},
    resume: async () => "off",
    recordPageEvent: async (event) =>
      deps.emit(trimEvent(event, EVENT_BUDGET_BYTES).event), // feature off: trimmed, no body store
    stop: async () => {},
  };
}

/** After a browser restart (Task 9's recovery): upload a drained recording's network body lines still in IndexedDB and
 * complete its network media. Feature off: nothing is buffered, so nothing to do. */
export async function recoverNetworkBodies(
  _drain: DrainRecord,
  _target: { openbotUrl: string; token: string },
): Promise<void> {}
