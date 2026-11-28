import { desktopShell, type ShellIpc } from "./shell";

/**
 * The mark OpenBot Desktop's setup puts on the address it opens OpenBot at (`show_openbot`, in
 * `desktop/src-tauri/src/main.rs`), once. Setup has faded out to the window's ground by then, and
 * the page fades its first paint up from the same ground, so the switch reads as one dissolve.
 *
 * index.html reads it before the first paint, takes it off the address at once (so a reload or a
 * copied link never fades), and marks the page `data-from-setup` unless motion is reduced. A shell
 * from before it adds no mark, and its page opens as it always did; a page from before it ignores
 * the mark.
 */
export const FROM_SETUP_HASH = "#from-setup";

/** The fade's keyframes, in styles.css. */
export const FROM_SETUP_FADE = "from-setup";

/**
 * Before the app's first render: a page marked as opened by setup outside OpenBot Desktop's window
 * (no shell to have opened it) is not faded. In the window, the mark comes off once the fade has
 * played, so the page's ground is the app's own again.
 */
export function settleFromSetup(
  doc: Document = document,
  shell: ShellIpc | null = desktopShell(),
): void {
  const page = doc.documentElement;
  if (page.dataset.fromSetup === undefined) return;
  const root = doc.getElementById("root");
  if (!shell || !root) {
    delete page.dataset.fromSetup;
    return;
  }
  const done = (event: Event) => {
    if (
      event.target !== root ||
      (event as AnimationEvent).animationName !== FROM_SETUP_FADE
    )
      return;
    delete page.dataset.fromSetup;
    root.removeEventListener("animationend", done);
    root.removeEventListener("animationcancel", done);
  };
  root.addEventListener("animationend", done);
  root.addEventListener("animationcancel", done);
}
