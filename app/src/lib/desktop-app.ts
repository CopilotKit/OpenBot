/**
 * Whether this page is open in OpenBot Desktop's own window, not in a browser.
 *
 * Desktop is a Tauri app, and Tauri marks every page its window loads with `isTauri`, the flag
 * `@tauri-apps/api`'s `isTauri()` reads. Read on each call, so a test can set it.
 */
export function inDesktopApp(): boolean {
  return (globalThis as { isTauri?: unknown }).isTauri === true;
}
