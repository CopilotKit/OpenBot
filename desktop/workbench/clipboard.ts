/**
 * Puts text on the clipboard.
 *
 * `navigator.clipboard` exists only in a secure context. http://localhost is one, but the workbench
 * opened by its network address (http://<LAN address>:3021, to share it in the office) is not, so
 * there the page copies through a hidden text area and `document.execCommand("copy")`, which works
 * in any context during a click.
 *
 * Throws when the browser lets neither way copy.
 */
export async function copyText(
  text: string,
  doc: Document = document,
): Promise<void> {
  const view = doc.defaultView;
  // Browsers leave `navigator.clipboard` out of an insecure page, so its presence is the test.
  const clipboard = view?.navigator.clipboard;
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Refused (no permission, page not focused): try the text area below.
    }
  }
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Out of sight and out of the layout, so the copy does not move or scroll anything.
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  doc.body.appendChild(area);
  const focused = doc.activeElement as HTMLElement | null;
  try {
    // A text area copies its own selection only while it has focus.
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    if (!doc.execCommand("copy")) {
      throw new Error("The browser did not let the page copy.");
    }
  } finally {
    area.remove();
    focused?.focus?.();
  }
}
