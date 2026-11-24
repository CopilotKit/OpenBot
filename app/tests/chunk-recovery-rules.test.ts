import { expect, test } from "bun:test";
import {
  isChunkLoadError,
  RELOAD_GUARD_MS,
  RELOADED_FROM_BUILD,
  reloadOnceFrom,
} from "@/lib/chunk-recovery";

/**
 * The rules behind loading a part of the app again (`lib/chunk-recovery.ts`), on the words each
 * engine really uses. chunk-recovery.test.tsx drives the whole of it in Chromium and WebKit.
 */

test("an import whose file didn't load is told apart, in every engine's words", () => {
  for (const message of [
    // WebKit, as OpenBot Desktop's Mac window showed it.
    "Importing a module script failed.",
    "Failed to fetch dynamically imported module: https://my.open.bot/assets/highlighted-body-KPVGNVTW-BDSyA_lw.js",
    "error loading dynamically imported module: https://my.open.bot/assets/route-admin-C3LzwrTH.js",
    "Unable to preload CSS for /assets/index-Bda7K_Is.css",
  ])
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  for (const error of [
    new TypeError("Cannot read properties of undefined (reading 'title')"),
    new TypeError("Load failed"),
    "Importing a module script failed.",
    null,
  ])
    expect(isChunkLoadError(error)).toBe(false);
});

function storage(): Map<string, string> & Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return Object.assign(map, {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  });
}

test("a page loads again once per build it was on, so a stale page never loops", () => {
  const session = storage();
  let reloads = 0;
  const reload = () => {
    reloads += 1;
  };
  const one = "https://my.open.bot/assets/index-AAAA.js";
  const two = "https://my.open.bot/assets/index-BBBB.js";

  expect(reloadOnceFrom(one, session, reload, 0)).toBe(true);
  expect(JSON.parse(session.get(RELOADED_FROM_BUILD) ?? "")).toEqual({
    build: one,
    at: 0,
  });
  // Back on the same build after loading again, and failing again: it stays.
  expect(reloadOnceFrom(one, session, reload, 5_000)).toBe(false);
  // On the new build, a later release is loaded too.
  expect(reloadOnceFrom(two, session, reload, 6_000)).toBe(true);
  expect(reloads).toBe(2);
  // A failure on the same build much later is a new one, and is tried again once.
  expect(reloadOnceFrom(two, session, reload, 6_000 + RELOAD_GUARD_MS)).toBe(
    true,
  );
  expect(reloads).toBe(3);
  // With no session storage there is no way to know, so it never loads again by itself.
  expect(reloadOnceFrom(one, null, reload)).toBe(false);
  expect(reloads).toBe(3);
});
