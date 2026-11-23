/**
 * Compact view's page (`/assistant`), shown in OpenBot Desktop's bubble window: a click on the orb
 * opens the panel, a press that moves drags the window instead, Minimize folds the panel back, and
 * so does the desktop app on its own (Close Window, Open full window), which it says with a DOM event.
 *
 * These tests stand in for the IPC Tauri injects into that window, answering as the shell does
 * (desktop/src-tauri/src/desktop_page.rs: `assistant_layout`, `assistant_expand`,
 * `assistant_collapse`; the window's sizes and places are tested in
 * desktop/src-tauri/src/assistant.rs). The page, its queries and its mutations are the real ones.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ASSISTANT_LAYOUT_EVENT } from "@/lib/desktop/assistant";
import type { AssistantLayout } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";
import { Route as AssistantRoute } from "@/routes/_authed/assistant";
import { CONVERSATIONS_PATH, conversationPage } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

let layout: AssistantLayout;
let calls: string[];

async function shellInvoke(command: string) {
  calls.push(command);
  switch (command) {
    case "plugin:openbot-desktop|assistant_layout":
      return layout;
    case "plugin:openbot-desktop|assistant_expand":
      layout = { ...layout, expanded: true };
      return layout;
    case "plugin:openbot-desktop|assistant_collapse":
      layout = { ...layout, expanded: false };
      return layout;
    case "plugin:window|start_dragging":
      return null;
  }
  throw `command ${command} not found`;
}

/** The roster's socket, which the page opens: it never says anything here. */
class QuietSocket extends EventTarget {
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const originalFetch = global.fetch;
let originalWebSocket: typeof WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" });
  // prompt-area positions its menus at a caret with a non-empty box.
  Range.prototype.getBoundingClientRect = () => new DOMRect(8, 8, 1, 16);
});
beforeEach(() => {
  calls = [];
  layout = { expanded: false, corner: "bottom-right" };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: shellInvoke,
    transformCallback: () => 0,
  };
  originalWebSocket = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = QuietSocket;
  // No conversations yet; nothing else the page reads is under test here.
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://127.0.0.1:3010/",
      );
      if (url.pathname === CONVERSATIONS_PATH)
        return Response.json(conversationPage([]));
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function renderAssistant() {
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/assistant",
      validateSearch: AssistantRoute.options.validateSearch,
      component: AssistantRoute.options.component,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/assistant"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("a click on the bubble opens the panel, with a box to start a conversation", async () => {
  const view = renderAssistant();
  const bubble = await view.findByRole("button", {
    name: "Open conversations",
  });
  // The panel is there, folded: a Bot's turn in it keeps running while it is a bubble.
  expect(view.queryByRole("button", { name: "Minimize" })).toBeNull();
  fireEvent.pointerDown(bubble, { button: 0, screenX: 40, screenY: 40 });
  fireEvent.pointerUp(bubble, { button: 0, screenX: 40, screenY: 40 });
  await waitFor(() =>
    expect(calls).toContain("plugin:openbot-desktop|assistant_expand"),
  );
  expect(await view.findByRole("button", { name: "Minimize" })).toBeTruthy();
  expect(view.getByText("What can I help with?")).toBeTruthy();
  expect(view.getByText(/No conversations yet/)).toBeTruthy();
  expect(view.queryByRole("button", { name: "Open conversations" })).toBeNull();
  expect(calls).not.toContain("plugin:window|start_dragging");
});

test("a press that moves drags the window, and does not open the panel", async () => {
  const view = renderAssistant();
  const bubble = await view.findByRole("button", {
    name: "Open conversations",
  });
  fireEvent.pointerDown(bubble, { button: 0, screenX: 40, screenY: 40 });
  // A tremble is still a click…
  fireEvent.pointerMove(bubble, { buttons: 1, screenX: 41, screenY: 41 });
  expect(calls).not.toContain("plugin:window|start_dragging");
  // …a move is a drag, handed to the system once.
  fireEvent.pointerMove(bubble, { buttons: 1, screenX: 60, screenY: 44 });
  fireEvent.pointerMove(bubble, { buttons: 1, screenX: 90, screenY: 50 });
  fireEvent.pointerUp(bubble, { button: 0, screenX: 90, screenY: 50 });
  await waitFor(() => expect(calls).toContain("plugin:window|start_dragging"));
  expect(
    calls.filter((call) => call === "plugin:window|start_dragging"),
  ).toHaveLength(1);
  expect(calls).not.toContain("plugin:openbot-desktop|assistant_expand");
});

test("Minimize folds the panel into the bubble, and so does the desktop app on its own", async () => {
  layout = { expanded: true, corner: "bottom-right" };
  const view = renderAssistant();
  await userEvent.click(await view.findByRole("button", { name: "Minimize" }));
  await waitFor(() =>
    expect(calls).toContain("plugin:openbot-desktop|assistant_collapse"),
  );
  expect(
    await view.findByRole("button", { name: "Open conversations" }),
  ).toBeTruthy();

  // Opened again, then folded by the desktop app (Close Window): it says so with an event.
  fireEvent.pointerDown(
    view.getByRole("button", { name: "Open conversations" }),
    { button: 0 },
  );
  fireEvent.pointerUp(
    view.getByRole("button", { name: "Open conversations" }),
    { button: 0 },
  );
  await view.findByRole("button", { name: "Minimize" });
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ASSISTANT_LAYOUT_EVENT, {
        detail: { expanded: false, corner: "bottom-right" },
      }),
    );
  });
  expect(
    await view.findByRole("button", { name: "Open conversations" }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Minimize" })).toBeNull();
});

test("in a browser the page is the panel, with nothing to fold", async () => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  const view = renderAssistant();
  expect(await view.findByText("What can I help with?")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Open conversations" })).toBeNull();
  expect(view.queryByRole("button", { name: "Minimize" })).toBeNull();
  expect(view.getByRole("button", { name: "New conversation" })).toBeTruthy();
});
