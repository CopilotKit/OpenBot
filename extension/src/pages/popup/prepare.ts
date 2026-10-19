import { hasHostPermission } from "../../shared/host-access";
import { readLocal, writeLocal } from "../../shared/storage";
import { microphoneState } from "./voice";

type Prepared =
  | { ok: true }
  | { ok: false; reason: "permission" }
  | { ok: false; reason: "microphone" };

type PrepareDeps = {
  hasHostPermission: () => Promise<boolean>;
  microphoneState: () => Promise<PermissionState | null>;
  microphoneAsked: () => Promise<boolean>;
  rememberMicrophoneAsked: () => Promise<void>;
  openTab: (url: string) => Promise<void>;
};

const defaults: PrepareDeps = {
  hasHostPermission,
  microphoneState,
  microphoneAsked: async () => (await readLocal("microphoneAsked")) === true,
  rememberMicrophoneAsked: () => writeLocal("microphoneAsked", true),
  openTab: async (url) => {
    await chrome.tabs.create({ url: chrome.runtime.getURL(url) });
  },
};

/**
 * Runs inside the Record click handler. The popup never requests a permission
 * (a prompt can take focus and close the popup before the promise settles):
 * without website access it opens the access page, a full tab, instead. The
 * first Record also opens the microphone page once while Chrome has never been
 * asked, since every recording narrates; after that Record goes ahead whatever
 * Chrome answered, and the Voice row says what is wrong.
 */
export async function prepareRecording(
  deps: Partial<PrepareDeps> = {},
): Promise<Prepared> {
  const d = { ...defaults, ...deps };
  if (!(await d.hasHostPermission())) {
    await d.openTab("access.html");
    return { ok: false, reason: "permission" };
  }
  if (
    (await d.microphoneState()) === "prompt" &&
    !(await d.microphoneAsked())
  ) {
    await d.rememberMicrophoneAsked();
    await d.openTab("microphone.html");
    return { ok: false, reason: "microphone" };
  }
  return { ok: true };
}
