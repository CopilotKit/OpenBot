import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN, SKIN_IDS, type SkinId } from "./types";

/*
 * The skin is saved on the person's account (`skin` in their preferences), so it follows them to
 * every device they sign in from. This store is the browser's copy of it, and the one thing every
 * frame reads.
 *
 * localStorage holds it only as a pre-paint cache. `index.html` reads the same key before the first
 * paint and sets `data-skin`, so a reload never flashes the default while the preferences load. Once
 * they have loaded, `SkinAccountSync` applies the account's skin over whatever the cache held, so
 * the account always wins. Signing out clears the cache, so the next person on a shared machine
 * starts from the default.
 */
export const SKIN_STORAGE_KEY = "openbot-skin";

export { DEFAULT_SKIN };

export function parseStoredSkin(value: string | null | undefined): SkinId {
  return SKIN_IDS.find((id) => id === value) ?? DEFAULT_SKIN;
}

type SkinEffects = {
  setStoredValue: (key: string, value: string) => void;
  removeStoredValue: (key: string) => void;
  setRootSkin: (id: SkinId | null) => void;
};

/** The default skin clears the attribute rather than naming itself, so no skin rule can match it. */
export function applySkin(
  id: SkinId,
  effects: Pick<SkinEffects, "setStoredValue" | "setRootSkin">,
) {
  effects.setStoredValue(SKIN_STORAGE_KEY, id);
  effects.setRootSkin(id === DEFAULT_SKIN ? null : id);
}

/** Forget the cached skin and draw the default, as a browser nobody has signed in to does. */
export function clearCachedSkin(
  effects: Pick<SkinEffects, "removeStoredValue" | "setRootSkin">,
) {
  effects.removeStoredValue(SKIN_STORAGE_KEY);
  effects.setRootSkin(null);
}

const browserEffects: SkinEffects = {
  // localStorage throws in some privacy modes; the skin still applies for this visit.
  setStoredValue: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  },
  removeStoredValue: (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  },
  setRootSkin: (id) => {
    // Importing the registry outside a browser (a test with no DOM) has no document to mark.
    if (typeof document === "undefined") return;
    if (id) {
      document.documentElement.dataset.skin = id;
    } else {
      delete document.documentElement.dataset.skin;
    }
  },
};

/*
 * `index.html` applies whatever the key holds before the first paint, without knowing which skins
 * this build ships. A stored skin that has since been removed would otherwise stay on `<html>` for
 * the rest of the visit while the app draws the default, so the app settles the attribute on load.
 */
export function reconcileSkin(
  stored: string | null,
  effects: Pick<SkinEffects, "setRootSkin">,
): SkinId {
  const id = parseStoredSkin(stored);
  effects.setRootSkin(id === DEFAULT_SKIN ? null : id);
  return id;
}

function readStoredValue() {
  try {
    return window.localStorage.getItem(SKIN_STORAGE_KEY);
  } catch {
    return null;
  }
}

let current: SkinId = reconcileSkin(readStoredValue(), browserEffects);
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

/** The skin drawn right now, for code outside React (a mutation remembering what to go back to). */
export function getSkinId(): SkinId {
  return current;
}

/**
 * Draw `id` and cache it for the next pre-paint. This changes nothing on the account: the picker
 * saves through `saveSkinMutationOptions`, and the account sync calls this with what was saved.
 */
export function setSkin(id: SkinId) {
  const changed = id !== current;
  current = id;
  applySkin(id, browserEffects);
  if (changed) notify();
}

/** Signing out: forget the cached skin and go back to the default. */
export function clearSkin() {
  const changed = current !== DEFAULT_SKIN;
  current = DEFAULT_SKIN;
  clearCachedSkin(browserEffects);
  if (changed) notify();
}

/*
 * Another tab choosing a skin writes the same key, and the browser tells every other tab with a
 * `storage` event. Following it keeps two open tabs from disagreeing about which frame to draw.
 */
function onStorage(event: StorageEvent) {
  if (event.key !== SKIN_STORAGE_KEY) return;
  current = parseStoredSkin(event.newValue);
  browserEffects.setRootSkin(current === DEFAULT_SKIN ? null : current);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function useSkinId() {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_SKIN,
  );
}
