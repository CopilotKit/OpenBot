import {
  type CapturedEvent,
  type JsonValue,
  maskNetworkEvent,
} from "@openbot/shared/recorder-masking";

export type PageFallback = {
  start(tabIds: number[]): Promise<boolean>;
  addTab(tabId: number): Promise<void>;
  onCommitted(tabId: number, frameId: number): Promise<void>;
  stop(): Promise<void>;
  active(): boolean;
};

/** The hook (main-world/network-hook.ts) defines the symbols openbot.recorder.configure and openbot.recorder.stop on globalThis. */

type Hook = Record<symbol, ((id?: string) => void) | undefined>;

const configureHook = (id: string): void =>
  (globalThis as unknown as Hook)[Symbol.for("openbot.recorder.configure")]?.(
    id,
  );
const stopHook = (): void =>
  (globalThis as unknown as Hook)[Symbol.for("openbot.recorder.stop")]?.();

/**
 * Injects the page-network hook into the MAIN world of the recorded tabs only: never registerContentScripts, so an
 * unrelated tab never gets the hook. A page Chrome refuses (a restricted or opaque sandboxed frame) is skipped.
 */
export function createPageFallback(): PageFallback {
  const tabs = new Set<number>();
  let running = false;

  const inject = async (tabId: number, frameIds?: number[]): Promise<void> => {
    const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
    await chrome.scripting.executeScript({
      target,
      world: "MAIN",
      injectImmediately: true,
      files: ["page-network.js"],
    });
    await chrome.scripting.executeScript({
      target,
      world: "MAIN",
      injectImmediately: true,
      func: configureHook,
      args: [chrome.runtime.id],
    });
  };

  return {
    async start(tabIds) {
      tabs.clear();
      for (const tabId of tabIds) tabs.add(tabId);
      try {
        for (const tabId of tabIds) await inject(tabId);
      } catch {
        tabs.clear();
        return false;
      }
      running = true;
      return true;
    },
    async addTab(tabId) {
      tabs.add(tabId);
      if (!running) return;
      await inject(tabId).catch(() => {});
    },
    async onCommitted(tabId, frameId) {
      if (!running || !tabs.has(tabId)) return;
      await inject(tabId, [frameId]).catch(() => {});
    },
    async stop() {
      const stopping = [...tabs];
      running = false;
      tabs.clear();
      for (const tabId of stopping)
        await chrome.scripting
          .executeScript({
            target: { tabId, allFrames: true },
            world: "MAIN",
            injectImmediately: true,
            func: stopHook,
          })
          .catch(() => {});
    },
    active: () => running,
  };
}

const isObject = (value: unknown): value is { [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A recorder.page-network event from a recorded tab, re-masked with the digests (the page cannot know them) and marked
 * `capturedBy: "page"`; null drops it. The router hands it to NetworkCapture.recordPageEvent, which screens it and hands
 * it to the steps, where a write can be a step's save. */
export function acceptPageNetworkEvent(
  event: CapturedEvent,
  digests: ReadonlySet<string>,
): CapturedEvent | null {
  if (!isObject(event) || event.name !== "network") return null;
  const value = event.value;
  if (
    !isObject(value) ||
    typeof value.url !== "string" ||
    typeof value.method !== "string" ||
    (typeof value.status !== "number" && value.status !== null)
  )
    return null;
  const masked = maskNetworkEvent(event, { digests });
  if (!isObject(masked.value)) return null;
  // Page scripts can forge these messages: consumers read capturedBy to know they are lower trust.
  return { ...masked, value: { ...masked.value, capturedBy: "page" } };
}
