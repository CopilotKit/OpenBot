// What the popup and the setup page need to know about the person's narration before a recording: whether Chrome
// lets the Recorder's own origin use the microphone, and the page's language.

/** Chrome's microphone permission for the Recorder's own origin, which the offscreen document records with. Null when
 * the browser cannot say. */
export async function microphoneState(): Promise<PermissionState | null> {
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state;
  } catch {
    return null;
  }
}

/** The recorded page's own language (its `<html lang>`), read when Record is pressed. Null for a page the Recorder
 * may not read (Chrome's own pages) or one that declares none. */
export async function pageLanguage(tabId: number): Promise<string | null> {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.lang,
    });
    return typeof frame?.result === "string" && frame.result
      ? frame.result
      : null;
  } catch {
    return null;
  }
}
