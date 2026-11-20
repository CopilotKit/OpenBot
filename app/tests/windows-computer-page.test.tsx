import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  controlWords,
  NOT_MASKED,
  programsFrom,
  unavailableWords,
  WindowsComputerPage,
} from "@/components/windows-computer/windows-computer-page";
import {
  getGetWindowsComputerResponseMock,
  getReleaseWindowsComputerControlMockHandler,
  getTakeWindowsComputerControlMockHandler,
  getWindowsComputerMock,
} from "@/lib/api/generated/windows-computer/windows-computer.msw";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The Windows computer's page: its live screen, labelled as not masked and driven only while the person holds control,
 * and taking it over and handing it back through the client generated from api/openapi.yaml.
 */

/** Every socket the page opened, and what it sent on each. */
const sockets: { url: string; sent: string[]; socket: FakeSocket }[] = [];

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(url: string) {
    sockets.push({ url, sent: [], socket: this });
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    });
  }
  send(data: string) {
    sockets.find((entry) => entry.socket === this)?.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}

const requests: string[] = [];
const server = setupServer(
  ...getWindowsComputerMock(),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", ({ request }) => {
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}`);
});

let realWebSocket: typeof WebSocket;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
  // After MSW's listen, which puts its own WebSocket interceptor in the global's place.
  realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  queryClient.clear();
  requests.length = 0;
  sockets.length = 0;
});
afterAll(async () => {
  globalThis.WebSocket = realWebSocket;
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <WindowsComputerPage />
    </QueryClientProvider>,
  );
}

/** The Windows computer, with control held by `holder`. */
function heldBy(holder: "bot" | "human") {
  return http.get(
    "*/api/v2/organizations/:organizationId/windows-computer",
    () =>
      HttpResponse.json({
        ...getGetWindowsComputerResponseMock(),
        available: true,
        unavailableReason: undefined,
        control: {
          holder,
          since: "2026-11-20T09:13:41.000Z",
          ...(holder === "human" ? { reason: "taken" } : {}),
          snapshotRequired: holder === "human",
        },
      }),
  );
}

/** The page, its one screen socket, and a picture on its canvas to click and type on. */
async function liveScreen() {
  const view = draw();
  expect(await view.findByText(NOT_MASKED)).toBeTruthy();
  await waitFor(() => expect(sockets).toHaveLength(1));
  const entry = sockets[0];
  if (!entry) throw new Error("no socket");
  entry.socket.onmessage?.({
    data: JSON.stringify({
      type: "frame",
      data: "AAAA",
      width: 800,
      height: 600,
    }),
  });
  const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
  await settleReactWork();
  return { view, entry, canvas };
}

test("the screen is watched at the Windows computer's address and said to be unmasked; while the Bot has it, nothing is sent", async () => {
  server.use(heldBy("bot"));
  const { entry, canvas } = await liveScreen();
  expect(requests).toContain(
    "GET /api/v2/organizations/default/windows-computer",
  );
  expect(new URL(entry.url).pathname).toBe(
    "/api/v2/organizations/default/windows-computer/screen",
  );
  fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10, button: 0 });
  fireEvent.mouseUp(canvas, { clientX: 10, clientY: 10, button: 0 });
  fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
  fireEvent.wheel(canvas, { deltaY: 100 });
  await settleReactWork();
  expect(
    entry.sent.filter((message) => !message.includes("frame-received")),
  ).toEqual([]);
});

test("once the person holds control, what they click on the screen goes to the Windows computer", async () => {
  server.use(heldBy("human"));
  const { entry, canvas } = await liveScreen();
  fireEvent.mouseDown(canvas, {
    clientX: 40,
    clientY: 30,
    button: 0,
    detail: 1,
  });
  fireEvent.mouseUp(canvas, { clientX: 40, clientY: 30, button: 0, detail: 1 });
  await waitFor(() =>
    expect(
      entry.sent
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .filter(
          (message) => message.type === "mouse" && message.event === "pressed",
        ),
    ).toHaveLength(1),
  );
  const pressed = entry.sent
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .find((message) => message.type === "mouse" && message.event === "pressed");
  expect(pressed).toMatchObject({ x: 40, y: 30, button: "left" });
});

test("taking it over and handing it back are writes at the API's address, each with its own Idempotency-Key", async () => {
  const keys: string[] = [];
  server.use(
    getTakeWindowsComputerControlMockHandler(({ request }) => {
      keys.push(request.headers.get("idempotency-key") ?? "");
      return {
        holder: "human",
        since: "2026-11-20T09:13:41.000Z",
        snapshotRequired: true,
      };
    }),
    getReleaseWindowsComputerControlMockHandler(({ request }) => {
      keys.push(request.headers.get("idempotency-key") ?? "");
      return {
        holder: "bot",
        since: "2026-11-20T09:20:05.000Z",
        snapshotRequired: true,
      };
    }),
  );
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "Take over" }));
  await settleReactWork();
  expect(requests).toContain(
    "POST /api/v2/organizations/default/windows-computer/control/take",
  );

  // The next read says the person has it now.
  server.use(
    http.get("*/api/v2/organizations/:organizationId/windows-computer", () =>
      HttpResponse.json({
        ...getGetWindowsComputerResponseMock(),
        available: true,
        control: {
          holder: "human",
          since: "2026-11-20T09:13:41.000Z",
          reason: "taken",
          snapshotRequired: true,
        },
      }),
    ),
  );
  await queryClient.invalidateQueries();
  fireEvent.click(await view.findByRole("button", { name: "Hand back" }));
  await settleReactWork();
  expect(requests).toContain(
    "POST /api/v2/organizations/default/windows-computer/control/release",
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe("");
  expect(keys[0]).not.toBe(keys[1]);
});

test("with no Windows computer for the person, the page says there is none", async () => {
  server.use(
    http.get("*/api/v2/organizations/:organizationId/windows-computer", () =>
      HttpResponse.json(
        {
          type: "https://open.bot/errors/not-found",
          title: "Not found.",
          status: 404,
        },
        {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        },
      ),
    ),
  );
  const view = draw();
  expect(
    await view.findByText("There's no Windows computer set up for you."),
  ).toBeTruthy();
  expect(sockets).toEqual([]);
});

test("the words for who is using it and why it can't be used", () => {
  const mock = getGetWindowsComputerResponseMock();
  expect(
    controlWords({
      ...mock,
      control: { holder: "bot", since: "", snapshotRequired: false },
    }).title,
  ).toBe("Your Bot is using it");
  expect(
    controlWords({
      ...mock,
      control: {
        holder: "human",
        since: "",
        reason: "interference",
        snapshotRequired: true,
      },
    }).description,
  ).toContain("Your Bot stopped when you used the mouse or keyboard");
  expect(
    controlWords({ ...mock, control: null, unavailableReason: "locked" })
      .description,
  ).toBe(unavailableWords("locked"));
  expect(unavailableWords("secure_desktop")).toContain("asking for permission");
  expect(programsFrom(" notepad.exe, excel.exe  mspaint.exe,,")).toEqual([
    "notepad.exe",
    "excel.exe",
    "mspaint.exe",
  ]);
});
