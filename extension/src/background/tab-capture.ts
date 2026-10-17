// Feature off until Task 19 replaces it.
/** chrome.tabCapture.getMediaStreamId({ targetTabId }), called immediately before offscreen.start / offscreen.screen. */
export async function acquireTabStreamId(
  _tabId: number,
): Promise<string | null> {
  return null;
}
