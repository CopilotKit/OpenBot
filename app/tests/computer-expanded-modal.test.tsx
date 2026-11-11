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
 * The Bot's screen, opened full size, is a modal.
 *
 * It was a portal with role="dialog" and a window Escape handler, and nothing else: focus stayed on
 * the covered button that opened it, and Tab walked through the page behind it. Opened from the
 * Computer drawer on a phone, Tab stayed in the drawer underneath.
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
    <QueryClientProvider client={queryClient}>
      <button type="button">Behind the screen</button>
      {ui}
    </QueryClientProvider>,
  );
}

/** A server with the wheel where `holder` says. `screen: false` is a computer with nothing to show. */
function serve(holder: "bot" | "human", screen = true) {
  globalThis.fetch = (async (input) => {
    const path = String(input);
    if (path.endsWith("/screenshot")) {
      return screen
        ? Response.json({
            base64: "AAAA",
            width: 320,
            height: 200,
            capturedAt: new Date(0).toISOString(),
            url: "https://example.com",
          })
        : Response.json({ error: "unreachable" }, { status: 503 });
    }
    if (path.endsWith("/status"))
      return Response.json({ state: "unreachable" });
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

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Opens the full-size view from the keyboard, the way a person tabbing to it would. */
async function openFromKeyboard(view: ReturnType<typeof renderWithQueries>) {
  const opener = view.getByLabelText("Open the Bot's screen full size");
  opener.focus();
  fireEvent.click(opener);
  const dialog = await view.findByRole("dialog", { name: "The Bot's screen" });
  await settle();
  return { opener, dialog };
}

const close = (view: ReturnType<typeof renderWithQueries>) =>
  view.getByRole("button", { name: "Close the Bot's screen" });

/** Base UI marks what is behind a modal inert or hidden; either way a person can't reach it. */
function unreachable(element: Element) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (
      node.hasAttribute("inert") ||
      node.getAttribute("aria-hidden") === "true"
    )
      return true;
  }
  return false;
}

test("watching the Bot, opening it full size puts focus on Close", async () => {
  serve("bot");
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByAltText("What the Bot is looking at");
  const { dialog } = await openFromKeyboard(view);

  await waitFor(() => expect(document.activeElement).toBe(close(view)));
  expect(dialog.contains(document.activeElement)).toBe(true);
});

test("the page behind the full-size view can't be reached", async () => {
  serve("bot");
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByAltText("What the Bot is looking at");
  const { opener } = await openFromKeyboard(view);

  await waitFor(() =>
    expect(
      unreachable(
        view.getByRole("button", { name: "Behind the screen", hidden: true }),
      ),
    ).toBe(true),
  );
  expect(unreachable(opener)).toBe(true);
  expect(unreachable(close(view))).toBe(false);
});

test("Escape closes it and gives focus back to what opened it", async () => {
  serve("bot");
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByAltText("What the Bot is looking at");
  const { opener } = await openFromKeyboard(view);
  await waitFor(() => expect(document.activeElement).toBe(close(view)));

  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "The Bot's screen" })).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test("Close gives focus back to what opened it", async () => {
  serve("bot");
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByAltText("What the Bot is looking at");
  const { opener } = await openFromKeyboard(view);

  fireEvent.click(close(view));

  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "The Bot's screen" })).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test("a computer that can't be reached still opens with focus on Close", async () => {
  serve("bot", false);
  const view = renderWithQueries(
    <ComputerView
      active
      computerId="sales"
      intervalMs={10}
      name="Sales"
      startupGraceMs={0}
    />,
  );
  await settle();
  await openFromKeyboard(view);

  await waitFor(() => expect(document.activeElement).toBe(close(view)));
});

test("a finished turn's screen opens with focus on Close and closes on Escape", async () => {
  serve("bot");
  const view = renderWithQueries(
    <ComputerView
      active={false}
      computerId="sales"
      finished
      name="Sales"
      page={{ url: "https://example.com", title: "Example" }}
    />,
  );
  await settle();
  const { opener } = await openFromKeyboard(view);
  await waitFor(() => expect(document.activeElement).toBe(close(view)));

  fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

  await waitFor(() =>
    expect(view.queryByRole("dialog", { name: "The Bot's screen" })).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test("driving, the screen takes the keyboard and Tab goes to the Bot's browser", async () => {
  serve("human");
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByAltText("What the Bot is looking at");
  await view.findAllByText(/You have control/);
  const { dialog } = await openFromKeyboard(view);

  const canvas = await waitFor(() => {
    const found = dialog.querySelector("canvas");
    if (!found) throw new Error("no live screen yet");
    return found;
  });
  await waitFor(() => expect(document.activeElement).toBe(canvas));

  const tab = new KeyboardEvent("keydown", {
    key: "Tab",
    code: "Tab",
    bubbles: true,
    cancelable: true,
  });
  canvas.dispatchEvent(tab);
  // Prevented, so the page's focus doesn't move: the key is the remote browser's.
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(canvas);
  expect(view.getByRole("dialog", { name: "The Bot's screen" })).toBeDefined();
});
