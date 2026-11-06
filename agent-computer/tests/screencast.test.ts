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
  });

  test("no key names a native key code, so none reaches the browser's own shortcuts", async () => {
    // With one, Chrome passes a key the page did not take on to the browser, and on macOS reads the code as the Mac's
    // own key number: ArrowLeft's 37 is the Mac's L, Home's 36 its Return. A person's ArrowLeft reached the page as an
    // unnamed key, opened chrome://settings/help and left the browser spinning (screencast.ts says how it was measured,
    // and screencast-keys-browser.test.ts drives it against Chromium itself).
    for (const [key, code, keyCode] of [
      ["ArrowLeft", "ArrowLeft", 37],
      ["Home", "Home", 36],
      ["Enter", "Enter", 13],
      ["a", "KeyA", 65],
    ] as const) {
      for (const event of ["down", "up"] as const) {
        const params = await dispatched(typed(event, key, code, keyCode));
        expect(params).not.toHaveProperty("nativeVirtualKeyCode");
      }
    }
  });
});

describe("frame pacing", () => {
  /** A CDP session that lets the test fire a screencast frame and see when it was acked. */
  function casting() {
    const acks: number[] = [];
    let onFrame: ((event: unknown) => void) | undefined;
    const client = {
      on(event: string, handler: (event: unknown) => void) {
        if (event === "Page.screencastFrame") onFrame = handler;
      },
      async send(method: string, params: Record<string, unknown> = {}) {
        if (method === "Page.screencastFrameAck")
          acks.push(params.sessionId as number);
      },
      async detach() {},
    };
    const page = {
      context: () => ({ newCDPSession: async () => client }),
    } as unknown as Page;
    const frame = (sessionId: number) =>
      onFrame?.({
        data: "",
        sessionId,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      });
    return { page, acks, frame };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("a frame the viewer has taken is acked straight away", async () => {
    const { page, acks, frame } = casting();
    const sent: string[] = [];
    await startScreencast(page, (taken) => {
      sent.push(JSON.stringify(taken));
    });
    frame(1);
    await tick();
    expect(acks).toEqual([1]);
    // The server's proxy tells a frame from an error by this prefix, to hold back only frames when behind.
    expect(sent[0]?.startsWith('{"type":"frame"')).toBe(true);
  });

  test("a frame is acked as it arrives, however long the viewer takes over it", async () => {
    // Held until the viewer had it, Chrome dropped what the page did meanwhile and never sent it:
    // see screencast-pacing-browser.test.ts, which measures that against Chromium itself.
    const { page, acks, frame } = casting();
    await startScreencast(page, () => new Promise<void>(() => {}));
    frame(7);
    frame(8);
    await tick();
    expect(acks).toEqual([7, 8]);
  });
});
