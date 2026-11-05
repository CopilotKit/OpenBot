import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { ComputerView } from "@/components/computer/computer-view";
import { settleReactWork } from "./settle-react-work";

/**
 * The Bot's screen, opened full size, has a button that closes it.
 *
 * A live view fills the window, so the strip of backdrop around it is a few pixels wide, and that
 * backdrop does nothing while the person has the wheel. Escape was the only way out, and nothing on
 * screen said so. A person watching a Bot work had no visible way back to the conversation.
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

const frame = () =>
  Response.json({
    base64: "AAAA",
    width: 320,
    height: 200,
    capturedAt: new Date(0).toISOString(),
    url: "https://example.com",
  });

/** A server holding the wheel where `holder` says, with a screen to show. */
function serve(holder: "bot" | "human") {
  globalThis.fetch = (async (input) => {
    const path = String(input);
    if (path.endsWith("/screenshot")) return frame();
    if (path.endsWith("/control")) {
      return Response.json({
        holder,
        since: new Date(0).toISOString(),
        requested: false,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function openFullSize() {
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByAltText("What the Bot is looking at");
  fireEvent.click(view.getByLabelText("Open the Bot's screen full size"));
  await view.findByRole("dialog", { name: "The Bot's screen" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

/** The close button a person can see: an X in the card, not the backdrop behind it. */
function closeButton(view: Awaited<ReturnType<typeof openFullSize>>) {
  const button = view.getByRole("button", { name: "Close the Bot's screen" });
  expect(button.querySelector("svg")).not.toBeNull();
  return button;
}

test("watching a Bot work, the close button takes the person back", async () => {
  serve("bot");
  const view = await openFullSize();

  fireEvent.click(closeButton(view));

  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "The Bot's screen" })).toBeNull(),
  );
});

test("with the wheel in the person's hands, the close button still takes them back", async () => {
  serve("human");
  const view = await openFullSize();
  await view.findAllByText(/You have control/);

  fireEvent.click(closeButton(view));

  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "The Bot's screen" })).toBeNull(),
  );
  // Closing never hands the wheel back, so the Bot is still waiting on them, and the small view says so.
  expect(
    view.getByText(/The Bot waits until you hand it back\./),
  ).toBeDefined();
});
