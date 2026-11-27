import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  forgetSignedIn,
  rememberSignedIn,
  wasSignedIn,
} from "../src/lib/auth/was-signed-in";

/**
 * Only somebody signed in last time gets the app frame while the sign-in checks run, so what is
 * kept in this browser must read as "never signed in" whenever it cannot be trusted.
 */

const kept = new Map<string, string>();
const realStorage = globalThis.localStorage;

function useStorage(getItem: (key: string) => string | null) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    },
  });
}

beforeEach(() => {
  kept.clear();
  useStorage((key) => kept.get(key) ?? null);
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: realStorage,
  });
});

describe("whether somebody was signed in last time", () => {
  test("is true once remembered", () => {
    rememberSignedIn();
    expect(wasSignedIn()).toBe(true);
  });

  test("is false once forgotten", () => {
    rememberSignedIn();
    forgetSignedIn();
    expect(wasSignedIn()).toBe(false);
  });

  test("is false when nothing is stored", () => {
    expect(wasSignedIn()).toBe(false);
  });

  test("is false, without throwing, when storage cannot be read", () => {
    useStorage(() => {
      throw new Error("storage is blocked");
    });
    expect(wasSignedIn()).toBe(false);
  });
});
