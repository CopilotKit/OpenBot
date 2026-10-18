import { hasHostPermission } from "../../shared/host-access";

export type Prepared = { ok: true } | { ok: false; reason: "permission" };

type PrepareDeps = {
  hasHostPermission: () => Promise<boolean>;
  openTab: (url: string) => Promise<void>;
};

const defaults: PrepareDeps = {
  hasHostPermission,
  openTab: async (url) => {
    await chrome.tabs.create({ url: chrome.runtime.getURL(url) });
  },
};

/**
 * Runs inside the Record click handler. The popup never requests a permission
 * (a prompt can take focus and close the popup before the promise settles):
 * without website access it opens the access page, a full tab, instead.
 */
export async function prepareRecording(
  deps: Partial<PrepareDeps> = {},
): Promise<Prepared> {
  const d = { ...defaults, ...deps };
  if (!(await d.hasHostPermission())) {
    await d.openTab("access.html");
    return { ok: false, reason: "permission" };
  }
  return { ok: true };
}
