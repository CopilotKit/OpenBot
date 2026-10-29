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
import { ToolLine } from "@/components/channels/tool-line";
import { ComputerView } from "@/components/computer/computer-view";

test("a call turned away by a computer still starting reads as not done yet, not as a failure", () => {
  const view = render(
    <ToolLine
      label="Clicked"
      detail="The computer is still starting."
      notYet
    />,
  );
  const line = view.getByText("Clicked, not done yet");
  expect(line.closest(".text-amber-600")).toBeNull();
  expect(line.closest(".text-destructive")).toBeNull();
  expect(view.queryByText(/didn't work/)).toBeNull();
});

/**
 * A computer starting in front of a person never reads as a failure.
 *
 * The panel used to call the first frameless screenshot a problem, so every cold start opened on
 * "Can't show the screen right now… ask an admin", and every blip in the live stream covered the
 * screen with a Retry panel. What a person should see instead is a sentence saying the computer is
 * starting, a small "Reconnecting…" while the stream comes back, and a problem only when there
 * really is one.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: SocketDouble[] = [];

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: string) {
    SocketDouble.all.push(this);
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
// Prototypes outlive this file: bun runs every test file in one process, and a canvas stub left
// behind here breaks the next file that draws on one.
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
  // Without an observer the preview counts as on screen, which is what these cases are about.
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  HTMLImageElement.prototype.decode = () => Promise.resolve();
});

afterEach(() => {
  cleanup();
  SocketDouble.all = [];
  globalThis.fetch = originalFetch;
});

afterAll(() => {
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

const control = {
  holder: "bot",
  since: new Date(0).toISOString(),
  requested: false,
};

/** A server whose answers are given per path ending; anything else is a 404. */
function serve(routes: Record<string, () => Response>) {
  globalThis.fetch = (async (input) => {
    const path = String(input);
    for (const [ending, answer] of Object.entries(routes)) {
      if (path.endsWith(ending)) return answer();
    }
    if (path.endsWith("/control")) return Response.json(control);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const frame = () =>
  Response.json({
    base64: "AAAA",
    width: 320,
    height: 200,
    capturedAt: new Date(0).toISOString(),
    url: "https://example.com",
  });

test("a computer that is starting says so, calmly, and shows no problem", async () => {
  serve({
    "/status": () => Response.json({ botId: "sales", state: "starting" }),
    "/screenshot": () => Response.json({ ready: false, state: "starting" }),
  });

  const view = renderWithQueries(
    <ComputerView
      active
      computerId="sales"
      intervalMs={10}
      name="Sales"
      toolCallId="call-1"
    />,
  );

  expect(
    await view.findByText(
      "Starting Sales's computer. The first start takes about a minute.",
    ),
  ).toBeDefined();
  expect(view.queryByText(/can't show the screen/i)).toBeNull();
  expect(view.queryByText(/error/i)).toBeNull();
});

test("failed screenshots during a start are not a problem until the grace runs out", async () => {
  serve({
    "/status": () => Response.json({ botId: "sales", state: "starting" }),
    "/screenshot": () =>
      Response.json(
        { error: "The computer did not respond." },
        { status: 503 },
      ),
  });

  const view = renderWithQueries(
    <ComputerView
      active
      computerId="sales"
      intervalMs={10}
      name="Sales"
      startupGraceMs={200}
    />,
  );

  await view.findByText(/^Starting Sales's computer/);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  expect(view.queryByText(/can't show the screen/i)).toBeNull();

  // Past the grace, with still no frame, it is worth saying.
  expect(
    await view.findByText(
      "Can't show the screen right now",
      {},
      { timeout: 1000 },
    ),
  ).toBeDefined();
  expect(view.getByText("The computer did not respond.")).toBeDefined();
});

test("a computer the server cannot reach is a problem straight away", async () => {
  serve({
    "/status": () =>
      Response.json({
        botId: "sales",
        state: "unreachable",
        reason: "supervisor down",
      }),
    "/screenshot": () =>
      Response.json({
        ready: false,
        state: "unreachable",
        reason: "supervisor down",
      }),
  });

  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );

  expect(
    await view.findByText("Sales's computer can't be reached right now."),
  ).toBeDefined();
  // The provider's own words are for an admin, not this screen.
  expect(view.queryByText(/supervisor down/)).toBeNull();
});

test("a computer that is off, watched from the side panel, says it starts when the Bot uses it", async () => {
  serve({
    "/status": () => Response.json({ botId: "sales", state: "absent" }),
    "/screenshot": () => Response.json({ ready: false, state: "absent" }),
  });

  const view = renderWithQueries(
    <ComputerView
      active
      computerId="sales"
      intervalMs={10}
      name="Sales"
      startupGraceMs={30}
    />,
  );

  expect(
    await view.findByText(
      "Sales's computer is off. It starts when the Bot next uses it.",
    ),
  ).toBeDefined();
  // Off is not stalled: waiting past the grace still shows no problem.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(view.queryByText(/can't show the screen/i)).toBeNull();
});

test("a live stream that drops shows a quiet badge, not the Retry panel", async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: () => undefined,
    clearRect: () => undefined,
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  serve({ "/screenshot": frame });

  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByAltText("What the Bot is looking at");
  fireEvent.click(view.getByLabelText("Open the Bot's screen full size"));
  await waitFor(() => expect(SocketDouble.all.length).toBe(1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  await act(async () => {
    SocketDouble.all[0]?.onclose?.();
  });

  expect(view.getByText("Reconnecting…")).toBeDefined();
  expect(view.queryByText("Retry")).toBeNull();
});

test("a computer that was off and then fails is not called off for ever", async () => {
  // The first answer says off; every one after it is a failed screenshot of a computer now up.
  let shots = 0;
  serve({
    "/status": () => Response.json({ botId: "sales", state: "ready" }),
    "/screenshot": () =>
      shots++ === 0
        ? Response.json({ ready: false, state: "absent" })
        : Response.json(
            { error: "The computer did not respond." },
            { status: 503 },
          ),
  });

  const view = renderWithQueries(
    <ComputerView
      active
      computerId="sales"
      intervalMs={10}
      name="Sales"
      startupGraceMs={100}
    />,
  );

  expect(
    await view.findByText(
      "Can't show the screen right now",
      {},
      { timeout: 1000 },
    ),
  ).toBeDefined();
  expect(view.queryByText(/is off/)).toBeNull();
});

test("a computer that goes to sleep stops showing its last frame", async () => {
  let shots = 0;
  serve({
    "/status": () => Response.json({ botId: "sales", state: "absent" }),
    "/screenshot": () =>
      shots++ === 0
        ? frame()
        : Response.json({ ready: false, state: "absent" }),
  });

  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );

  await view.findByAltText("What the Bot is looking at");
  await waitFor(() => {
    expect(
      view.getByText(
        "Sales's computer is off. It starts when the Bot next uses it.",
      ),
    ).toBeDefined();
    expect(view.queryByAltText("What the Bot is looking at")).toBeNull();
  });
});
