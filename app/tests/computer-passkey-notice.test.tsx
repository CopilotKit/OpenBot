import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type ComputerControlState,
  PASSKEY_REASON,
} from "@openbot/shared/computer-control";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { ComputerView } from "@/components/computer/computer-view";
import { PASSKEY_NOTICE } from "@/lib/computers/control";
import { settleReactWork } from "./settle-react-work";

/**
 * A page in a Bot's computer that asks for a passkey is said plainly where the person is looking at the computer: the
 * card in the conversation and the full-size view they work in. A passkey kept on their own device can't be used in
 * the Bot's computer, and the way through is the page's own Try another way.
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

const AT = new Date(0).toISOString();

/** The control state the computer answers, as the API carries it. */
function control(
  request: Partial<NonNullable<ComputerControlState["request"]>>,
  holder: "bot" | "human",
): ComputerControlState {
  const full = {
    id: "request-1",
    reason: "Sign in to Google so I can read your calendar.",
    source: "model" as const,
    status: holder === "human" ? ("taken" as const) : ("waiting" as const),
    createdAt: AT,
    updatedAt: AT,
    ...request,
  };
  return {
    holder,
    since: AT,
    requested: full.status === "waiting",
    reason: full.reason,
    request: full,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
  };
}

function serve(state: ComputerControlState) {
  globalThis.fetch = (async (input) => {
    const path = String(input);
    if (path.endsWith("/screenshot"))
      return Response.json({
        base64: "AAAA",
        width: 320,
        height: 200,
        capturedAt: AT,
        url: "https://accounts.google.com/v3/signin/challenge/pk",
      });
    if (path.endsWith("/control")) return Response.json(state);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderWithQueries(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const PASSKEY = { host: "accounts.google.com", askedAt: AT };

test("a person holding the wheel is told the page wants a passkey, and the way through, on the card and in the full-size view", async () => {
  serve(control({ passkey: PASSKEY }, "human"));
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  // The card in the conversation.
  expect(
    await view.findByText((text) => text.includes(PASSKEY_NOTICE)),
  ).toBeTruthy();
  expect(PASSKEY_NOTICE).toContain("Try another way");

  // The full-size view the person works in.
  fireEvent.click(view.getByLabelText("Open the Bot's screen full size"));
  const dialog = await view.findByRole("dialog", { name: "The Bot's screen" });
  await settle();
  expect(
    within(dialog).getByText((text) => text.includes(PASSKEY_NOTICE)),
  ).toBeTruthy();
  // In place of the reason the Bot gave, which asked for a sign-in the page has moved past.
  expect(
    within(dialog).queryByText((text) =>
      text.includes("so I can read your calendar"),
    ),
  ).toBeNull();
});

test("a request the computer raised for a passkey asks the person in its own words", async () => {
  serve(
    control(
      { source: "passkey", reason: PASSKEY_REASON, passkey: PASSKEY },
      "bot",
    ),
  );
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  expect(await view.findByText("The Bot needs you.")).toBeTruthy();
  // Said once: the request's own reason already is the passkey's.
  const said = view.getAllByText((text) =>
    text.includes("asking for a passkey"),
  );
  expect(said.length).toBeGreaterThan(0);
  for (const element of said)
    expect(element.textContent?.split("asking for a passkey").length).toBe(2);
  expect(PASSKEY_REASON).toContain("Try another way");
});

test("a page that asked for nothing says nothing about passkeys", async () => {
  serve(control({}, "human"));
  const view = renderWithQueries(
    <ComputerView active computerId="sales" intervalMs={10} name="Sales" />,
  );
  await view.findByText("You have control.");
  await settle();
  expect(
    view.queryByText((text) => text.includes("asking for a passkey")),
  ).toBeNull();
});
