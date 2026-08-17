/**
 * Live screen and live input over one WebSocket, using Chrome's own screencast.
 *
 * Chrome pushes frames as the page changes, which supports human takeover better than polling a PNG
 * once a second.
 *
 * This follows permissively-licensed references: `steel-dev/steel-browser`'s `casting.handler.ts`
 * (Apache-2.0) for the server loop and Chrome DevTools' `InputModel.ts` (BSD-3) for key event
 * translation.
 *
 * noVNC is not used because it requires Xvfb, x11vnc and websockify, while this container runs
 * headless. This implementation streams the page and forwards input through the Chrome DevTools
 * Protocol.
 */
import type { CDPSession, Page } from "playwright";

/** What the surface sends us. */
export type InputMessage =
  | {
      type: "mouse";
      event: "pressed" | "released" | "moved";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      type: "key";
      event: "down" | "up";
      key: string;
      code: string;
      text?: string;
      modifiers?: number;
    }
  | { type: "text"; text: string };

/** What we send back. */
export type FrameMessage = {
  type: "frame";
  /** Base64 JPEG. Chrome's own encoding; we do not re-encode. */
  data: string;
  width: number;
  height: number;
};

/**
 * Chrome's virtual key codes, for the keys that need one.
 *
 * `Input.dispatchKeyEvent` is not satisfied by `key` alone. A form field will ignore a bare Backspace
 * or Enter unless `windowsVirtualKeyCode` is set, which is the common reason a hand-written
 * screencast works for letters but not editing keys. Lifted from the mapping DevTools uses for the
 * same purpose.
 */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

function virtualKeyCode(key: string): number {
  if (VIRTUAL_KEY_CODES[key] !== undefined) return VIRTUAL_KEY_CODES[key];
  // A single printable character carries its own code point, upper-cased, which is what Chrome expects
  // for a key event as opposed to the text it produces.
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

export type Screencast = {
  /** Stop the cast and detach. Safe to call twice. */
  stop: () => Promise<void>;
  /** Apply one thing the person did. */
  send: (message: InputMessage) => Promise<void>;
};

/**
 * Start casting `page` to `onFrame`, and return a handle that accepts input.
 *
 * `maxWidth`/`maxHeight` cap what Chrome encodes; it scales to fit and tells us the real dimensions in
 * the metadata, which the surface needs in order to map a click back. Capping matters because the cost
 * of a frame is mostly encoding, and oversized casts waste bandwidth.
 */
export async function startScreencast(
  page: Page,
  onFrame: (frame: FrameMessage) => void,
  options: { maxWidth?: number; maxHeight?: number; quality?: number } = {},
): Promise<Screencast> {
  const client: CDPSession = await page.context().newCDPSession(page);
  let stopped = false;

  type ScreencastFrame = {
    data: string;
    sessionId: number;
    metadata: { deviceWidth: number; deviceHeight: number };
  };

  client.on("Page.screencastFrame", (event: ScreencastFrame) => {
    const { data, sessionId, metadata } = event;
    // Acknowledge every frame. Chrome will not send the next one until the current is acked, which is
    // the backpressure that stops a slow client drowning in frames. Forgetting this is why a naive
    // implementation delivers one frame and then appears to hang.
    void client
      .send("Page.screencastFrameAck", { sessionId })
      .catch(() => undefined);
    if (stopped) return;
    onFrame({
      type: "frame",
      data,
      width: metadata.deviceWidth,
      height: metadata.deviceHeight,
    });
  });

  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: options.quality ?? 70,
    maxWidth: options.maxWidth ?? 1280,
    maxHeight: options.maxHeight ?? 800,
    // One frame per change, not per interval. Chrome decides when something moved.
    everyNthFrame: 1,
  });

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await client.send("Page.stopScreencast").catch(() => undefined);
      await client.detach().catch(() => undefined);
    },

    async send(message: InputMessage) {
      if (stopped) return;
      if (message.type === "mouse") {
        await client.send("Input.dispatchMouseEvent", {
          type:
            message.event === "pressed"
              ? "mousePressed"
              : message.event === "released"
                ? "mouseReleased"
                : "mouseMoved",
          x: message.x,
          y: message.y,
          button: message.button ?? "left",
          // Chrome needs a non-zero clickCount on press/release or the page sees a move that happens
          // to have a button set, and no click ever fires.
          clickCount: message.event === "moved" ? 0 : (message.clickCount ?? 1),
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      if (message.type === "wheel") {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: message.x,
          y: message.y,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      if (message.type === "key") {
        const code = virtualKeyCode(message.key);
        await client.send("Input.dispatchKeyEvent", {
          // `keyDown` only when there is text to insert; otherwise `rawKeyDown`, which is what Chrome
          // expects for keys that do not produce a character. Sending keyDown with no text makes
          // editing keys arrive as nothing.
          type:
            message.event === "up"
              ? "keyUp"
              : message.text
                ? "keyDown"
                : "rawKeyDown",
          key: message.key,
          code: message.code,
          ...(message.text ? { text: message.text } : {}),
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      // A block of text at once: a paste, or a one-time code the person did not type character by
      // character. `Input.insertText` bypasses key events entirely, which is correct here, it is not
      // pretending to be a keyboard.
      await client.send("Input.insertText", { text: message.text });
    },
  };
}
