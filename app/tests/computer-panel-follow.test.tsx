import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { ComputerTerminal } from "@/components/computer/computer-terminal";
import {
  followView,
  latestView,
  showComputerView,
} from "@/lib/computers/panel-view";

/**
 * The Computer panel following the Bot, and Take control acting on the terminal when the terminal is
 * what is on view.
 *
 * Drawn for real: the panel, its tabs, the screen card and the terminal, against a server stand-in
 * that answers the control routes the way the computer does, and a socket stand-in for the terminal.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = SocketDouble.OPEN;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

/** The computer's wheel, as the server answers for it. */
let holder: "bot" | "human" = "bot";
const asked: string[] = [];

function controlState() {
  return {
    holder,
    since: "2026-11-05T00:00:00.000Z",
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    recoveryRequired: false,
    request:
      holder === "human"
        ? { id: "r1", status: "taken", reason: "", source: "manual" }
        : { id: "r1", status: "waiting", reason: "", source: "manual" },
  };
}

let originalWebSocket: typeof WebSocket;
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  originalFetch = globalThis.fetch;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://openbot.test").pathname;
    asked.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/control/take")) holder = "human";
    if (path.endsWith("/control/release")) holder = "bot";
    if (path.includes("/control")) return Response.json(controlState());
    if (path === "/api/me")
      return Response.json({ user: { id: "ada", name: "Ada" } });
    return Response.json({ error: "Not here." }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  holder = "bot";
  asked.length = 0;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function renderWithQueries(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const selected = () =>
  [...document.querySelectorAll('[role="tab"]')]
    .filter((tab) => tab.getAttribute("aria-selected") === "true")
    .map((tab) => tab.textContent?.trim());

function call(name: string, id: string): Message {
  return {
    id: `m-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  } as Message;
}

test("the view a conversation's last computer call worked in is the one the panel follows", () => {
  expect(latestView([])).toBeUndefined();
  expect(latestView([call("computer_navigate", "a")])?.view).toBe("screen");
  expect(
    latestView([
      call("computer_navigate", "a"),
      call("computer_run_command", "b"),
    ]),
  ).toEqual({ view: "terminal", callId: "b" });
  // Reading or saving a file shows on neither, so the last view stands.
  expect(
    latestView([
      call("computer_run_command", "b"),
      call("computer_read_file", "c"),
    ])?.view,
  ).toBe("terminal");
});

test("the panel shows the terminal when the Bot runs a command, the screen when it opens a page, and the person's pick holds until it closes", async () => {
  followView("follow-bot", { view: "terminal", callId: "c1" });
  const first = renderWithQueries(<ComputerViewPanel agentId="follow-bot" />);
  // A Bot that has only used its shell opens on the terminal.
  await waitFor(() => expect(selected()).toEqual(["Terminal"]));

  act(() => followView("follow-bot", { view: "screen", callId: "c2" }));
  await waitFor(() => expect(selected()).toEqual(["Screen"]));
  act(() => followView("follow-bot", { view: "terminal", callId: "c3" }));
  await waitFor(() => expect(selected()).toEqual(["Terminal"]));

  // The person picks the screen: the Bot's next command does not take it away.
  const screenTab = [...document.querySelectorAll('[role="tab"]')].find(
    (tab) => tab.textContent?.trim() === "Screen",
  ) as HTMLElement;
  act(() => screenTab.click());
  await waitFor(() => expect(selected()).toEqual(["Screen"]));
  act(() => followView("follow-bot", { view: "terminal", callId: "c4" }));
  await Bun.sleep(50);
  expect(selected()).toEqual(["Screen"]);

  // Closed and opened again, it follows the Bot again.
  first.unmount();
  renderWithQueries(<ComputerViewPanel agentId="follow-bot" />);
  await waitFor(() => expect(selected()).toEqual(["Terminal"]));
});

test("a command clicked in the chat puts the terminal in front", async () => {
  followView("click-bot", { view: "screen", callId: "s1" });
  renderWithQueries(<ComputerViewPanel agentId="click-bot" />);
  await waitFor(() => expect(selected()).toEqual(["Screen"]));
  act(() => showComputerView("click-bot", "terminal"));
  await waitFor(() => expect(selected()).toEqual(["Terminal"]));
});

test("Take control in the terminal gives the terminal the keyboard, says so in terminal words, and opens no screen", async () => {
  renderWithQueries(<ComputerTerminal computerId="wheel-bot" />);
  const take = await waitFor(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Take control",
    );
    expect(button?.hasAttribute("disabled")).toBe(false);
    return button as HTMLButtonElement;
  });
  act(() => take.click());
  await waitFor(() =>
    expect(document.body.textContent).toContain(
      "of the terminal and the screen. Click the terminal and type.",
    ),
  );
  expect(asked).toContain("POST /api/computers/wheel-bot/control/take");
  // The keyboard is the terminal's, and the full-size screen did not open over it.
  await waitFor(() =>
    expect(document.activeElement?.className).toContain(
      "xterm-helper-textarea",
    ),
  );
  expect(document.querySelector('[aria-label="The Bot\'s screen"]')).toBeNull();
});
