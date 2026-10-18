/**
 * chrome.tabCapture.getMediaStreamId({ targetTabId }), called immediately before offscreen.start / offscreen.screen.
 *
 * Called from the service worker with no `consumerTabId`, so an extension document (the offscreen document) consumes
 * the id. developer.chrome.com/docs/extensions/reference/api/tabCapture: "a stream ID obtained in a service worker can
 * be used in an offscreen document", and the id "can only be used once and expires after a few seconds if it is not
 * used", so callers take it last and the offscreen document consumes it first thing.
 */
export async function acquireTabStreamId(
  tabId: number,
): Promise<string | null> {
  if (import.meta.env.RECORDER_VARIANT === "e2e")
    return "RECORDER_E2E_SYNTHETIC";
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch {
    return null;
  }
}
