import { writeSession } from "../shared/storage";
import { currentConnection } from "./connection";

/** The page that asks for the microphone, the one permission the manifest cannot grant at install. */
export const SETUP_PAGE = "setup.html";

/**
 * Opens the setup page once, when the Recorder is first installed, in Chrome and Edge alike. Website access comes with
 * the install (a required host permission), but the browser asks for the microphone only on a page the person can see,
 * and the Recorder listens from a hidden document that can use only a lasting grant. Asking here means no Record ever
 * opens a tab: a recording without the microphone goes on, and its Voice row offers this page. An update, a browser
 * update or a service worker restart opens nothing.
 *
 * Nor does an OpenBot browser, which its launcher connected (launcher.ts): the launcher granted the microphone. Chrome
 * forgets a Recorder loaded over the DevTools protocol when it quits, so the launcher loads it afresh at every launch,
 * an install each time, while its storage survives: from the second launch on, the launcher's connection is already
 * here. On the first, the connection arrives a moment after the install and closes the tab this opened (`setupTabId`).
 */
export function installSetup(): void {
  chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason !== "install") return;
    if ((await currentConnection())?.via === "openbot-browser") return;
    const tab = await chrome.tabs.create({
      url: chrome.runtime.getURL(SETUP_PAGE),
    });
    if (tab.id !== undefined) await writeSession("setupTabId", tab.id);
  });
}
