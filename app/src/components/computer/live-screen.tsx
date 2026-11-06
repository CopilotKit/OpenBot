import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { readControl } from "@/lib/computers/control";
import {
  connectScreen,
  FRAME_PREFIX,
  FRAME_RECEIVED,
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
 * A frame's JPEG bytes from its base64.
 *
 * The browser's own decoder where it has one. Otherwise a plain loop: `Uint8Array.from(string, fn)`
 * called a function for every byte, a hundred thousand calls a frame on the thread handling the
 * person's clicks.
 */
function jpegBytes(base64: string): Uint8Array<ArrayBuffer> {
  const native = (
    Uint8Array as unknown as {
      fromBase64?: (data: string) => Uint8Array<ArrayBuffer>;
    }
  ).fromBase64;
  if (native) return native(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** How long a refused input is said on the screen. */
const INPUT_PROBLEM_MS = 4_000;

/** How far one line of a wheel reported in lines scrolls. */
const LINE_PIXELS = 40;

/** Keys that change other keys rather than typing. */
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift", "AltGraph"]);

/** Whether a key's name is the one character it types: "a", "é", "😀"; not "Enter" or "ArrowLeft". */
function isCharacter(key: string): boolean {
  return [...key].length === 1;
}

/** What a page can ask of its live screen: to take the keyboard, as a click on the screen does. */
export type LiveScreenHandle = { focus: () => void };

type Props = {
  /**
   * Computer identity is part of the stream URL so input and frames stay scoped to the active Bot.
   */
  computerId: string;
  /** Whether the user currently holds the wheel. Input is only sent when true. */
  driving: boolean;
  /** Called with a human-readable reason when the stream cannot be established. */
  onProblem?: (problem: string | null) => void;
  /** Called while a dropped stream is being retried on its own, and again when it is back or gone. */
  onReconnecting?: (reconnecting: boolean) => void;
  retryKey?: number;
  /** What a screen reader calls the screen while driving. A Bot's screen unless this says whose it is. */
  label?: string;
  /**
   * Take the keyboard as soon as there is input to take, without a click: for a view opened to drive the screen, where
   * the screen is what the person came to type into (the full-size view of a Bot's screen).
   */
  autoFocus?: boolean;
  ref?: Ref<LiveScreenHandle>;
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
  onReconnecting,
  retryKey = 0,
  label = "The Bot's screen. You have control. Click and type here.",
  autoFocus = false,
  ref,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** Keys sent down to the remote browser, by code, whose release goes there too, wherever the focus is by then. */
  const keysDown = useRef(new Map<string, ReturnType<typeof remoteKey>>());
  /**
   * Every key still down in the remote browser, released there: when the keyboard stops being forwarded (control handed
   * back, the screen closed, its stream ended) with a key held, its release would never be sent, and a Shift or a Control
   * left down there changes every key and click after it. Straight to the socket, as the person's own release would
   * have gone; with modifiers none, since every one is being let go.
   */
  const releaseKeys = useCallback(() => {
    const socket = socketRef.current;
    for (const key of keysDown.current.values())
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ type: "key", event: "up", ...key, modifiers: 0 }),
        );
    keysDown.current.clear();
  }, []);

  /** The size of the frames Chrome is sending, which is what input coordinates are relative to. */
  const frameSize = useRef<{ width: number; height: number } | null>(null);
  /** Latest validated encoded frame. Hidden tabs keep only this, never decoded bitmaps. */
  const latestFrame = useRef<FrameMessage | null>(null);
  /** Monotonic guard so a slow older decode cannot replace a newer frame. */
  const latestFrameId = useRef(0);
  const [connected, setConnected] = useState(false);
  /**
   * The last input that was refused or did not land, said for a few seconds in a corner of the screen.
   *
   * It used to come back as the same error that ends the stream, so one key typed a moment before the
   * wheel was handed over put the Retry panel over the whole screen and reconnected it.
   */
  const [inputProblem, setInputProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!inputProblem) return;
    const timer = setTimeout(() => setInputProblem(null), INPUT_PROBLEM_MS);
    return () => clearTimeout(timer);
  }, [inputProblem]);
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
        const bitmap = await createImageBitmap(
          new Blob([jpegBytes(frame.data)], { type: "image/jpeg" }),
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
        // Assigning a size reallocates the canvas and clears it, even the same size, so only on a change.
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        // Ignore a single corrupt frame; the next frame replaces it.
      }
    };

    /*
     * One frame decoding at a time, and only the newest waiting behind it.
     *
     * Every frame used to start its own decode the moment it arrived, and a decode that finished after
     * a newer one was thrown away, so while the page moved the browser decoded frames nobody would see.
     */
    let decoding = false;
    let waiting: { frame: FrameMessage; frameId: number } | null = null;
    const show = async (frame: FrameMessage, frameId: number) => {
      waiting = { frame, frameId };
      if (decoding) return;
      decoding = true;
      try {
        while (waiting && !closed) {
          const next: { frame: FrameMessage; frameId: number } = waiting;
          waiting = null;
          await drawFrame(next.frame, next.frameId);
        }
      } finally {
        decoding = false;
      }
    };

    /** The newest frame that arrived while the tab was hidden, not even parsed. See `onMessage`. */
    let hiddenFrame: string | null = null;
    /**
     * Whether the computer has said it wants to hear as each frame arrives. It then keeps no more than
     * a couple on their way, so on a slow link the screen shows the page as it is, not seconds ago.
     * Only once it has said so: a computer from before this would refuse a message it does not know.
     */
    let confirmFrames = false;
    const confirmFrame = () => {
      const socket = socketRef.current;
      if (confirmFrames && socket?.readyState === WebSocket.OPEN)
        socket.send(FRAME_RECEIVED);
    };

    const drawLatestFrame = () => {
      if (!currentPageVisible()) return;
      if (hiddenFrame !== null) {
        const raw = hiddenFrame;
        hiddenFrame = null;
        // Already confirmed when it arrived.
        onMessage({ data: raw }, { replay: true });
        return;
      }
      const frame = latestFrame.current;
      if (!frame) return;
      void show(frame, latestFrameId.current);
    };

    const onMessage = (
      event: { data: unknown },
      { replay = false }: { replay?: boolean } = {},
    ) => {
      const isFrame =
        typeof event.data === "string" && event.data.startsWith(FRAME_PREFIX);
      // On arrival, before any decoding: what the computer is pacing itself by is the link.
      if (isFrame && !replay) confirmFrame();
      // A hidden tab keeps only the newest frame, as it arrived. Parsing every frame nobody can see
      // was the main cost of a live screen in a background tab.
      if (isFrame && !currentPageVisible()) {
        hiddenFrame = event.data as string;
        return;
      }
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
      if (message.type === "hello") {
        confirmFrames =
          (message as { confirmFrames?: unknown }).confirmFrames === true;
        return;
      }
      if (message.type === "error") {
        onProblem?.(message.error ?? "Couldn't show the screen.");
        return;
      }
      // One input that did not land. The screen is still live, so it is said, not put over the screen.
      if (message.type === "input-error") {
        setInputProblem(message.error ?? "That input didn't reach the page.");
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
      void show(frame, frameId);
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
      onReconnecting: (reconnecting) => onReconnecting?.(reconnecting),
      onDisconnect: () => {
        // A new connection says again whether it wants confirmations.
        confirmFrames = false;
        frameSize.current = null;
        latestFrame.current = null;
        hiddenFrame = null;
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
      // Before the socket goes: a key still down over there would stay held in the remote browser.
      releaseKeys();
      connection.stop();
      document.removeEventListener("visibilitychange", drawLatestFrame);
      socketRef.current = null;
    };
  }, [computerId, onProblem, onReconnecting, retryKey]);

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

  /**
   * A move or a scroll not sent yet, held until the next animation frame.
   *
   * A mouse reports a move 60 to 144 times a second and a trackpad scrolls faster than that, and every
   * one was its own message, each a trip into the remote browser that the computer applies in turn.
   * The queue over there grew for as long as the hand moved, and a click landed behind it. One move per
   * frame is all the screen can show anyway, and scrolls held in the same frame add up to one.
   */
  const heldInput = useRef<Record<string, unknown> | null>(null);
  const heldFrame = useRef<number | null>(null);

  const sendNow = useCallback(
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

  /** Send the held move or scroll now, so whatever comes next lands after it. */
  const flushHeld = useCallback(() => {
    if (heldFrame.current !== null) cancelAnimationFrame(heldFrame.current);
    heldFrame.current = null;
    const held = heldInput.current;
    heldInput.current = null;
    if (held) sendNow(held);
  }, [sendNow]);

  /** A press, a release, a key or a paste: never held, never merged, and always after the move before it. */
  const send = useCallback(
    (message: Record<string, unknown>) => {
      flushHeld();
      sendNow(message);
    },
    [flushHeld, sendNow],
  );

  /** A move or a scroll: held to the next frame and merged with any of the same kind held already. */
  const sendSoon = useCallback(
    (message: Record<string, unknown>) => {
      const held = heldInput.current;
      if (
        held &&
        held.type === message.type &&
        held.modifiers === message.modifiers
      ) {
        heldInput.current =
          message.type === "wheel"
            ? {
                ...message,
                deltaX: Number(held.deltaX) + Number(message.deltaX),
                deltaY: Number(held.deltaY) + Number(message.deltaY),
              }
            : message;
      } else {
        flushHeld();
        heldInput.current = message;
      }
      heldFrame.current ??= requestAnimationFrame(() => {
        heldFrame.current = null;
        flushHeld();
      });
    },
    [flushHeld],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: handing back control drops a held move too.
  useEffect(
    () => () => {
      if (heldFrame.current !== null) cancelAnimationFrame(heldFrame.current);
      heldFrame.current = null;
      heldInput.current = null;
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

  /** Whether a button went down on the screen and has not come up yet, wherever the pointer is now. */
  const pressedOnScreen = useRef(false);

  /**
   * One mouse event as the computer takes it.
   *
   * `button` is the one this event is about, and `buttons` every one held, as the page reads them in
   * `MouseEvent.button` and `MouseEvent.buttons`. A move with nothing held is `none`: it used to say
   * "left", so to the page every hover was a drag with the left button down.
   */
  const mouseMessage = useCallback(
    (
      kind: "pressed" | "released" | "moved",
      event: MouseEvent | React.MouseEvent,
      point: { x: number; y: number },
    ) => ({
      type: "mouse",
      event: kind,
      ...point,
      button:
        kind === "moved"
          ? event.buttons & 1
            ? "left"
            : event.buttons & 2
              ? "right"
              : event.buttons & 4
                ? "middle"
                : "none"
          : event.button === 2
            ? "right"
            : event.button === 1
              ? "middle"
              : "left",
      buttons: event.buttons,
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
    }),
    [],
  );

  const onMouse = useCallback(
    (kind: "pressed" | "released" | "moved") =>
      (event: React.MouseEvent<HTMLCanvasElement>) => {
        // A press on the screen gives it the keyboard, as a press on any focusable element does, so typing into the
        // remote page after clicking a field on it needs no second click.
        if (kind === "pressed")
          event.currentTarget.focus({ preventScroll: true });
        const point = at(event);
        if (!point) return;
        if (kind === "pressed") pressedOnScreen.current = true;
        if (kind === "released" && event.buttons === 0)
          pressedOnScreen.current = false;
        (kind === "moved" ? sendSoon : send)(mouseMessage(kind, event, point));
      },
    [at, send, sendSoon, mouseMessage],
  );

  /*
   * A drag that leaves the screen is still a drag.
   *
   * A button pressed on the screen and let go outside it never sent its release, so the Bot's browser
   * went on believing it was held: the next move there dragged a selection or a slider nobody was
   * holding. While a button is down, moves and the release are followed on the whole window, at the
   * nearest point on the edge of the screen, the way a browser follows a drag past its own window.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!driving || !connected || !canvas) return;
    const edge = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return at({
        clientX: Math.min(
          Math.max(event.clientX, rect.left),
          rect.left + rect.width - 1,
        ),
        clientY: Math.min(
          Math.max(event.clientY, rect.top),
          rect.top + rect.height - 1,
        ),
      });
    };
    const onMove = (event: MouseEvent) => {
      if (!pressedOnScreen.current || event.target === canvas) return;
      const point = edge(event);
      if (point) sendSoon(mouseMessage("moved", event, point));
    };
    const onUp = (event: MouseEvent) => {
      if (!pressedOnScreen.current || event.target === canvas) return;
      if (event.buttons === 0) pressedOnScreen.current = false;
      const point = edge(event);
      if (point) send(mouseMessage("released", event, point));
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      pressedOnScreen.current = false;
    };
  }, [driving, connected, at, send, sendSoon, mouseMessage]);

  useImperativeHandle(
    ref,
    () => ({ focus: () => canvasRef.current?.focus({ preventScroll: true }) }),
    [],
  );

  /*
   * A view opened to drive the screen puts the keyboard on it, as a dialog puts focus inside itself: taking control
   * and typing needs no click on the page first, as it needed none before the screen took keys only with focus.
   */
  useEffect(() => {
    if (autoFocus && driving && connected)
      canvasRef.current?.focus({ preventScroll: true });
  }, [autoFocus, driving, connected]);

  /**
   * Keystrokes, forwarded while driving, and only those the screen itself has: it takes the keyboard the way any focused
   * element does, by a click on it (or Tab to it), and gives it back on Escape or a click anywhere else.
   *
   * It used to take every keystroke on the window that was not aimed at a text field, because the canvas could not hold
   * focus. So nothing else on the page could have a key: the Browser page's tabs never heard their arrows, Home, End or
   * Delete, no button took Enter or Space, and Tab never left anything. And every one of those keys went to the remote
   * browser instead, where a stray arrow is not harmless. Now the canvas holds focus, as noVNC's does (its keyboard
   * listens on the canvas it focuses on a click), and a key aimed anywhere else is that element's.
   *
   * Still listened for on the window, in the capture phase, and stopped as well as prevented, because a keystroke sent to
   * the Bot's browser is not also this page's: the app's own shortcuts listen on this window too, and they were bound
   * first, when the signed-in app mounted, so they would see it first (a capital N typed into the remote page started a
   * new chat, and Ctrl+B there toggled the sidebar here). The paste shortcut is not stopped, because the paste event it
   * makes is how the clipboard's text arrives. Nor is Escape, which closes a full-size view; on its way it also takes the
   * keyboard off the screen, which is how a person who reached it with Tab leaves it again (WCAG's "no keyboard trap").
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!driving || !connected || !canvas) return;
    const held = keysDown.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== canvas) return;
      if (event.key === "Escape") {
        canvas.blur();
        return;
      }
      if (isPasteShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      // The first half of an accent typed in two keys. The browser reports the accented character on
      // the second key, which is the one that goes; this one has nothing to send.
      if (event.key === "Dead") return;
      held.set(event.code, remoteKey(event));
      send({
        type: "key",
        event: "down",
        ...remoteKey(event),
        // Only a printable character carries text. Sending text for Backspace makes Chrome insert a
        // character instead of deleting one. Counted in characters, not UTF-16 units, so an emoji is
        // text too.
        ...(isCharacter(event.key) ? { text: event.key } : {}),
        modifiers: modifierBits(event),
      });
    };
    /**
     * The release of a key that went down to the remote browser, wherever the focus is now: a key released after a
     * click took the focus elsewhere is still held over there otherwise. Only those: the Tab that brought the focus to
     * the screen, say, was this page's, and its release is too.
     */
    const onKeyUp = (event: KeyboardEvent) => {
      if (!held.delete(event.code)) return;
      event.preventDefault();
      send({
        type: "key",
        event: "up",
        ...remoteKey(event),
        modifiers: modifierBits(event),
      });
      /*
       * On a Mac a key let go while Command is down never reports its release: Command+A sends A down
       * and no A up. Sent as Control+A, the A stayed held in the Bot's browser and every key after it
       * repeated or combined with it. Command coming up lets go of whatever it was held with.
       */
      if (event.key === "Meta")
        for (const [code, key] of held)
          if (!MODIFIER_KEYS.has(key.key)) {
            held.delete(code);
            send({ type: "key", event: "up", ...key, modifiers: 0 });
          }
    };
    /** Paste arrives as one block; CDP inserts it as text rather than key events. */
    const onPaste = (event: ClipboardEvent) => {
      if (event.target !== canvas) return;
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
      releaseKeys();
    };
  }, [driving, connected, send, releaseKeys]);

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
      /*
       * In pixels, which is what the computer scrolls by. Firefox reports a mouse wheel in lines, three
       * a notch, so it scrolled the Bot's page three pixels at a time. A line is taken as 40 pixels, as
       * Chrome scrolls one, and a page as the height of the screen.
       */
      const unit =
        event.deltaMode === 1
          ? LINE_PIXELS
          : event.deltaMode === 2
            ? (frameSize.current?.height ?? 800)
            : 1;
      sendSoon({
        type: "wheel",
        ...point,
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
        modifiers: modifierBits(event),
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [driving, connected, at, sendSoon]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className={`block h-auto w-full ${driving ? "cursor-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" : ""}`}
        // Only forward input during takeover. Then the screen is a stop in the Tab order and takes every key while it has
        // the focus, which is what a screen reader is told by `application`.
        {...(driving
          ? {
              onMouseDown: onMouse("pressed"),
              onMouseUp: onMouse("released"),
              onMouseMove: onMouse("moved"),
              onContextMenu: (event: React.MouseEvent) =>
                event.preventDefault(),
              role: "application",
              tabIndex: 0,
            }
          : {})}
        aria-label={driving ? label : "The Bot's screen, live"}
        data-connected={connected}
      />
      {inputProblem ? (
        <span
          role="status"
          className="absolute bottom-2 left-2 max-w-[80%] rounded-full bg-black/70 px-2.5 py-1 font-medium text-white text-xs backdrop-blur-sm"
        >
          {inputProblem}
        </span>
      ) : null}
    </>
  );
}
