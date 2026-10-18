import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireTabStreamId } from "../src/background/tab-capture";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
let variant: string | undefined;

beforeEach(() => {
  fake = installChromeFake();
  variant = process.env.RECORDER_VARIANT;
});

afterEach(() => {
  if (variant === undefined) delete process.env.RECORDER_VARIANT;
  else process.env.RECORDER_VARIANT = variant;
  fake.uninstall();
});

describe("acquireTabStreamId", () => {
  test("returns the stream id for the target tab, with no consumer tab", async () => {
    delete process.env.RECORDER_VARIANT;
    fake.tabCapture.answer = "stream-42";
    expect(await acquireTabStreamId(7)).toBe("stream-42");
    expect(fake.tabCapture.calls).toEqual([{ targetTabId: 7 }]);
  });

  test("returns null when Chrome refuses", async () => {
    delete process.env.RECORDER_VARIANT;
    fake.tabCapture.answer = new Error("Extension has not been invoked");
    expect(await acquireTabStreamId(7)).toBeNull();
  });

  test("returns the synthetic id only in the e2e variant, without asking Chrome", async () => {
    process.env.RECORDER_VARIANT = "e2e";
    expect(await acquireTabStreamId(7)).toBe("RECORDER_E2E_SYNTHETIC");
    expect(fake.tabCapture.calls).toEqual([]);
  });
});
