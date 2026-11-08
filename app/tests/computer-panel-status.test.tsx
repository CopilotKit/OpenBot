import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { ComputerView } from "@/components/computer/computer-view";
import { settleReactWork } from "./settle-react-work";

/**
 * The Bot's browser as a conversation shows it: a window with an address bar saying where it is (the site, then the
 * rest of the address), and over the foot of its picture, while the Bot holds the wheel, a strip saying which Bot has
 * control with Take control beside it.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    queueMicrotask(() => this.onopen?.());
  }

  send() {}

  close() {
    this.readyState = SocketDouble.CLOSED;
  }
}

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;
// Prototypes outlive this file: bun runs every test file in one process.
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
let originalDecode: typeof HTMLImageElement.prototype.decode;

beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  originalDecode = HTMLImageElement.prototype.decode;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  // Without an observer the preview counts as on screen.
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  HTMLImageElement.prototype.decode = () => Promise.resolve();
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: () => undefined,
    clearRect: () => undefined,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// The screen refetches every 10ms, so its last renders are still posted when the last test ends.
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  }
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLImageElement.prototype.decode = originalDecode;
  GlobalRegistrator.unregister();
});

function renderWithQueries(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

/** A Bot's browser on `url`, with the Bot holding the wheel. */
function serve(url: string) {
  globalThis.fetch = (async (input) => {
    const path = String(input);
    if (path.endsWith("/screenshot"))
      return Response.json({
        base64: "AAAA",
        width: 320,
        height: 200,
        capturedAt: new Date(0).toISOString(),
        url,
      });
    if (path.endsWith("/control"))
      return Response.json({
        holder: "bot",
        since: new Date(0).toISOString(),
        requested: false,
      });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** The strip over the foot of the Bot's screen. */
async function strip(view: ReturnType<typeof renderWithQueries>) {
  await view.findByAltText("What the Bot is looking at");
  const found = await view.findByText(/has control$/);
  const element = found.closest('[data-slot="control-strip"]');
  expect(element).not.toBeNull();
  return within(element as HTMLElement);
}

test("while the Bot holds the wheel, the strip on its screen names it and offers Take control", async () => {
  serve("https://example.com");
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  const status = await strip(view);
  expect(status.getByText("Sales has control")).toBeTruthy();
  expect(status.getByRole("button", { name: "Take control" })).toBeTruthy();
});

test("a Bot without a name is still said to have control", async () => {
  serve("https://example.com");
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} />,
  );
  const status = await strip(view);
  expect(status.getByText("The Bot has control")).toBeTruthy();
});

test("the window's address bar says where the Bot's browser is: the site, then the rest of the address", async () => {
  serve("https://shop.example.com/orders?id=7");
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByAltText("What the Bot is looking at");
  const host = await view.findByText("shop.example.com");
  const bar = host.closest("figcaption");
  expect(bar).not.toBeNull();
  expect(bar?.textContent).toBe("shop.example.com/orders?id=7");
  // Where it is, not whose it is: the name gives way to the address once there is one.
  expect(within(bar as HTMLElement).queryByText("Sales")).toBeNull();
});

test("with no page open, the window's bar says whose browser it is", async () => {
  serve("about:blank");
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  // A blank browser draws no picture, only the words for one, so the bar is all there is to wait on.
  await waitFor(() =>
    expect(view.container.querySelector("figcaption")?.textContent).toBe(
      "Sales",
    ),
  );
  expect(view.queryByText(/about:blank/)).toBeNull();
});
