import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";
import { LiveScreen } from "@/components/computer/live-screen";

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(_url: string) {
    SocketDouble.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

type ObserverEntry = {
  observer: IntersectionObserverDouble;
  target: Element;
};

class IntersectionObserverDouble {
  static observed: ObserverEntry[] = [];

  constructor(
    private readonly callback: IntersectionObserverCallback,
    _options?: IntersectionObserverInit,
  ) {}

  observe(target: Element) {
    IntersectionObserverDouble.observed.push({ observer: this, target });
  }

  unobserve(target: Element) {
    IntersectionObserverDouble.observed =
      IntersectionObserverDouble.observed.filter(
        (entry) => entry.observer !== this || entry.target !== target,
      );
  }

  disconnect() {
    IntersectionObserverDouble.observed =
      IntersectionObserverDouble.observed.filter(
        (entry) => entry.observer !== this,
      );
  }

  fire(target: Element, isIntersecting: boolean) {
    this.callback(
      [
        {
          target,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

let originalWebSocket: typeof WebSocket;
let originalCreateImageBitmap: typeof createImageBitmap | undefined;
let originalFetch: typeof fetch;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;
let originalCanvasGetContext: typeof HTMLCanvasElement.prototype.getContext;
let originalImageDecode: typeof HTMLImageElement.prototype.decode | undefined;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  originalCreateImageBitmap = globalThis.createImageBitmap;
  originalFetch = globalThis.fetch;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;
  originalImageDecode = HTMLImageElement.prototype.decode;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.IntersectionObserver =
    IntersectionObserverDouble as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  SocketDouble.latest = undefined;
  IntersectionObserverDouble.observed = [];
  globalThis.fetch = originalFetch;
  if (originalCreateImageBitmap) {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  } else {
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
  HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
  if (originalImageDecode) {
    HTMLImageElement.prototype.decode = originalImageDecode;
  } else {
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  }
  setVisibility("visible");
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  } else {
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
  }
  if (originalCreateImageBitmap) {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  } else {
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
  HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
  if (originalImageDecode) {
    HTMLImageElement.prototype.decode = originalImageDecode;
  } else {
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  }
  GlobalRegistrator.unregister();
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state !== "visible",
  });
}

function sendFrame(socket: SocketDouble, data: string) {
  socket.onmessage?.({
    data: JSON.stringify({
      type: "frame",
      data,
      width: 320,
      height: 200,
    }),
  });
}

test("hidden live screen keeps the stream open and draws the latest hidden frame when visible again", async () => {
  setVisibility("hidden");
  let decodes = 0;
  let draws = 0;
  globalThis.createImageBitmap = (async () => {
    decodes += 1;
    return { width: 320, height: 200, close() {} } as ImageBitmap;
  }) as typeof createImageBitmap;
  HTMLCanvasElement.prototype.getContext = (() =>
    ({
      drawImage: () => (draws += 1),
    }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  render(<LiveScreen computerId="hidden-live" driving />);
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;

  sendFrame(socket, "AAAA");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(decodes).toBe(0);
  expect(draws).toBe(0);
  expect(socket.readyState).toBe(SocketDouble.OPEN);

  setVisibility("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await waitFor(() => expect(decodes).toBe(1));
  expect(draws).toBe(1);
  expect(socket.readyState).toBe(SocketDouble.OPEN);
});

test("an older pending live screen decode cannot replace a newer frame", async () => {
  type PendingDecode = {
    bitmap: ImageBitmap & { label: string };
    resolve: (bitmap: ImageBitmap & { label: string }) => void;
  };
  const pending: PendingDecode[] = [];
  const drawn: string[] = [];
  globalThis.createImageBitmap = (() =>
    new Promise((resolve) => {
      const label = pending.length === 0 ? "first" : "second";
      pending.push({
        bitmap: {
          width: 320,
          height: 200,
          label,
          close() {},
        } as ImageBitmap & {
          label: string;
        },
        resolve: resolve as PendingDecode["resolve"],
      });
    })) as typeof createImageBitmap;
  HTMLCanvasElement.prototype.getContext = (() =>
    ({
      drawImage: (bitmap: ImageBitmap & { label?: string }) => {
        drawn.push(bitmap.label ?? "unknown");
      },
    }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  render(<LiveScreen computerId="pending-live" driving />);
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;

  sendFrame(socket, "AAAA");
  sendFrame(socket, "BBBB");
  await waitFor(() => expect(pending.length).toBe(2));

  pending[1].resolve(pending[1].bitmap);
  await waitFor(() => expect(drawn).toEqual(["second"]));

  pending[0].resolve(pending[0].bitmap);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(drawn).toEqual(["second"]);
});

test("hidden computer preview pauses screenshot polling while control polling continues", async () => {
  setVisibility("hidden");
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/control")) {
      return Response.json({
        holder: "bot",
        since: new Date(0).toISOString(),
        requested: false,
      });
    }
    if (path.endsWith("/screenshot")) {
      return Response.json({
        base64: "AAAA",
        width: 320,
        height: 200,
        capturedAt: new Date(0).toISOString(),
        url: "https://example.com",
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  render(<ComputerView computerId="hidden-preview" active intervalMs={10} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  expect(paths.some((path) => path.endsWith("/control"))).toBe(true);
  expect(paths.some((path) => path.endsWith("/screenshot"))).toBe(false);
});

test("offscreen computer preview starts screenshot polling when it intersects", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/control")) {
      return Response.json({
        holder: "bot",
        since: new Date(0).toISOString(),
        requested: false,
      });
    }
    if (path.endsWith("/screenshot")) {
      return Response.json({
        base64: "AAAA",
        width: 320,
        height: 200,
        capturedAt: new Date(0).toISOString(),
        url: "https://example.com",
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  render(
    <ComputerView computerId="offscreen-preview" active intervalMs={10} />,
  );
  const entry = IntersectionObserverDouble.observed.at(0);
  expect(entry).toBeDefined();
  await act(async () => {
    entry?.observer.fire(entry.target, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(paths.some((path) => path.endsWith("/screenshot"))).toBe(false);

  await act(async () => {
    entry?.observer.fire(entry.target, true);
  });

  await waitFor(() =>
    expect(paths.some((path) => path.endsWith("/screenshot"))).toBe(true),
  );
});

test("computer preview does not decode a screenshot response that lands after the page is hidden", async () => {
  let resolveScreenshot: ((response: Response) => void) | undefined;
  let decodes = 0;
  HTMLImageElement.prototype.decode = () => {
    decodes += 1;
    return Promise.resolve();
  };
  globalThis.fetch = (async (input) => {
    const path = String(input);
    if (path.endsWith("/control")) {
      return Response.json({
        holder: "bot",
        since: new Date(0).toISOString(),
        requested: false,
      });
    }
    if (path.endsWith("/screenshot")) {
      return new Promise<Response>((resolve) => {
        resolveScreenshot = resolve;
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  render(<ComputerView computerId="pending-preview" active intervalMs={10} />);
  const entry = IntersectionObserverDouble.observed.at(0);
  expect(entry).toBeDefined();
  await act(async () => {
    entry?.observer.fire(entry.target, true);
  });
  await waitFor(() => expect(resolveScreenshot).toBeDefined());

  await act(async () => {
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  resolveScreenshot?.(
    Response.json({
      base64: "AAAA",
      width: 320,
      height: 200,
      capturedAt: new Date(0).toISOString(),
      url: "https://example.com",
    }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(decodes).toBe(0);
});
