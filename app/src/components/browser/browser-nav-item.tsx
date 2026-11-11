import { toast } from "@/components/ui/toast";
import type { RecorderStore } from "@/lib/recorder/bridge";

/** What the page and the Skills page call the place where a person teaches their Bots a task. */
export const TEACH_A_BOT = "Teach a Bot";

/** The one toast that says the Recorder's store page opened. */
const STORE_TOAST = "browser-store-opened";

const STORE_NAMES: Record<RecorderStore, string> = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
};

/**
 * What the person is told when Settings, Browsers opened the Recorder's store page in a new tab of the browser OpenBot is
 * open in: adding it there is what lets them record from here.
 */
export function storeTabSentence(store: RecorderStore): string {
  return `The OpenBot Recorder's page is open in a new tab. Add it to ${STORE_NAMES[store]} to record from OpenBot.`;
}

/** The short note that waits in OpenBot for a person who opened the Recorder's store page in a new tab: one at a time,
 * so a second click replaces it rather than stacking another under it. */
export function noteStoreTabOpened(store: RecorderStore): void {
  toast.add({ id: STORE_TOAST, title: storeTabSentence(store), type: "info" });
}
