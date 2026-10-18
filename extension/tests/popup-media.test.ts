import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { microphoneState } from "../src/pages/popup/media";

type Query = (descriptor: { name: string }) => Promise<{ state: string }>;

function stubPermissions(query: Query): void {
  Object.defineProperty(globalThis.navigator, "permissions", {
    value: { query },
    configurable: true,
    writable: true,
  });
}

describe("microphoneState", () => {
  let saved: PropertyDescriptor | undefined;

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(
      globalThis.navigator,
      "permissions",
    );
  });

  afterEach(() => {
    if (saved)
      Object.defineProperty(globalThis.navigator, "permissions", saved);
    else Reflect.deleteProperty(globalThis.navigator, "permissions");
  });

  for (const state of ["granted", "prompt", "denied"] as const) {
    it(`maps ${state}`, async () => {
      const asked: string[] = [];
      stubPermissions(async ({ name }) => {
        asked.push(name);
        return { state };
      });
      expect(await microphoneState()).toBe(state);
      expect(asked).toEqual(["microphone"]);
    });
  }

  it("reports denied when the query throws", async () => {
    stubPermissions(async () => {
      throw new TypeError("unsupported");
    });
    expect(await microphoneState()).toBe("denied");
  });
});
