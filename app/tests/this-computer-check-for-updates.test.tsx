/**
 * Settings → This computer: Check for updates on the Version row. OpenBot Desktop reads its update
 * feed when asked and says what it found. These tests stand in for the IPC Tauri injects into the
 * Desktop window, answering as the shell's `openbot-desktop` plugin does
 * (desktop/src-tauri/src/desktop_page.rs); the page, its queries and its mutations are the real ones.
 *
 * On Windows there is no menu bar, so this row and the tray are where a person asks.
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
import {
  type DesktopAppUpdate,
  type DesktopAppUpdateCheck,
  type DesktopStatus,
  desktopKeys,
} from "@/lib/desktop/queries";
import { queryClient } from "@/query-client";
import { Route as ThisComputerRoute } from "@/routes/_authed/settings/this-computer";

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
};

let found: DesktopAppUpdateCheck | string;
let offer: DesktopAppUpdate;
let commands: string[];
let installRelease: (() => void) | null;

async function shellInvoke(command: string) {
  commands.push(command);
  switch (command) {
    case "plugin:openbot-desktop|status":
      return STATUS;
    case "plugin:openbot-desktop|update_offer":
      return offer;
    case "plugin:openbot-desktop|check_update":
      // The shell refuses with its own sentence, as a plain string.
      if (typeof found === "string") throw found;
      return found;
    case "plugin:openbot-desktop|install_update":
      offer = {
        ...offer,
        installing: { downloaded: 50, total: 200, restarting: false },
      };
      await new Promise<void>((resolve) => {
        installRelease = resolve;
      });
      return null;
  }
  throw `command ${command} not found`;
}

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  commands = [];
  installRelease = null;
  offer = { version: null, current: "0.3.2", installing: null };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: shellInvoke,
    transformCallback: () => 0,
  };
});
afterEach(() => {
  cleanup();
  installRelease?.();
  queryClient.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

async function checkForUpdates() {
  const Page = ThisComputerRoute.options.component as ComponentType;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await view.findByRole("button", { name: "Check for updates" }),
  );
  return view;
}

test("on the newest release it says this version is up to date", async () => {
  found = { found: "upToDate", current: "0.3.2" };
  const view = await checkForUpdates();
  expect((await view.findByRole("status")).textContent).toBe(
    "OpenBot 0.3.2 is up to date.",
  );
  expect(commands).toContain("plugin:openbot-desktop|check_update");
});

test("a newer version is offered with Update and restart, which installs it", async () => {
  found = { found: "available", version: "0.3.3", current: "0.3.2" };
  const view = await checkForUpdates();
  expect((await view.findByRole("status")).textContent).toBe(
    "OpenBot 0.3.3 is available.",
  );
  fireEvent.click(view.getByRole("button", { name: "Update and restart" }));
  await waitFor(() =>
    expect(commands).toContain("plugin:openbot-desktop|install_update"),
  );
  // The page asks twice a second while it installs. Query timers do not run under happy-dom
  // (TanStack reads the module as server-side), so this is the next of those asks.
  await queryClient.invalidateQueries({ queryKey: desktopKeys.appUpdate });
  await waitFor(() =>
    expect(view.getByRole("button", { name: /Downloading/ }).textContent).toBe(
      "Downloading… 25%",
    ),
  );
});

test("a check that fails says what to do", async () => {
  found =
    "OpenBot couldn't check for updates. Check your internet connection and try again.";
  const view = await checkForUpdates();
  expect((await view.findByRole("alert")).textContent).toBe(
    "OpenBot couldn't check for updates. Check your internet connection and try again.",
  );
  expect(view.getByRole("button", { name: "Check for updates" })).toBeTruthy();
});

test("a build that doesn't update itself says so in plain words", async () => {
  found = { found: "notOffered", current: "0.3.2-internal.731.gabc1234" };
  const view = await checkForUpdates();
  const said = (await view.findByRole("status")).textContent ?? "";
  expect(said).toBe(
    "This version of OpenBot doesn't update itself. Install a released version to get updates.",
  );
  expect(said).not.toMatch(/configured|feature|shell/i);
});
