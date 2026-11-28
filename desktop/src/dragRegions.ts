/**
 * The setup window's drag handles.
 *
 * On macOS the setup window's title bar is an overlay, as OpenBot's own page has it
 * (`match_title_bar` in src-tauri/src/main.rs): the sidebar and the inset page run to the window's
 * top edge, the window's buttons sit over the sidebar, and nothing of the system's is left to take
 * hold of. So the page names its own handles, as OpenBot's page does (`OVERLAY_TITLE_BAR_PAGE`):
 *
 * - the window's ground: `main`'s own box, which is the strip above the inset page and the ground
 *   around a step's card. Bare, so a press on the page or anything on it never moves the window.
 * - the sidebar's empty room (`.rail`, bare): its top, under the window's buttons, and the gaps
 *   between what it holds.
 * - OpenBot's name at the sidebar's top (`.rail > .lockup`, from anywhere inside it) and "Set up
 *   OpenBot" (`.rail-title`): words, not controls.
 *
 * Tauri's own script reads the attribute (`data-tauri-drag-region`): bare drags from the element
 * itself, "deep" from anything inside it but a button, link, field or label. The sections, the
 * choices and every button and link stay as they are. A double-click asks to zoom, which the window
 * refuses while setup shows (`window_size.rs`). The setup window's capability lets the page drag it
 * (src-tauri/capabilities/default.json).
 *
 * Every screen of the main window, whichever `main` it draws, and as screens change, so a new
 * screen has its handles without asking. macOS only: Windows keeps its own title bar to drag.
 */

const DRAG = "data-tauri-drag-region";

/** Each handle, and how much of it drags: "" the element itself, "deep" anything in it. */
export const DRAG_HANDLES: ReadonlyArray<readonly [string, "" | "deep"]> = [
  ["main", ""],
  [".rail", ""],
  [".rail > .lockup", "deep"],
  [".rail-title", ""],
];

/** Whether the window's title bar is the overlay that needs the page's handles: macOS. */
export function overlayTitleBar(userAgent = navigator.userAgent): boolean {
  return /Macintosh|Mac OS X/.test(userAgent);
}

/** Mark every handle under `root` that is not marked yet. */
export function markDragRegions(root: ParentNode): void {
  for (const [selector, value] of DRAG_HANDLES) {
    for (const handle of root.querySelectorAll(`${selector}:not([${DRAG}])`)) {
      handle.setAttribute(DRAG, value);
    }
  }
}

/**
 * Mark the handles now and as screens change, on macOS. Returns what stops watching.
 */
export function watchDragRegions(
  page: Document = document,
  userAgent = navigator.userAgent,
): () => void {
  if (!overlayTitleBar(userAgent)) return () => {};
  const observer = new MutationObserver(() => markDragRegions(page));
  observer.observe(page.documentElement, { childList: true, subtree: true });
  markDragRegions(page);
  return () => observer.disconnect();
}
