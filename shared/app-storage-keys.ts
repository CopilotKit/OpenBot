/**
 * The browser keys the app reads before its first paint. Here rather than in the app so that the
 * workbench, which seeds a frame's storage before the app loads, uses the same keys and never a
 * copy of them.
 */

/** The skin, as a pre-paint cache of the account's choice (app/src/skins/store.ts). */
export const SKIN_STORAGE_KEY = "openbot-skin";

/** Whether the sidebar is open: `expanded` or `collapsed` (app/src/lib/sidebar.ts). */
export const SIDEBAR_STORAGE_KEY = "openbot-sidebar";
