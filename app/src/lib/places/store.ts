import { useState, useSyncExternalStore } from "react";
import { useActiveSkin } from "@/skins/registry";
import {
  DEFAULT_PLACE,
  PLACE_IDS,
  PLACE_ORDER_STORAGE_KEY,
  PLACE_STORAGE_KEY,
  type PlaceId,
  parseStoredOrder,
  parseStoredPlace,
  readPlacesFlag,
} from "./places";

/*
 * The place is remembered per tab (sessionStorage), the order of the strip across visits
 * (localStorage). Reaching either storage can throw in a privacy mode, so every access is guarded
 * and the value then lives for this visit only.
 */
function readSession(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function readLocal(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

let place: PlaceId = parseStoredPlace(readSession(PLACE_STORAGE_KEY));
let order: PlaceId[] = parseStoredOrder(readLocal(PLACE_ORDER_STORAGE_KEY));
const SERVER_ORDER: PlaceId[] = [...PLACE_IDS];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The place drawn right now, for code outside React. */
export function getPlace(): PlaceId {
  return place;
}

export function setPlace(id: PlaceId) {
  if (id === place) return;
  place = id;
  try {
    window.sessionStorage.setItem(PLACE_STORAGE_KEY, id);
  } catch {}
  notify();
}

export function usePlaceId(): PlaceId {
  return useSyncExternalStore(
    subscribe,
    () => place,
    () => DEFAULT_PLACE,
  );
}

export function getPlaceOrder(): PlaceId[] {
  return order;
}

export function setPlaceOrder(next: PlaceId[]) {
  const complete = parseStoredOrder(JSON.stringify(next));
  if (complete.join() === order.join()) return;
  order = complete;
  try {
    window.localStorage.setItem(PLACE_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {}
  notify();
}

export function usePlaceOrder(): PlaceId[] {
  return useSyncExternalStore(
    subscribe,
    () => order,
    () => SERVER_ORDER,
  );
}

const safeLocalStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {}
  },
};

/** The strip is drawn when the switch is on and the active skin keeps OpenBot's own frame. */
export function usePlacesEnabled(): boolean {
  const [flag] = useState(() =>
    readPlacesFlag(window.location.search, safeLocalStorage),
  );
  const skin = useActiveSkin();
  return flag && skin.Frame === undefined;
}
