// Reload, from the View menu (`desktop_reload.rs`), on OpenBot's own pages: the page is loaded
// again, unless that would lose something the person typed. A field they typed into that still
// holds text keeps the page as it is; once it is sent or cleared, Reload loads the page again.
//
// Injected on every load of OpenBot's pages; the flag keeps it to once per page.
(() => {
  if (window.__openbotReloadPage) return;
  window.__openbotReloadPage = true;

  // The fields a person writes in. Not a checkbox or a radio, whose value is never typed.
  const TEXT_INPUTS = new Set([
    "text",
    "search",
    "email",
    "url",
    "tel",
    "password",
    "number",
  ]);
  const writesText = (field) =>
    field.isContentEditable === true ||
    field instanceof HTMLTextAreaElement ||
    (field instanceof HTMLInputElement && TEXT_INPUTS.has(field.type));

  // Every field typed into since the page loaded.
  const typedInto = new Set();
  document.addEventListener(
    "input",
    (event) => {
      const field = event.target;
      if (field instanceof Element && writesText(field)) typedInto.add(field);
    },
    // Capture: before any handler on the page can stop it.
    true,
  );

  const holdsText = (field) => {
    const text = field.isContentEditable ? field.textContent : field.value;
    return typeof text === "string" && text.trim() !== "";
  };

  // True when the page is loaded again, false when something typed keeps it.
  window.__openbotReload = () => {
    for (const field of typedInto) {
      if (!field.isConnected) {
        typedInto.delete(field);
      } else if (holdsText(field)) {
        console.info("[reload] kept the page: a field holds what was typed");
        return false;
      }
    }
    window.location.reload();
    return true;
  };
})();
