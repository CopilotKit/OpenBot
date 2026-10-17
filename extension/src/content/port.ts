import type {
  BackgroundToContent,
  ContentToBackground,
} from "../protocol/messages";
import { PORT_CONTENT } from "../protocol/messages";

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000];
const MAX_EVENT_BUFFER = 200;

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The content script's line to the service worker. When the worker restarts the port disconnects: reconnect after
 * 0.5, 1, 2 and 4 s (then every 4 s) and keep what was posted meanwhile, in order. Steps, digests, hellos and notice
 * choices are always kept (a lost digest would let a typed secret through later network bodies, a lost step is a hole
 * in the Skill); only `content.event`s count towards `maxBuffer`, and beyond it the oldest is dropped and counted.
 */
export function createContentPort(
  options: {
    connect?: () => chrome.runtime.Port;
    timers?: Timers;
    maxBuffer?: number;
  } = {},
): {
  post(message: ContentToBackground): void;
  onMessage(listener: (message: BackgroundToContent) => void): void;
  dispose(): void;
} {
  const connect =
    options.connect ?? (() => chrome.runtime.connect({ name: PORT_CONTENT }));
  const timers = options.timers ?? defaultTimers;
  const maxBuffer = options.maxBuffer ?? MAX_EVENT_BUFFER;

  const listeners: ((message: BackgroundToContent) => void)[] = [];
  let port: chrome.runtime.Port | null = null;
  let queue: ContentToBackground[] = [];
  let queuedEvents = 0;
  let dropped = 0;
  let attempt = 0;
  let timer: unknown = null;
  let disposed = false;

  const hello = (): ContentToBackground => ({
    type: "content.hello",
    top: window === window.top,
    url: location.href,
  });

  const scheduleReconnect = () => {
    if (disposed || timer !== null) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    timer = timers.set(() => {
      timer = null;
      open(true);
    }, delay);
  };

  const flush = (target: chrome.runtime.Port) => {
    target.postMessage(hello());
    if (dropped > 0) {
      target.postMessage({
        type: "content.event",
        event: {
          type: "CUSTOM",
          name: "recorder.dropped",
          timestamp: Date.now(),
          value: { count: dropped, reason: "content-port" },
        },
      } satisfies ContentToBackground);
      dropped = 0;
    }
    const pending = queue;
    queue = [];
    queuedEvents = 0;
    for (const message of pending) target.postMessage(message);
  };

  const open = (reconnecting: boolean) => {
    let next: chrome.runtime.Port;
    try {
      next = connect();
    } catch {
      scheduleReconnect();
      return;
    }
    port = next;
    next.onMessage.addListener((message: BackgroundToContent) => {
      attempt = 0;
      for (const listener of listeners) listener(message);
    });
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
      scheduleReconnect();
    });
    if (reconnecting) flush(next);
  };

  open(false);

  return {
    post(message) {
      if (port) {
        port.postMessage(message);
        return;
      }
      queue.push(message);
      if (message.type !== "content.event") return;
      queuedEvents += 1;
      if (queuedEvents > maxBuffer) {
        const oldest = queue.findIndex((m) => m.type === "content.event");
        queue.splice(oldest, 1);
        queuedEvents -= 1;
        dropped += 1;
      }
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    dispose() {
      disposed = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
      const current = port;
      port = null;
      current?.disconnect();
    },
  };
}
