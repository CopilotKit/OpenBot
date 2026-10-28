// The content script runs only in the tabs a recording follows (Decision 4): it is injected at Record, when a tab the
// person uses joins the recording, and on each committed frame of a followed tab, never registered for every site, so
// an unrelated tab never runs it.
import type { BackgroundToContent } from "../protocol/messages";

/** Runs in the page's ISOLATED world before content.js, so the script starts capturing the moment it loads, before its
 * port says anything (the injection race, Task 9). Chrome serializes it: it must use nothing but its argument. */
function markRecordingActive(recordingId: string): void {
  (globalThis as { __openbotRecorderActive?: string }).__openbotRecorderActive =
    recordingId;
}

/** The active flag, then content.js, both as soon as possible; every frame of the tab when `frameIds` is absent. A frame
 * that must not capture (`active: false`, a site the person keeps out of their recordings) gets content.js alone, which
 * captures nothing until its port says to and shows the tab's recording mark. */
export async function injectRecordingScripts(
  tabId: number,
  recordingId: string,
  frameIds?: number[],
  options: { active?: boolean } = {},
): Promise<void> {
  const target =
    frameIds === undefined ? { tabId, allFrames: true } : { tabId, frameIds };
  if (options.active !== false)
    await chrome.scripting.executeScript({
      target,
      func: markRecordingActive,
      args: [recordingId],
      injectImmediately: true,
    });
  await chrome.scripting.executeScript({
    target,
    files: ["content.js"],
    injectImmediately: true,
  });
}

/** The content ports open in each tab, so messages reach every frame of the tabs a recording follows. */
const portsByTab = new Map<number, Set<chrome.runtime.Port>>();

/** Keeps a content port until it disconnects. A port from no tab (never a content script) is not kept. */
export function trackContentPort(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) return;
  const ports = portsByTab.get(tabId) ?? new Set();
  ports.add(port);
  portsByTab.set(tabId, ports);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (ports.size === 0 && portsByTab.get(tabId) === ports)
      portsByTab.delete(tabId);
  });
}

/** A new service worker holds no ports: the content scripts reconnect theirs. */
export function forgetContentPorts(): void {
  portsByTab.clear();
}

/** Posts to every content port of the tabs, or only to their top frames' ports. A port that closed meanwhile is skipped. */
export function postToContentPorts(
  tabIds: readonly number[],
  message: BackgroundToContent,
  options: { topFrameOnly?: boolean } = {},
): void {
  for (const tabId of tabIds) {
    for (const port of portsByTab.get(tabId) ?? []) {
      if (options.topFrameOnly && port.sender?.frameId !== 0) continue;
      try {
        port.postMessage(message);
      } catch {
        // The frame went away; its port's disconnect removes it.
      }
    }
  }
}

/** Tells the content scripts of these tabs to stop capturing. */
export async function stopRecordingScripts(tabIds: number[]): Promise<void> {
  postToContentPorts(tabIds, { type: "background.capture", active: false });
}
