/** Whether the Recorder may read websites (<all_urls>). The manifest requires it, so the install grants it; it is false
 * only when the person has since set the Recorder's Site access to On click or On specific sites. */
export async function hasHostPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ["<all_urls>"] });
}
