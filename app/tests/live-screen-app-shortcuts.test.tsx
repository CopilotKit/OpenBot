import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { LiveScreen } from "@/components/computer/live-screen";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { useState } from "react";
import { AppHotkeys } from "@/lib/hotkeys/app-hotkeys";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";

/**
 * The app's own shortcuts while a person drives a Bot's browser.
 *
 * Every keystroke typed into the screen then belongs to the Bot's browser: LiveScreen forwards it and prevents its
 * default. The app's shortcuts listen on the same window, and they were bound first, when the signed-in app mounted, so
 * they saw each keystroke before LiveScreen did and acted on it as well. Typing a capital N into a page, "New York" in a
 * search box, started a new chat and took the person away from the Bot mid-word; Ctrl+B, bold in a document, showed or
 * hid the sidebar here as well.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
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

let originalWebSocket: typeof WebSocket;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
});

afterEach(() => {
  cleanup();
  SocketDouble.latest = undefined;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** Counts what reaches the Search and jump shortcut, as the command menu listens for it. */
function MenuShortcut() {
  const [opened, setOpened] = useState(0);
  useHotkey("command-menu", () => setOpened((count) => count + 1));
  return <span data-testid="menu-shortcut">{opened}</span>;
}

function SidebarState() {
  return <output>{useSidebar().open ? "open" : "closed"}</output>;
}

/** The signed-in shell's shortcuts and sidebar, around a conversation showing a Bot's screen. */
async function renderDriving(driving: boolean) {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <AppHotkeys />
        <MenuShortcut />
        <SidebarState />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const conversation = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <LiveScreen computerId="shortcut-test" driving={driving} />
    ),
  });
  const newChat = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/new",
    component: () => <p>New chat</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([conversation, newChat]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(<RouterProvider router={router} />);
  await waitFor(() =>
    expect(view.container.querySelector("canvas")).not.toBeNull(),
  );
  if (driving) await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
  if (driving) {
    // The person clicked the screen to type into the page on it, which gives the screen the keyboard.
    await waitFor(() => expect(canvas.dataset.connected).toBe("true"));
    canvas.focus();
  }
  return {
    router,
    sidebar: () => view.container.querySelector("output")?.textContent,
    menuOpens: () =>
      view.container.querySelector('[data-testid="menu-shortcut"]')
        ?.textContent,
    /** A keystroke where the browser sends one: at the screen while it has the focus, else at the body. */
    press(init: KeyboardEventInit) {
      act(() => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", {
            ...init,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
  };
}

test("a capital N typed into the Bot's browser goes to it, and does not start a new chat", async () => {
  const screen = await renderDriving(true);

  screen.press({ key: "N", code: "KeyN", keyCode: 78, shiftKey: true });
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(screen.router.state.location.pathname).toBe("/");
  expect(SocketDouble.latest?.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "N",
      code: "KeyN",
      text: "N",
      windowsVirtualKeyCode: 78,
      modifiers: 8,
    },
  ]);
});

test("Ctrl+B typed into the Bot's browser goes to it, and leaves the sidebar alone", async () => {
  const screen = await renderDriving(true);

  screen.press({ key: "b", code: "KeyB", keyCode: 66, ctrlKey: true });

  expect(screen.sidebar()).toBe("open");
  expect(SocketDouble.latest?.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "b",
      code: "KeyB",
      text: "b",
      windowsVirtualKeyCode: 66,
      modifiers: 2,
    },
  ]);
});

test("the same shortcuts still work while nobody is driving", async () => {
  const screen = await renderDriving(false);

  screen.press({ key: "b", code: "KeyB", keyCode: 66, ctrlKey: true });
  expect(screen.sidebar()).toBe("closed");

  screen.press({ key: "N", code: "KeyN", keyCode: 78, shiftKey: true });
  await waitFor(() =>
    expect(screen.router.state.location.pathname).toBe("/channel/new"),
  );
});

test("Ctrl+K and Cmd+K typed into the Bot's browser go to it, and open no Search and jump", async () => {
  const screen = await renderDriving(true);

  screen.press({ key: "k", code: "KeyK", keyCode: 75, ctrlKey: true });
  screen.press({ key: "k", code: "KeyK", keyCode: 75, metaKey: true });

  expect(screen.menuOpens()).toBe("0");
  expect(SocketDouble.latest?.sent.map((message) => message.key)).toEqual([
    "k",
    "k",
  ]);
});

test("Search and jump's shortcut still works while nobody is driving", async () => {
  const screen = await renderDriving(false);
  screen.press({ key: "k", code: "KeyK", keyCode: 75, ctrlKey: true });
  screen.press({ key: "k", code: "KeyK", keyCode: 75, metaKey: true });
  // One of the two is this platform's; the other has the wrong modifier and is ignored.
  expect(screen.menuOpens()).toBe("1");
});
