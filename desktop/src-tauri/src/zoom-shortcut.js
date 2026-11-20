// A browser's zoom keys in OpenBot's window: Ctrl (Command on a Mac) with + or = zooms the page in,
// with - zooms it out, and with 0 puts it back to its actual size. The shell zooms every window and
// keeps the level for the next launch (`zoom.rs`).
//
// Windows: all of them, here. The window has no menu bar, and WebView2's own zoom keys are off, so
// the page listens, as it does for Ctrl+Q (`quit-shortcut.js`).
//
// macOS (`__openbotZoomMenu`): the View menu answers Command with =, - and 0, and only those.
// MEASURED: Command-Shift-= (Command and +, as the menu's neighbours in every Mac app call it) and
// the number pad's + never reached the menu's Command-= item, so the page answers those. Never one
// the menu answers too: that would zoom twice.
//
// Injected on every load; the flag keeps it to once per page.
(() => {
  if (window.__openbotZoomShortcut) return;
  window.__openbotZoomShortcut = true;
  const menu = window.__openbotZoomMenu === true;

  const STEPS = {
    "=": "in",
    "+": "in",
    "-": "out",
    _: "out",
    0: "reset",
  };
  // The key the keyboard writes, and the physical key where the layout writes something else there
  // (Ctrl and the 0 key write "à" on a French layout), as a browser reads its zoom keys.
  const PHYSICAL = {
    Equal: "in",
    NumpadAdd: "in",
    Minus: "out",
    NumpadSubtract: "out",
    Digit0: "reset",
    Numpad0: "reset",
  };
  const stepOf = (event) => {
    const written = String(event.key ?? "");
    if (menu) {
      return written === "+" || (written === "=" && event.shiftKey)
        ? "in"
        : null;
    }
    if (Object.hasOwn(STEPS, written)) return STEPS[written];
    if (written.length !== 1 || written.charCodeAt(0) < 0x80) return null;
    return PHYSICAL[event.code ?? ""] ?? null;
  };

  window.addEventListener(
    "keydown",
    (event) => {
      // Shift allowed: Ctrl and + is Ctrl+Shift+= on most keyboards. Not with Alt: Windows reports
      // AltGr as Ctrl+Alt, and AltGr writes characters.
      const held = menu
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (!held || event.altKey) return;
      const step = stepOf(event);
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      const internals = window.__TAURI_INTERNALS__;
      if (typeof internals?.invoke !== "function") return;
      // Held down, the key repeats, and each repeat is one more step, as in a browser.
      internals
        .invoke("plugin:openbot-desktop|zoom", { step })
        .catch((error) => {
          console.error("[zoom] could not zoom the window:", error);
        });
    },
    // Capture, on the window: before any handler on the page can stop it.
    true,
  );
})();
