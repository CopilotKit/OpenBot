import { useSyncExternalStore } from "react";
import { SKIN_IDS, type SkinId } from "./types";

/*
 * The skin is a per-browser preference, like the dark theme: it lives in localStorage and nowhere
 * else, so choosing one changes nothing on the server or for anybody else. `index.html` reads the
 * same key before the first paint and sets `data-skin`, so a reload never flashes the default.
 */
export const SKIN_STORAGE_KEY = "openbot-skin";

export const DEFAULT_SKIN: SkinId = "openbot";

export function parseStoredSkin(value: string | null): SkinId {
  return SKIN_IDS.find((id) => id === value) ?? DEFAULT_SKIN;
}

type SkinEffects = {
  setStoredValue: (key: string, value: string) => void;
  setRootSkin: (id: SkinId | null) => void;
};

/** The default skin clears the attribute rather than naming itself, so no skin rule can match it. */
export function applySkin(id: SkinId, effects: SkinEffects) {
  effects.setStoredValue(SKIN_STORAGE_KEY, id);
  effects.setRootSkin(id === DEFAULT_SKIN ? null : id);
}

const browserEffects: SkinEffects = {
  setStoredValue: (key, value) => {
    // localStorage throws in some privacy modes; the skin still applies for this visit.
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  },
  setRootSkin: (id) => {
    if (id) {
      document.documentElement.dataset.skin = id;
    } else {
      delete document.documentElement.dataset.skin;
    }
  },
};

function readStoredSkin() {
  try {
    return parseStoredSkin(window.localStorage.getItem(SKIN_STORAGE_KEY));
  } catch {
    return DEFAULT_SKIN;
  }
}

let current: SkinId = readStoredSkin();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

export function setSkin(id: SkinId) {
  current = id;
  applySkin(id, browserEffects);
  notify();
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
