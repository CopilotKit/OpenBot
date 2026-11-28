import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { signOutMutationOptions } from "../src/lib/auth/mutations";
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

  test("remembering and forgetting do not throw when storage refuses writes", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("storage is full");
        },
        removeItem: () => {
          throw new Error("storage is blocked");
        },
      },
    });
    expect(() => rememberSignedIn()).not.toThrow();
    expect(() => forgetSignedIn()).not.toThrow();
  });

  test("sign-out forgets", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => Response.json({ success: true }),
      { preconnect: realFetch.preconnect },
    ) as typeof fetch;
    try {
      rememberSignedIn();
      const { mutationFn } = signOutMutationOptions(new QueryClient());
      // The sign-out takes no variables, so the call is made as the app makes it, with none.
      await (mutationFn as () => Promise<unknown>)();
      expect(wasSignedIn()).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
