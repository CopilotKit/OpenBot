/*
 * The fake WebSocket of the app frame. A socket opens on the next microtask, logs what the page
 * sends, and gets messages only from the control (a run step or the Stream and sockets panel). By
 * default the sockets stay open and quiet.
 */
import type {
  SocketControl,
  SocketRecord,
} from "../../desktop/workbench/appContract";

export type SocketWindow = {
  EventTarget: typeof EventTarget;
  Event: typeof Event;
  MessageEvent: typeof MessageEvent;
  CloseEvent?: typeof CloseEvent;
  WebSocket?: unknown;
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

type Handler = ((event: Event) => unknown) | null;

/** Sets `win.WebSocket` to the fake class and gives its control. */
export function installFakeSockets(win: SocketWindow): SocketControl {
  const all: FakeWebSocket[] = [];
  const listeners = new Set<() => void>();
  let nextId = 1;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const closeEvent = (code: number, reason: string): Event => {
    if (win.CloseEvent) {
      return new win.CloseEvent("close", { code, reason, wasClean: true });
    }
    const event = new win.Event("close");
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
      wasClean: { value: true },
    });
    return event;
  };

  class FakeWebSocket extends win.EventTarget {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;
    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = CLOSING;
    readonly CLOSED = CLOSED;

    readonly url: string;
    readonly protocol: string;
    readyState: number = CONNECTING;
    binaryType: BinaryType = "blob";
    readonly bufferedAmount = 0;
    readonly extensions = "";
    // Accessors on the prototype, not own fields: a browser's EventTarget never calls `on*`
    // itself, but happy-dom calls an own `on*` field, so an own field would run twice in tests.
    #handlers: Record<"open" | "message" | "error" | "close", Handler> = {
      open: null,
      message: null,
      error: null,
      close: null,
    };
    get onopen(): Handler {
      return this.#handlers.open;
    }
    set onopen(handler: Handler) {
      this.#handlers.open = handler;
    }
    get onmessage(): Handler {
      return this.#handlers.message;
    }
    set onmessage(handler: Handler) {
      this.#handlers.message = handler;
    }
    get onerror(): Handler {
      return this.#handlers.error;
    }
    set onerror(handler: Handler) {
      this.#handlers.error = handler;
    }
    get onclose(): Handler {
      return this.#handlers.close;
    }
    set onclose(handler: Handler) {
      this.#handlers.close = handler;
    }
    readonly record: SocketRecord;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = String(url);
      this.protocol =
        typeof protocols === "string" ? protocols : (protocols?.[0] ?? "");
      this.record = {
        id: nextId++,
        url: this.url,
        state: "connecting",
        sent: [],
        received: 0,
      };
      all.push(this);
      notify();
      // Open on the next microtask, after the caller attaches its handlers.
      queueMicrotask(() => {
        if (this.readyState !== CONNECTING) return;
        this.readyState = OPEN;
        this.record.state = "open";
        this.fire(new win.Event("open"), this.onopen);
        notify();
      });
    }

    fire(event: Event, handler: Handler): void {
      this.dispatchEvent(event);
      handler?.call(this, event);
    }

    send(data: unknown): void {
      if (this.readyState === CONNECTING) {
        throw new DOMException(
          "Still in CONNECTING state.",
          "InvalidStateError",
        );
      }
      if (this.readyState !== OPEN) return;
      this.record.sent.push(typeof data === "string" ? data : String(data));
      notify();
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      this.readyState = CLOSING;
      queueMicrotask(() => {
        this.readyState = CLOSED;
        this.record.state = "closed";
        this.fire(closeEvent(code, reason), this.onclose);
        notify();
      });
    }

    receive(data: string): void {
      this.record.received += 1;
      this.fire(new win.MessageEvent("message", { data }), this.onmessage);
    }
  }

  win.WebSocket = FakeWebSocket;

  return {
    sockets: () =>
      all.map((socket) => ({
        ...socket.record,
        sent: [...socket.record.sent],
      })),
    send(match, data) {
      const text = typeof data === "string" ? data : JSON.stringify(data);
      const targets = all.filter(
        (socket) => socket.readyState === OPEN && socket.url.includes(match),
      );
      for (const socket of targets) socket.receive(text);
      if (targets.length > 0) notify();
      return targets.length;
    },
    close(match, code = 1000) {
      const targets = all.filter(
        (socket) =>
          (socket.readyState === CONNECTING || socket.readyState === OPEN) &&
          socket.url.includes(match),
      );
      for (const socket of targets) socket.close(code);
      return targets.length;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
