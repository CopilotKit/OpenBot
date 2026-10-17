// The one offscreen document: it records the tab's screen and the microphone and streams events to Intelligence
// (Task 11), so a service worker that sleeps loses nothing.
const OFFSCREEN_PATH = "offscreen.html";

let creating: Promise<void> | null = null;

export async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

/** Single-flight: concurrent callers share one `chrome.offscreen.createDocument`, so a second call never throws "Only a single
 * offscreen document may be created". */
export function ensureOffscreenDocument(): Promise<void> {
  creating ??= (async () => {
    if (await hasOffscreenDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification:
        "Records the tab's screen and the microphone, and sends the recording to Intelligence.",
    });
  })().finally(() => {
    creating = null;
  });
  return creating;
}

/** Closes the document if one is open; waits for a creation in flight first, so the two never cross. */
export async function closeOffscreenDocument(): Promise<void> {
  if (creating) await creating.catch(() => undefined);
  if (!(await hasOffscreenDocument())) return;
  await chrome.offscreen.closeDocument();
}
