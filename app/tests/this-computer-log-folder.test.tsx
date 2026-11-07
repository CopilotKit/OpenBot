/**
 * Settings → This computer: the Logs row and Open log folder. OpenBot Desktop writes a log file on
 * this computer, and this is how a person finds it to share it. These tests stand in for the IPC
 * Tauri injects into the Desktop window, answering as the shell's `openbot-desktop` plugin does
 * (desktop/src-tauri/src/desktop_page.rs: `status` and `open_logs`); the page, its queries and its
 * mutations are the real ones. The opener is the stub: it records the call instead of opening a
 * file manager.
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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import type { DesktopStatus } from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";
import { Route as ThisComputerRoute } from "@/routes/_authed/settings/this-computer";

const LOG_FOLDER =
  "C:\\Users\\Administrator\\AppData\\Local\\ai.copilotkit.openbot.desktop\\logs";

const STATUS: DesktopStatus = {
  openbotRunning: true,
  openbotHeld: true,
  processes: [],
  containers: [],
  intelligenceStack: null,
  intelligenceContainers: [],
  engine: "docker",
  root: "C:\\Users\\Administrator\\OpenBot",
  appPort: 3010,
  version: "0.3.2",
  build: "v0.3.2 (b214c97e)",
  logFolder: LOG_FOLDER,
};

let status: DesktopStatus;
let calls: { command: string; args?: Record<string, unknown> }[];
let opened: string[];
let openFails: boolean;

async function shellInvoke(command: string, args?: Record<string, unknown>) {
  calls.push({ command, args });
  switch (command) {
    case "plugin:openbot-desktop|status":
      return status;
    case "plugin:openbot-desktop|update_offer":
      return { version: null, current: "0.3.2", installing: null };
    case "plugin:openbot-desktop|open_logs":
      // The shell opens its own log folder; the page names none.
      if (openFails) throw "no file manager answered";
      opened.push(status.logFolder ?? "");
      return null;
  }
  throw `command ${command} not found`;
}

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  status = STATUS;
  calls = [];
  opened = [];
  openFails = false;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: shellInvoke,
    transformCallback: () => 0,
  };
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

function renderPage() {
  const Page = ThisComputerRoute.options.component as ComponentType;
  return render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
}

test("Open log folder opens the desktop app's log folder", async () => {
  const view = renderPage();
  fireEvent.click(await view.findByRole("button", { name: "Open log folder" }));
  await waitFor(() => expect(opened).toEqual([LOG_FOLDER]));
  // The page asks; it never hands the desktop app a path to open.
  expect(
    calls.filter((call) => call.command === "plugin:openbot-desktop|open_logs"),
  ).toEqual([{ command: "plugin:openbot-desktop|open_logs" }]);
  expect(view.getByText(LOG_FOLDER)).toBeTruthy();
  expect(
    view.getByText(
      "Logs stay on this computer and leave out your keys and messages. Share them when you ask for help.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
});

test("a folder that couldn't be opened says where to find it", async () => {
  openFails = true;
  const view = renderPage();
  fireEvent.click(await view.findByRole("button", { name: "Open log folder" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't open the log folder. Find it at the path above.",
  );
  expect(view.getByText(LOG_FOLDER)).toBeTruthy();
});

test("a desktop app older than the log offers no Open log folder", async () => {
  const { logFolder: _, ...older } = STATUS;
  status = older;
  const view = renderPage();
  await view.findByText("Installed in");
  expect(view.queryByRole("button", { name: "Open log folder" })).toBeNull();
  expect(view.queryByText("Logs")).toBeNull();
});
