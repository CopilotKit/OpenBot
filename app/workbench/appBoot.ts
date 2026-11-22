/*
 * The last module of the app frame, after the app's own entry (/src/main.tsx). It tells the page
 * that the frame booted only when the app drew its first element into #root.
 *
 * frameBoot.ts runs before the app's module graph has loaded. If the page took that as the boot, it
 * walked the clock and reported ready while #root was still empty, and the app then loaded on a
 * clock that the walk had already moved (and, for a seek, paused): timers that the app started on
 * that clock did not run.
 *
 * The app can also wait on the page clock before it draws: a delayed answer, a retry, or a router
 * pending timer. The clock stays paused until the frame boots, so the frame also boots when #root
 * is still empty and the app has been quiet for QUIET_MS of real time: no `/api` request, no native
 * call and no loaded file. The page then moves the clock.
 */

/** Real milliseconds without activity after which an empty #root means the app waits on the clock. */
const QUIET_MS = 1500;

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
  // The page clock replaced setTimeout and clearTimeout, and it is paused: the quiet timer runs on
  // the real setTimeout, and a newer timer makes the older ones do nothing.
  const realSetTimeout = globalThis.__workbenchRealSetTimeout ?? setTimeout;
  let waiting = true;
  let quietTimer = 0;
  const offs: (() => void)[] = [];
  const done = () => {
    if (!waiting) return;
    waiting = false;
    for (const off of offs) off();
    booted();
  };
  const active = () => {
    if (!waiting) return;
    const timer = ++quietTimer;
    realSetTimeout(() => {
      if (timer === quietTimer) done();
    }, QUIET_MS);
  };

  // React commits the first render after main.tsx returns. MutationObserver runs on real time,
  // not on the page clock.
  const observer = new MutationObserver(() => {
    if (root.childElementCount > 0) done();
  });
  observer.observe(root, { childList: true });
  offs.push(() => observer.disconnect());
  window.addEventListener("error", done);
  offs.push(() => window.removeEventListener("error", done));

  // Activity: requests, native calls, and files the app still loads (route chunks, styles).
  const offApi = window.__workbenchApi?.onChange(active);
  if (offApi) offs.push(offApi);
  const offNative = globalThis.__workbench?.onChange(active);
  if (offNative) offs.push(offNative);
  if (typeof PerformanceObserver === "function") {
    const files = new PerformanceObserver(active);
    files.observe({ type: "resource" });
    offs.push(() => files.disconnect());
  }
  active();
}

waitForApp();
