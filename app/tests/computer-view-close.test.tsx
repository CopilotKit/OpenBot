import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComputerView } from "@/components/computer/computer-view";

const nativeWebSocket = globalThis.WebSocket;

class QuietWebSocket {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = QuietWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string | URL) {
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = 3;
  }
}

beforeAll(() => {
  GlobalRegistrator.register();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: QuietWebSocket,
  });
});
afterEach(cleanup);
afterAll(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: nativeWebSocket,
  });
  GlobalRegistrator.unregister();
});

let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/control")) {
      return Response.json({
        holder: "human",
        since: "2026-09-07T00:00:00.000Z",
        requested: false,
      });
    }
    if (path.endsWith("/screenshot")) {
      return Response.json({
        base64: "",
        width: 1280,
        height: 800,
        capturedAt: "2026-09-07T00:00:00.000Z",
        url: "about:blank",
      });
    }
    return Response.json(
      { error: `Unexpected test request: ${path}` },
      { status: 404 },
    );
  });
});

afterEach(() => fetchSpy.mockRestore());

test("the expanded screen has a visible way out while a person holds the wheel", async () => {
  const view = render(<ComputerView active computerId="bot-1" />);

  await waitFor(() => expect(view.getByText("You have control")).toBeTruthy());
  await userEvent.click(
    view.getByRole("button", {
      name: "Open the assistant's screen full size",
    }),
  );

  const page = within(document.body);
  expect(page.getByRole("dialog")).toBeTruthy();
  await userEvent.click(
    page.getByRole("button", { name: "Close the assistant's screen" }),
  );

  await waitFor(() => expect(page.queryByRole("dialog")).toBeNull());
});
