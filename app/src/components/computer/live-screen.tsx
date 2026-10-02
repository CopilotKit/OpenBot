import { useCallback, useEffect, useRef, useState } from "react";
import { readControl } from "@/lib/computers/control";
import {
  connectScreen,
  type ScreenSocket,
} from "@/lib/computers/screen-connection";
import { keyOf } from "@/lib/hotkeys/hotkeys";
import { socketUrl } from "@/lib/socket-url";
import { currentPageVisible } from "./preview-visibility";
import { pageCoordinates } from "./take-the-wheel";

/**
 * Low-latency screencast used while a human is driving the Bot's browser.
 *
 * The inline card keeps using cheap polling for passive watching. This view uses Chrome's
 * screencast socket so input and visual feedback stay synchronized during takeover.
 *
 * Follows Chrome DevTools' own `InputModel.ts` (BSD-3) for the event translation and
 * `steel-dev/steel-browser`'s casting handler (Apache-2.0) for the frame loop, because no maintained
 * library publishes this and every real implementation is one app-internal file.
 */

/**
 * CDP's modifier bitmask. Alt 1, Control 2, Meta 4, Shift 8.
 *
 * Needed or a capital letter typed with Shift arrives lower-case, and Ctrl+A selects nothing.
 * Command is sent as Control: the Bot's computer is Linux, where Meta+A selects nothing, and a Mac
 * user's hands reach for Command+A, Command+C and Command+Z.
 */
function modifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey || event.metaKey ? 2 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/** The Command key itself, pressed or released, as the Control key the Linux browser expects. */
function remoteKey(event: KeyboardEvent) {
  return event.key === "Meta"
    ? {
        key: "Control",
        code: event.code === "MetaRight" ? "ControlRight" : "ControlLeft",
        windowsVirtualKeyCode: 17,
      }
    : {
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
      };
}

/**
 * Let the local browser create a paste event, whose clipboard text is forwarded separately.
 *
 * The V is read the way a shortcut is (`keyOf`), so a layout that writes another script still has
 * one: Ctrl and the V key report "м" on Russian and "ω" on Greek.
 */
function isPasteShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && keyOf(event) === "v";
}

/**
 * Whether a keystroke is aimed at a field on this page rather than at the Bot's browser.
 *
 * The canvas cannot hold focus, so a keystroke meant for the remote page arrives targeted at the
 * body (or whatever non-editable element last took a click). One targeted at an input, textarea,
 * select or contenteditable is someone typing into this page while driving: the recorder's
 * workflow name, the secret box under the screen. Taking those keys left the fields dead.
 */
function isLocalField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

type Props = {
  /**
   * Computer identity is part of the stream URL so input and frames stay scoped to the active Bot.
   */
  computerId: string;
  /** Whether the user currently holds the wheel. Input is only sent when true. */
  driving: boolean;
  /** Called with a human-readable reason when the stream cannot be established. */
  onProblem?: (problem: string | null) => void;
  retryKey?: number;
};

type FrameMessage = {
  data: string;
  width: number;
  height: number;
};

export function LiveScreen({
  computerId,
  driving,
  onProblem,
  retryKey = 0,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** Keydowns handled locally whose matching keyup must not leak to the remote browser. */
  const localKeyUps = useRef(new Set<string>());
  /** The size of the frames Chrome is sending, which is what input coordinates are relative to. */
  const frameSize = useRef<{ width: number; height: number } | null>(null);
  /** Latest validated encoded frame. Hidden tabs keep only this, never decoded bitmaps. */
  const latestFrame = useRef<FrameMessage | null>(null);
  /** Monotonic guard so a slow older decode cannot replace a newer frame. */
  const latestFrameId = useRef(0);
  const [connected, setConnected] = useState(false);
  const inputReady = useRef(false);
  const previouslyDriving = useRef(driving);

  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit Retry restarts this connection.
  useEffect(() => {
    let closed = false;
    setConnected(false);
    inputReady.current = false;
    frameSize.current = null;
    latestFrame.current = null;
    latestFrameId.current++;

    const drawFrame = async (frame: FrameMessage, frameId: number) => {
      /**
       * Decoded off the main thread and drawn as a bitmap.
       *
       * `createImageBitmap` rather than assigning a data URI to an `<img>`: the image path decodes
       * synchronously on the main thread for every frame, which at screencast rates is the difference
       * between a smooth page and one that stutters while you are trying to click something on it.
       */
      try {
        const binary = Uint8Array.from(atob(frame.data), (c) =>
          c.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([binary], { type: "image/jpeg" }),
        );
        if (
          closed ||
          frameId !== latestFrameId.current ||
          !currentPageVisible()
        ) {
          bitmap.close();
          return;
        }
        const canvas = canvasRef.current;
        if (!canvas) {
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        // Ignore a single corrupt frame; the next frame replaces it.
      }
    };

    const drawLatestFrame = () => {
      if (!currentPageVisible()) return;
      const frame = latestFrame.current;
      if (!frame) return;
      void drawFrame(frame, latestFrameId.current);
    };

    const onMessage = (event: { data: unknown }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      // A frame that is not an object (`null`, a number, a string, an array) has
      // no `type` to read: reaching for it throws a `TypeError` inside this
      // handler and stops the live view from drawing further frames. Drop it.
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return;
      }
      const message = parsed as {
        type: string;
        data?: string;
        width?: number;
        height?: number;
        error?: string;
      };
      if (typeof message.type !== "string") return;
      if (message.type === "error") {
        onProblem?.(message.error ?? "The screen could not be shown.");
        return;
      }
      if (message.type !== "frame" || !message.data) return;
      // Live-run JSON only checks `typeof type === "string"` upstream. Non-finite or negative
      // dimensions would poison frameSize and every coordinate scaled from it; a huge payload
      // would hit `atob` before any bound. Both are dropped as corrupt frames.
      const width = message.width ?? 1280;
      const height = message.height ?? 800;
      if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0 ||
        width > 8192 ||
        height > 8192
      ) {
        return;
      }
      if (
        typeof message.data !== "string" ||
        message.data.length > 20_000_000
      ) {
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas || closed) return;

      frameSize.current = {
        width: message.width ?? 1280,
        height: message.height ?? 800,
      };
      const frame = { data: message.data, width, height };
      latestFrame.current = frame;
      const frameId = ++latestFrameId.current;

      if (!currentPageVisible()) return;
      void drawFrame(frame, frameId);
    };

    const connection = connectScreen({
      open: () => {
        const socket = new WebSocket(
          socketUrl(`/api/computers/${encodeURIComponent(computerId)}/stream`),
        );
        socketRef.current = socket;
        // Event handlers use only data, so adapt the native event surface without changing the protocol.
        return {
          set onopen(callback: ScreenSocket["onopen"]) {
            socket.onopen = callback
              ? () => {
                  void callback();
                }
              : null;
          },
          set onclose(callback: ScreenSocket["onclose"]) {
            socket.onclose = callback;
          },
          set onerror(callback: ScreenSocket["onerror"]) {
            socket.onerror = callback;
          },
          set onmessage(callback: ScreenSocket["onmessage"]) {
            socket.onmessage = callback;
          },
          close: () => socket.close(),
        };
      },
      verifyOwnership: async () => {
        const state = await readControl(computerId);
        return state?.holder === "human" && !state.transitioning;
      },
      onReady: (ready) => {
        inputReady.current = ready;
        setConnected(ready);
      },
      onProblem: (problem) => onProblem?.(problem),
      onDisconnect: () => {
        frameSize.current = null;
        latestFrame.current = null;
        latestFrameId.current++;
        const canvas = canvasRef.current;
        if (canvas)
          canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      },
      onMessage,
    });
    document.addEventListener("visibilitychange", drawLatestFrame);
    return () => {
      closed = true;
      connection.stop();
      document.removeEventListener("visibilitychange", drawLatestFrame);
      socketRef.current = null;
    };
  }, [computerId, onProblem, retryKey]);

  useEffect(() => {
    const wasDriving = previouslyDriving.current;
    previouslyDriving.current = driving;
    if (
      wasDriving ||
      !driving ||
      inputReady.current ||
      socketRef.current?.readyState !== WebSocket.OPEN
    )
      return;
    let live = true;
    void readControl(computerId)
      .then((state) => {
        if (!live || socketRef.current?.readyState !== WebSocket.OPEN) return;
        inputReady.current = state?.holder === "human" && !state.transitioning;
        setConnected(inputReady.current);
      })
      .catch(() => {
        inputReady.current = false;
      });
    return () => {
      live = false;
    };
  }, [computerId, driving]);

  const send = useCallback(
    (message: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (
        !driving ||
        !inputReady.current ||
        socket?.readyState !== WebSocket.OPEN
      )
        return;
      socket.send(JSON.stringify(message));
    },
    [driving],
  );

  /**
   * Convert from displayed canvas coordinates to page coordinates with the shared, tested helper.
   * A screencast frame is the viewport, so its frame size stands in for natural image size.
   */
  const at = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const size = frameSize.current;
    if (!canvas || !size) return null;
    return pageCoordinates(
      { naturalWidth: size.width, naturalHeight: size.height },
      canvas.getBoundingClientRect(),
      event,
    );
  }, []);

  const onMouse = useCallback(
    (kind: "pressed" | "released" | "moved") =>
      (event: React.MouseEvent<HTMLCanvasElement>) => {
        const point = at(event);
        if (!point) return;
        send({
          type: "mouse",
          event: kind,
          ...point,
          button:
            event.button === 2
              ? "right"
              : event.button === 1
                ? "middle"
                : "left",
          /*
           * The browser's own count, not a fixed one.
           *
           * `MouseEvent.detail` is how many times in a row this button has been pressed in the same
           * place, worked out by the browser to its own timing and distance rules. Chrome fires
           * `dblclick` on the far page only when the second press says it is the second, so sending 1
           * every time meant a double click arrived as two separate clicks: no `dblclick` ever
           * reached the page, `event.detail` was always 1, and opening a row, expanding a node and
           * selecting a word were all things a person holding the wheel could not do.
           *
           * At least one on a press, because the computer refuses a press of zero for the reason its
           * own comment gives -- Chrome would see a move that happens to have a button set, and no
           * click at all. `detail` is zero on an event a script dispatched rather than a person.
           */
          clickCount: kind === "moved" ? 0 : Math.max(1, event.detail),
          modifiers: modifierBits(event),
        });
      },
    [at, send],
  );

  /**
   * Keystrokes, forwarded while driving.
   *
   * Listen on window because canvas cannot hold focus. `preventDefault` keeps Tab and typing directed
   * at the remote page while takeover is active.
   *
   * The keydown in the capture phase, and stopped as well as prevented, because a keystroke sent to
   * the Bot's browser is not also this page's. The app's own shortcuts listen on this window too,
   * and they were bound first, when the signed-in app mounted, so they saw every keystroke before
   * this did: a capital N typed into the remote page started a new chat, and Ctrl+B there toggled
   * the sidebar here. Escape and the paste shortcut are not stopped, because both are meant for this
   * page, and neither is a keystroke typed into one of this page's own fields.
   */
  useEffect(() => {
    if (!driving || !connected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return; // Escape still closes the view.
      if (isPasteShortcut(event) || isLocalField(event.target)) {
        localKeyUps.current.add(event.code);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      send({
        type: "key",
        event: "down",
        ...remoteKey(event),
        // Only a printable character carries text. Sending text for Backspace makes Chrome insert a
        // character instead of deleting one.
        ...(event.key.length === 1 ? { text: event.key } : {}),
        modifiers: modifierBits(event),
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      if (localKeyUps.current.delete(event.code) || isPasteShortcut(event)) {
        return;
      }
      event.preventDefault();
      send({
        type: "key",
        event: "up",
        ...remoteKey(event),
        modifiers: modifierBits(event),
      });
    };
    /** Paste arrives as one block; CDP inserts it as text rather than key events. */
    const onPaste = (event: ClipboardEvent) => {
      if (isLocalField(event.target)) return;
      const text = event.clipboardData?.getData("text");
      if (!text) return;
      event.preventDefault();
      send({ type: "text", text });
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
      localKeyUps.current.clear();
    };
  }, [driving, connected, send]);

  /**
   * The wheel, forwarded while driving, from a listener that is allowed to stop it here.
   *
   * Not React's `onWheel`: React attaches that to its root as a passive listener, so the
   * `preventDefault` in it was ignored ("Unable to preventDefault inside passive event listener
   * invocation."). The wheel reached the Bot's page and also scrolled whatever on this page was
   * under it, the frame that holds this screen included, and Ctrl and the wheel zoomed this page.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!driving || !connected || !canvas) return;
    const onWheel = (event: WheelEvent) => {
      const point = at(event);
      if (!point) return;
      event.preventDefault();
      send({
        type: "wheel",
        ...point,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifierBits(event),
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [driving, connected, at, send]);

  return (
    <canvas
      ref={canvasRef}
      className={`block h-auto w-full ${driving ? "cursor-crosshair" : ""}`}
      // Only forward input during takeover.
      {...(driving
        ? {
            onMouseDown: onMouse("pressed"),
            onMouseUp: onMouse("released"),
            onMouseMove: onMouse("moved"),
            onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
          }
        : {})}
      aria-label={
        driving
          ? "The assistant's screen. You have control: click and type here."
          : "The assistant's screen, live"
      }
      data-connected={connected}
    />
  );
}
