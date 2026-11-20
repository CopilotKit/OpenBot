// Ctrl+Q in OpenBot's window on Windows quits OpenBot, as the tray's Quit does.
//
// The tray menu shows "Quit  Ctrl+Q", but on Windows that is only a label: Tauri answers a menu's
// shortcuts only for a menu bar on the window, and this window has none (`install_menus`).
// macOS answers Command-Q and Linux Ctrl+Q through the window's own menu. Here the page listens, so
// the shortcut belongs to this window and is never taken from another application, as a global
// shortcut would be. Injected on every load on Windows; the flag keeps it to once per page.
(() => {
  if (window.__openbotQuitShortcut) return;
  window.__openbotQuitShortcut = true;

  // The key the keyboard writes, or the physical key where the layout writes another script
  // (Ctrl and the Q key write "й" on a Russian layout), as the app's own shortcuts read it.
  const keyOf = (event) => {
    const written = String(event.key ?? "").toLowerCase();
    if (written.length !== 1 || written.charCodeAt(0) < 0x80) return written;
    const physical = /^Key([A-Z])$/.exec(event.code ?? "");
    return physical ? physical[1].toLowerCase() : written;
  };

  window.addEventListener(
    "keydown",
    (event) => {
      // Exactly Ctrl+Q. Not with Alt: Windows reports AltGr as Ctrl+Alt, and AltGr+Q types "@" on
      // a German keyboard.
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey)
        return;
      if (keyOf(event) !== "q") return;
      event.preventDefault();
      event.stopPropagation();
      // Held down, the key repeats; one quit is the one that was asked for.
      if (event.repeat) return;
      const internals = window.__TAURI_INTERNALS__;
      if (typeof internals?.invoke !== "function") return;
      internals.invoke("plugin:openbot-desktop|quit").catch((error) => {
        console.error("[quit] Ctrl+Q could not quit OpenBot:", error);
      });
    },
    // Capture, on the window: before any handler on the page can stop it.
    true,
  );
})();
