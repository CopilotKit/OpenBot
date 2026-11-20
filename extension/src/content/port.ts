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

const MAX_HELLO_URL = 4096;

/** The hello, with the address clipped to the protocol's cap so a long URL (a SAML redirect) still parses. */
export function contentHello(): ContentToBackground {
  return {
    type: "content.hello",
    top: window === window.top,
    url: location.href.slice(0, MAX_HELLO_URL),
  };
}

/**
 * The content script's line to the service worker. When the worker restarts the port disconnects: reconnect after
 * 0.5, 1, 2 and 4 s (then every 4 s) and keep what was posted meanwhile, in order. Digests, hellos and notice choices
 * are always kept (a lost digest would let a typed secret through later network bodies); only `content.event`s count
 * towards `maxBuffer`, and beyond it the oldest is dropped and counted. A port can die before Chrome reports it: a post
 * or a flush that throws keeps what it could not send and reconnects. Once the extension is updated or removed the
 * script is orphaned (`chrome.runtime.id` is gone): the line closes for good and tells `onOrphaned` listeners, instead
 * of retrying every 4 s for as long as the page stays open.
 */
export function createContentPort(
  options: {
    connect?: () => chrome.runtime.Port;
    timers?: Timers;
    maxBuffer?: number;
    /** True once this script's extension has gone away. */
    orphaned?: () => boolean;
  } = {},
): {
  post(message: ContentToBackground): void;
  onMessage(listener: (message: BackgroundToContent) => void): void;
  /** Called once the line has closed for good because the extension went away; at once when it already has. */
  onOrphaned(listener: () => void): void;
  dispose(): void;
} {
  const connect =
    options.connect ?? (() => chrome.runtime.connect({ name: PORT_CONTENT }));
  const timers = options.timers ?? defaultTimers;
  const maxBuffer = options.maxBuffer ?? MAX_EVENT_BUFFER;
  const orphaned =
    options.orphaned ??
    (() => !(globalThis as { chrome?: typeof chrome }).chrome?.runtime?.id);

  const listeners: ((message: BackgroundToContent) => void)[] = [];
  const orphanListeners: (() => void)[] = [];
  let port: chrome.runtime.Port | null = null;
  let queue: ContentToBackground[] = [];
  let queuedEvents = 0;
  let dropped = 0;
  let attempt = 0;
  let timer: unknown = null;
  let disposed = false;
  let isOrphaned = false;

  /** False when the port died before Chrome said so: postMessage throws on a disconnected port. */
  const deliver = (
    target: chrome.runtime.Port,
    message: ContentToBackground,
  ): boolean => {
    try {
      target.postMessage(message);
      return true;
    } catch {
      return false;
    }
  };

  const dispose = () => {
    disposed = true;
    if (timer !== null) timers.clear(timer);
    timer = null;
    const current = port;
    port = null;
    try {
      current?.disconnect();
    } catch {
      /* Already gone with the extension context. */
    }
  };

  const orphan = () => {
    if (isOrphaned) return;
    isOrphaned = true;
    dispose();
    queue = [];
    queuedEvents = 0;
    for (const listener of orphanListeners) listener();
  };

  const scheduleReconnect = () => {
    if (disposed || timer !== null) return;
    if (orphaned()) {
      orphan();
      return;
    }
    const delay =
      RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    timer = timers.set(() => {
      timer = null;
      open(true);
    }, delay);
  };

  /** The live port is gone (a disconnect, or a post that threw): reconnect. A second report about the same port, or one
   * about a port already replaced, changes nothing. */
  const lose = (target: chrome.runtime.Port) => {
    if (port !== target) return;
    port = null;
    scheduleReconnect();
  };

  const enqueue = (message: ContentToBackground) => {
    queue.push(message);
    if (message.type !== "content.event") return;
    queuedEvents += 1;
    if (queuedEvents > maxBuffer) {
      const oldest = queue.findIndex((m) => m.type === "content.event");
      queue.splice(oldest, 1);
      queuedEvents -= 1;
      dropped += 1;
    }
  };

  /** Sends the hello, any drop count and the queue, in order; false when the port died part way, with what it did not
   * send still queued. */
  const flush = (target: chrome.runtime.Port): boolean => {
    if (!deliver(target, contentHello())) return false;
    if (dropped > 0) {
      const report: ContentToBackground = {
        type: "content.event",
        event: {
          type: "CUSTOM",
          name: "recorder.dropped",
          timestamp: Date.now(),
          value: { count: dropped, reason: "content-port" },
        },
      };
      if (!deliver(target, report)) return false;
      dropped = 0;
    }
    let sent = 0;
    for (const message of queue) {
      if (!deliver(target, message)) break;
      sent += 1;
    }
    for (const message of queue.splice(0, sent))
      if (message.type === "content.event") queuedEvents -= 1;
    return queue.length === 0;
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
    next.onDisconnect.addListener(() => lose(next));
    if (reconnecting && !flush(next)) lose(next);
  };

  open(false);

  return {
    post(message) {
      if (disposed) return;
      if (port) {
        if (deliver(port, message)) return;
        lose(port);
      }
      enqueue(message);
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    onOrphaned(listener) {
      if (isOrphaned) listener();
      else orphanListeners.push(listener);
    },
    dispose,
  };
}
