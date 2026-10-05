import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { type InputMessage, startScreencast } from "../src/screencast";

/**
 * What a person's keystroke turns into on the wire.
 *
 * `screencast.ts` imports Playwright for its types only, and a type import is gone at run time, so
 * this reaches the translation without a browser. What it cannot reach is what Chrome then does with
 * it, which is the half that was wrong: `rawKeyDown` and `keyDown` are both delivered to the page,
 * and only one of them makes Chrome carry out what the key means. That difference was measured
 * against Chromium 151 rather than guessed, and this file pins the parameters that measurement
 * settled on.
 */

/** A CDP session that records what was asked of it, and answers everything. */
function recording() {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    on() {},
    async send(method: string, params: Record<string, unknown> = {}) {
      sent.push({ method, params });
    },
    async detach() {},
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
  } as unknown as Page;
  return { page, sent };
}

/** The parameters of the one key event a message produced. */
async function dispatched(message: InputMessage) {
  const { page, sent } = recording();
  const cast = await startScreencast(page, () => {});
  sent.length = 0;
  await cast.send(message);
  const keyEvents = sent.filter(
    (call) => call.method === "Input.dispatchKeyEvent",
  );
  expect(keyEvents).toHaveLength(1);
  return keyEvents[0]?.params as Record<string, unknown>;
}

/** A keystroke exactly as the live screen sends one: text only for a printable character. */
function typed(
  event: "down" | "up",
  key: string,
  code: string,
  keyCode: number,
): InputMessage {
  return {
    type: "key",
    event,
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    ...(key.length === 1 ? { text: key } : {}),
    modifiers: 0,
  };
}

describe("a key a person presses while they hold the wheel", () => {
  test("Enter is a press the page acts on, not one it merely hears", async () => {
    // Measured through this file against Chromium 151: as a `rawKeyDown` the page's own `keydown`
    // listener saw Enter and nothing else happened -- the sign-in form did not submit, a textarea
    // did not take a new line, and a focused button was not pressed.
    const params = await dispatched(typed("down", "Enter", "Enter", 13));
    expect(params.type).toBe("keyDown");
    expect(params.text).toBe("\r");
  });

  test("a printable character keeps the text the person typed", async () => {
    const params = await dispatched(typed("down", "a", "KeyA", 65));
    expect(params.type).toBe("keyDown");
    expect(params.text).toBe("a");
  });

  test("a key that produces no character is still a rawKeyDown", async () => {
    // Backspace, Delete, Tab, Home, End and the arrows were all measured to do what they mean
    // without text, so filling one in for them would be inventing an insertion.
    for (const [key, code, keyCode] of [
      ["Backspace", "Backspace", 8],
      ["Delete", "Delete", 46],
      ["Tab", "Tab", 9],
      ["ArrowLeft", "ArrowLeft", 37],
      ["Home", "Home", 36],
    ] as const) {
      const params = await dispatched(typed("down", key, code, keyCode));
      expect(params.type).toBe("rawKeyDown");
      expect(params).not.toHaveProperty("text");
    }
  });

  test("Enter going up is a key up carrying nothing it was not given", async () => {
    // The fill-in belongs to the way down, where a default action happens. A key up that carried a
    // carriage return would be a second one.
    const params = await dispatched(typed("up", "Enter", "Enter", 13));
    expect(params.type).toBe("keyUp");
    expect(params).not.toHaveProperty("text");
  });

  test("the virtual key code the surface offered is the one that is sent", async () => {
    // A form field ignores a bare Enter or Backspace without this, which is why it is sent at all.
    const params = await dispatched(typed("down", "Enter", "Enter", 13));
    expect(params.windowsVirtualKeyCode).toBe(13);
    expect(params.nativeVirtualKeyCode).toBe(13);
  });
});
