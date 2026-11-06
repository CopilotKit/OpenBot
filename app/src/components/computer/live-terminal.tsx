import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  connectScreen,
  type ScreenSocket,
} from "@/lib/computers/screen-connection";
import { socketUrl } from "@/lib/socket-url";
import { TERMINAL_THEME } from "./terminal-theme";

/**
 * The Bot's live shell, drawn by xterm.js.
 *
 * The computer runs one bash for the Bot (agent-computer/src/live-shell.ts). Its commands are typed
 * into it, so this shows each one typed and its output as it streams; a person holding the wheel types
 * into the same shell. The socket is proxied by the server from `/api/computers/:botId/terminal`.
 *
 * THE PROTOCOL, from this end. Binary frames are terminal bytes, written as they come. Text frames are
 * JSON: `snapshot` resets the terminal before the screen as it is now is redrawn, `ready` says the
 * bytes are live, `error` says what went wrong. This end sends `resize` whenever the fit add-on gives
 * the terminal a new size, `input` with what the person types while they hold the wheel, and `ack` with
 * the bytes it has drawn, which is the flow control xterm.js recommends: the computer stops sending a
 * viewer that falls behind and redraws it from its copy of the screen once it catches up.
 */

/**
 * Show the cursor to someone who is only watching.
 *
 * xterm.js draws no cursor until its terminal has been focused or typed into, so a person watching the
 * Bot work saw a prompt with nothing after it. There is no option for it. Entering the alternate
 * screen and leaving it at once is one of the things that marks the cursor ready in xterm.js's own
 * code, and it changes nothing on screen.
 */
const SHOW_CURSOR = "\x1b[?47h\x1b[?47l";

/** Acknowledged in batches: after this many bytes, or a moment after the last write. */
const ACK_EVERY_BYTES = 32 * 1024;
const ACK_AFTER_MS = 100;

/** Tailwind's monospace stack, which the rest of the app's code is set in. */
function monospace(): string {
  const declared =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono")
          .trim();
  return (
    declared ||
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
  );
}

export type LiveTerminalHandle = { focus: () => void };

/**
 * Give the terminal the keyboard without moving the page. xterm.js focuses a hidden textarea that
 * follows the cursor, and a plain focus scrolled the Computer panel to it, taking the tabs out of view.
 */
function focusTerminal(terminal: Terminal | null) {
  if (!terminal) return;
  if (terminal.textarea) terminal.textarea.focus({ preventScroll: true });
  else terminal.focus();
}

type Props = {
  computerId: string;
  /** Whether the signed-in person holds the wheel. Typing reaches the shell only then. */
  driving: boolean;
  /** Why the terminal cannot be shown, when retrying will not change it, or the retries are spent. */
  onProblem?: (problem: string | null) => void;
  onReconnecting?: (reconnecting: boolean) => void;
  /** Bumped by the parent's Retry, which reconnects. */
  retryKey?: number;
  ref?: Ref<LiveTerminalHandle>;
};

export function LiveTerminal({
  computerId,
  driving,
  onProblem,
  onReconnecting,
  retryKey = 0,
  ref,
}: Props) {
  const host = useRef<HTMLElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const drivingRef = useRef(driving);
  drivingRef.current = driving;
  const problemRef = useRef(onProblem);
  problemRef.current = onProblem;
  const reconnectingRef = useRef(onReconnecting);
  reconnectingRef.current = onReconnecting;
  const [live, setLive] = useState(false);

  useImperativeHandle(ref, () => ({
    focus: () => focusTerminal(terminalRef.current),
  }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reconnects by bumping `retryKey`.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const terminal = new Terminal({
      cursorBlink: drivingRef.current,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      disableStdin: !drivingRef.current,
      fontFamily: monospace(),
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5_000,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminal.write(SHOW_CURSOR);
    terminalRef.current = terminal;

    let socket: WebSocket | null = null;
    const send = (message: Record<string, unknown>) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };

    let sent = { cols: 0, rows: 0 };
    /** Fit the terminal to its box and tell the shell, which takes the size of whoever said last. */
    const refit = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      try {
        fit.fit();
      } catch {
        // A box with no layout yet; the observer calls again once it has one.
      }
      if (terminal.cols === sent.cols && terminal.rows === sent.rows) return;
      sent = { cols: terminal.cols, rows: terminal.rows };
      send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    };
    const observer = new ResizeObserver(() => refit());
    observer.observe(element);

    let drawn = 0;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const acknowledge = () => {
      clearTimeout(ackTimer);
      ackTimer = undefined;
      if (drawn > 0) send({ type: "ack", bytes: drawn });
      drawn = 0;
    };
    const wrote = (bytes: number) => {
      drawn += bytes;
      if (drawn >= ACK_EVERY_BYTES) acknowledge();
      else ackTimer ??= setTimeout(acknowledge, ACK_AFTER_MS);
    };

    // What the person types, and the mouse reports a program in the terminal asks for.
    const typing = terminal.onData((data) => {
      if (drivingRef.current) send({ type: "input", data });
    });
    const binary = terminal.onBinary((data) => {
      if (drivingRef.current) send({ type: "input", data });
    });

    const connection = connectScreen({
      open: () => {
        const opened = new WebSocket(
          socketUrl(
            `/api/computers/${encodeURIComponent(computerId)}/terminal`,
          ),
        );
        opened.binaryType = "arraybuffer";
        socket = opened;
        return {
          set onopen(callback: ScreenSocket["onopen"]) {
            opened.onopen = callback
              ? () => {
                  void callback();
                }
              : null;
          },
          set onclose(callback: ScreenSocket["onclose"]) {
            opened.onclose = callback;
          },
          set onerror(callback: ScreenSocket["onerror"]) {
            opened.onerror = callback;
          },
          set onmessage(callback: ScreenSocket["onmessage"]) {
            opened.onmessage = callback;
          },
          close: () => opened.close(),
        };
      },
      // Watching needs nothing more than the socket; typing is the wheel's question.
      verifyOwnership: async () => true,
      // The size is said once the computer says `ready`, below: by then every hop is open.
      onReady: () => undefined,
      onProblem: (problem) => problemRef.current?.(problem),
      onReconnecting: (reconnecting) => reconnectingRef.current?.(reconnecting),
      onDisconnect: () => setLive(false),
      onMessage: (event) => {
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          terminal.write(bytes, () => wrote(bytes.byteLength));
          return;
        }
        let message: { type?: unknown } | null = null;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        // An error that ends the terminal arrives through `onProblem`. Any other (a keystroke sent
        // as the wheel went back) changes nothing on screen, so it is not drawn over the shell.
        if (message?.type === "snapshot") {
          terminal.reset();
          terminal.write(SHOW_CURSOR);
        } else if (message?.type === "ready") {
          setLive(true);
          // Live from here: say the size again, since the shell may have taken someone else's.
          sent = { cols: 0, rows: 0 };
          refit();
        }
      },
      disconnected: "The terminal is disconnected. Retry to reconnect.",
    });

    return () => {
      connection.stop();
      observer.disconnect();
      typing.dispose();
      binary.dispose();
      clearTimeout(ackTimer);
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [computerId, retryKey]);

  // The wheel changing hands: the keyboard reaches the shell only while it is the person's.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !driving;
    terminal.options.cursorBlink = driving;
    if (driving) focusTerminal(terminal);
  }, [driving]);

  return (
    <section
      aria-label={
        driving
          ? "The Bot's terminal. You have control. Type here."
          : "The Bot's terminal"
      }
      className="h-full w-full"
      data-live={live ? "" : undefined}
      ref={host}
    />
  );
}
