import { useCallback, useEffect, useRef, useState } from "react";
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
 */
function modifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

type Props = {
  /**
   * Computer identity is part of the stream URL so input and frames stay scoped to the active Bot.
   */
  computerId: string;
  /** Whether the user currently holds the wheel. Input is only sent when true. */
  driving: boolean;
  /** Private capability for this browser tab. Frames are public to authorized viewers; input is not. */
  lease?: string;
  /** Called with a human-readable reason when the stream cannot be established. */
  onProblem?: (problem: string | null) => void;
};

export function LiveScreen({ computerId, driving, lease, onProblem }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** The size of the frames Chrome is sending, which is what input coordinates are relative to. */
  const frameSize = useRef<{ width: number; height: number } | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Same origin, so the scheme follows the page: wss when the app is served over https.
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/api/computers/${encodeURIComponent(computerId)}/stream`,
      driving && lease ? [`openbot-lease.${lease}`] : [],
    );
    socketRef.current = socket;
    let closed = false;

    socket.onopen = () => {
      setConnected(true);
      onProblem?.(null);
    };

    socket.onmessage = async (event) => {
      let message: {
        type: string;
        data?: string;
        width?: number;
        height?: number;
        error?: string;
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "error") {
        onProblem?.(message.error ?? "The screen could not be shown.");
        return;
      }
      if (message.type !== "frame" || !message.data) return;

      const canvas = canvasRef.current;
      if (!canvas || closed) return;

      frameSize.current = {
        width: message.width ?? 1280,
        height: message.height ?? 800,
      };

      /**
       * Decoded off the main thread and drawn as a bitmap.
       *
       * `createImageBitmap` rather than assigning a data URI to an `<img>`: the image path decodes
       * synchronously on the main thread for every frame, which at screencast rates is the difference
       * between a smooth page and one that stutters while you are trying to click something on it.
       */
      try {
        const binary = Uint8Array.from(atob(message.data), (c) =>
          c.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([binary], { type: "image/jpeg" }),
        );
        if (closed) {
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

    socket.onerror = () => onProblem?.("The live screen could not be reached.");
    socket.onclose = () => setConnected(false);

    return () => {
      closed = true;
      socket.close();
      socketRef.current = null;
    };
    // The socket is per Bot; switching Bot must close this stream and open the next one.
  }, [computerId, driving, lease, onProblem]);

  const send = useCallback(
    (message: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (!driving || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message));
    },
    [driving],
  );

  /**
   * Convert from displayed canvas coordinates to page coordinates with the shared, tested helper.
   * A screencast frame is the viewport, so its frame size stands in for natural image size.
   */
  const at = useCallback((event: React.MouseEvent) => {
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
          clickCount: kind === "moved" ? 0 : 1,
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
   */
  useEffect(() => {
    if (!driving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return; // Escape still closes the view.
      event.preventDefault();
      send({
        type: "key",
        event: "down",
        key: event.key,
        code: event.code,
        // Only a printable character carries text. Sending text for Backspace makes Chrome insert a
        // character instead of deleting one.
        ...(event.key.length === 1 ? { text: event.key } : {}),
        modifiers: modifierBits(event),
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      event.preventDefault();
      send({
        type: "key",
        event: "up",
        key: event.key,
        code: event.code,
        modifiers: modifierBits(event),
      });
    };
    /** Paste arrives as one block; CDP inserts it as text rather than key events. */
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text");
      if (!text) return;
      event.preventDefault();
      send({ type: "text", text });
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("paste", onPaste);
    };
  }, [driving, send]);

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
            onWheel: (event: React.WheelEvent<HTMLCanvasElement>) => {
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
            },
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
