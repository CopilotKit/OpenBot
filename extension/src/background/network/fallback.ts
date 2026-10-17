// Feature off until Task 18 replaces it.
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";

export type PageFallback = {
  start(tabIds: number[]): Promise<boolean>;
  addTab(tabId: number): Promise<void>;
  onCommitted(tabId: number, frameId: number): Promise<void>;
  stop(): Promise<void>;
  active(): boolean;
};

export function createPageFallback(): PageFallback {
  return {
    start: async () => false,
    addTab: async () => {},
    onCommitted: async () => {},
    stop: async () => {},
    active: () => false,
  };
}

/** A recorder.page-network event from a recorded tab: re-masked with the digests (full bodies kept, up to 2 MiB each), plus its step. Null drops it.
 * The router hands the event to NetworkCapture.recordPageEvent, so large bodies reach the same body store as debugger capture. */
export function acceptPageNetworkEvent(
  _event: CapturedEvent,
  _digests: ReadonlySet<string>,
): { event: CapturedEvent; step: DemonstrationAction | null } | null {
  return null;
}
