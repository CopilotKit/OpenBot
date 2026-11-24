/**
 * Settings → General → Appearance's Compact view: OpenBot Desktop shows OpenBot as a small bubble
 * over the person's other apps, in place of its window.
 *
 * These tests stand in for the IPC Tauri injects into the Desktop window, answering as the shell's
 * `openbot-desktop` plugin does (desktop/src-tauri/src/desktop_page.rs: `compact_view` and
 * `set_compact_view`; what switching does to the windows is in desktop/src-tauri/src/assistant.rs).
 * The General page, its query and its mutation are the real ones.
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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import type { DesktopCompactView } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";
import { Route as GeneralRoute } from "@/routes/_authed/settings/index";
import { settleReactWork } from "./settle-react-work";

let compactView: DesktopCompactView;
let calls: { command: string; args?: unknown }[];

async function shellInvoke(command: string, args?: Record<string, unknown>) {
  calls.push({ command, args });
  switch (command) {
    case "plugin:openbot-desktop|compact_view":
      return compactView;
    case "plugin:openbot-desktop|set_compact_view":
      compactView = { ...compactView, on: args?.on === true };
      return compactView;
  }
  throw `command ${command} not found`;
}

const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  calls = [];
  compactView = { on: false, available: true };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: shellInvoke,
    transformCallback: () => 0,
  };
  // The page's other rows read the server; none of them is under test here.
  global.fetch = Object.assign(
    async () => new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function renderGeneral() {
  const Page = GeneralRoute.options.component as ComponentType;
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Page />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

test("Compact view says what it does, and switching it asks the desktop app at once", async () => {
  const view = renderGeneral();
  const toggle = await view.findByRole("switch", { name: "Compact view" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(
    view.getByText(
      /OpenBot shows as a small bubble over your other apps, in place of this window\. Drag it anywhere, and click it to open your conversations\./,
    ),
  ).toBeTruthy();
  await userEvent.click(toggle);
  await waitFor(() =>
    expect(calls).toContainEqual({
      command: "plugin:openbot-desktop|set_compact_view",
      args: { on: true },
    }),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "Compact view" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("a computer that can't have it, such as one showing another computer's OpenBot, draws no row", async () => {
  compactView = { on: false, available: false };
  const view = renderGeneral();
  await view.findByRole("heading", { name: "Appearance" });
  await waitFor(() =>
    expect(calls.map((call) => call.command)).toContain(
      "plugin:openbot-desktop|compact_view",
    ),
  );
  expect(view.queryByRole("switch", { name: "Compact view" })).toBeNull();
});

test("a desktop app without the command, and a browser, draw no row", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      calls.push({ command });
      throw `command ${command} not found`;
    },
    transformCallback: () => 0,
  };
  const older = renderGeneral();
  await older.findByRole("heading", { name: "Appearance" });
  await waitFor(() =>
    expect(calls.map((call) => call.command)).toContain(
      "plugin:openbot-desktop|compact_view",
    ),
  );
  expect(older.queryByRole("switch", { name: "Compact view" })).toBeNull();
  cleanup();
  queryClient.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  const browser = renderGeneral();
  await browser.findByRole("heading", { name: "Appearance" });
  expect(browser.queryByRole("switch", { name: "Compact view" })).toBeNull();
});
