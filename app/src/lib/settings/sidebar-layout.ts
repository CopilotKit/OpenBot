import { useSyncExternalStore } from "react";

const key = "openbot-sidebar-inverted";
const change = "openbot-sidebar-layout-change";

function subscribe(notify: () => void) {
  window.addEventListener(change, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(change, notify);
    window.removeEventListener("storage", notify);
  };
}

export function useSidebarInverted() {
  return useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(key) === "true",
    () => false,
  );
}

export function setSidebarInverted(inverted: boolean) {
  window.localStorage.setItem(key, String(inverted));
  window.dispatchEvent(new Event(change));
}
