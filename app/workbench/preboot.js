/*
 * The app frame's preboot. Workbench only: the workbench Vite config puts this text inline at the
 * top of the app's <head>, so it runs before the app's own inline theme script and before any
 * module. The shipped build never contains it.
 *
 * It is a classic script (no import, no export). It gives the frame a memory storage seeded from
 * the scene, and a matchMedia whose color scheme follows the workbench, not the
 * computer. Outside a workbench frame (no `__workbenchAppFrame` on the parent) it does nothing.
 */
// biome-ignore lint/suspicious/noRedundantUseStrict: a classic script, not a module.
"use strict";

function workbenchPreboot(win) {
  let config;
  try {
    config = win.parent !== win ? win.parent.__workbenchAppFrame : undefined;
  } catch {
    config = undefined;
  }
  if (!config) return;

  class MemoryStorage {
    constructor() {
      this._items = new Map();
    }
    get length() {
      return this._items.size;
    }
    key(index) {
      const keys = Array.from(this._items.keys());
      return index >= 0 && index < keys.length ? keys[index] : null;
    }
    getItem(key) {
      const name = String(key);
      return this._items.has(name) ? this._items.get(name) : null;
    }
    setItem(key, value) {
      this._items.set(String(key), String(value));
    }
    removeItem(key) {
      this._items.delete(String(key));
    }
    clear() {
      this._items.clear();
    }
  }

  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const seed = config.storage || {};
  for (const key of Object.keys(seed)) local.setItem(key, seed[key]);
  Object.defineProperty(win, "localStorage", {
    configurable: true,
    get: () => local,
  });
  Object.defineProperty(win, "sessionStorage", {
    configurable: true,
    get: () => session,
  });

  let theme = config.theme === "dark" ? "dark" : "light";
  const realMatchMedia =
    typeof win.matchMedia === "function" ? win.matchMedia.bind(win) : null;
  const schemeLists = [];

  function makeList(media, matches) {
    const listeners = new Set();
    const list = {
      media,
      get matches() {
        return matches();
      },
      onchange: null,
      addEventListener(type, listener) {
        if (type === "change" && typeof listener === "function") {
          listeners.add(listener);
        }
      },
      removeEventListener(type, listener) {
        if (type === "change") listeners.delete(listener);
      },
      addListener(listener) {
        list.addEventListener("change", listener);
      },
      removeListener(listener) {
        list.removeEventListener("change", listener);
      },
      dispatchEvent(event) {
        if (event?.type !== "change") return true;
        if (typeof list.onchange === "function")
          list.onchange.call(list, event);
        for (const listener of Array.from(listeners))
          listener.call(list, event);
        return true;
      },
    };
    return list;
  }

  win.matchMedia = (query) => {
    const text = String(query);
    const compact = text.replace(/\s+/g, "");
    if (compact.includes("(prefers-color-scheme:dark)")) {
      const list = makeList(text, () => theme === "dark");
      schemeLists.push(list);
      return list;
    }
    if (compact.includes("(prefers-color-scheme:light)")) {
      const list = makeList(text, () => theme === "light");
      schemeLists.push(list);
      return list;
    }
    return realMatchMedia ? realMatchMedia(text) : makeList(text, () => false);
  };

  win.__workbenchPrebootTheme = (next) => {
    theme = next === "dark" ? "dark" : "light";
    for (const list of schemeLists) {
      list.dispatchEvent({
        type: "change",
        matches: list.matches,
        media: list.media,
      });
    }
  };

  win.__workbenchPreboot = true;
}

workbenchPreboot(window);
