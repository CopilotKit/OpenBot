// The one offscreen document: it holds the IndexedDB outbox and the socket that streams events to Intelligence
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
      // Chrome names no offscreen reason for a socket or an IndexedDB outbox, and only AUDIO_PLAYBACK limits a document's
      // lifetime (https://developer.chrome.com/docs/extensions/reference/api/offscreen#type-Reason). LOCAL_STORAGE,
      // durable storage in the document, is the nearest reason to what it does; USER_MEDIA is the microphone it
      // transcribes the person's narration from.
      reasons: ["LOCAL_STORAGE", "USER_MEDIA"],
      justification:
        "Keeps the recording in this browser, turns the person's narration into text, and sends it to Intelligence.",
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
