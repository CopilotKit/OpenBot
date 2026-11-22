/*
 * The last module of the app frame, after the app's own entry (/src/main.tsx). It tells the page
 * that the frame booted only when the app drew its first element into #root.
 *
 * frameBoot.ts runs before the app's module graph has loaded. If the page took that as the boot, it
 * walked the clock and reported ready while #root was still empty, and the app then loaded on a
 * clock that the walk had already moved (and, for a seek, paused): timers that the app started on
 * that clock did not run.
 */

function booted(): void {
  globalThis.__workbenchBooted = true;
}

function waitForApp(): void {
  const root = document.getElementById("root");
  // No root, or the app's entry failed: tell the page now, so it shows the errors.
  if (
    root === null ||
    root.childElementCount > 0 ||
    (window.__workbenchErrors?.length ?? 0) > 0
  ) {
    booted();
    return;
  }
  // React commits the first render after main.tsx returns. MutationObserver runs on real time,
  // not on the page clock.
  const done = () => {
    observer.disconnect();
    window.removeEventListener("error", done);
    booted();
  };
  const observer = new MutationObserver(() => {
    if (root.childElementCount > 0) done();
  });
  observer.observe(root, { childList: true });
  window.addEventListener("error", done);
}

waitForApp();
