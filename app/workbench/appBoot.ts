// Runs after the real app entry. Timers and animations use browser time.
const root = document.getElementById("root");
if (!root || root.childElementCount > 0) globalThis.__workbenchBooted = true;
else {
  const observer = new MutationObserver(() => {
    if (root.childElementCount > 0) {
      observer.disconnect();
      globalThis.__workbenchBooted = true;
    }
  });
  observer.observe(root, { childList: true });
}
