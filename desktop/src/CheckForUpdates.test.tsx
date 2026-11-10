import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Checked } from "./CheckForUpdates";
import type { AppUpdate } from "./UpdateOffer";

/*
 * The shell's commands, answered the way main.rs answers them: `check_app_update` reads the update
 * feed and says what it found, `install_app_update` resolves only when it failed (on success the
 * app restarts), and `app_update_offer` reports an install's progress.
 */
let checked: Checked | null = null;
let checkFailure: unknown = null;
let installFailure: unknown = null;
let progress: AppUpdate["installing"] = null;
let updatesItself = true;
let ready: AppUpdate["ready"] = null;
let installRelease: (() => void) | null = null;
const calls: string[] = [];

async function handle(command: string) {
  calls.push(command);
  if (command === "check_app_update") {
    if (checkFailure) throw checkFailure;
    return checked;
  }
  if (command === "app_update_offer") {
    return {
      version: "0.3.3",
      current: "0.3.2",
      installing: progress,
      updatesItself,
      ready,
    };
  }
  if (command === "install_app_update") {
    if (installFailure) throw installFailure;
    await new Promise<void>((resolve) => {
      installRelease = resolve;
    });
    return null;
  }
  throw new Error(`unexpected command ${command}`);
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string) => handle(command),
}));
const { CheckForUpdates } = await import("./CheckForUpdates");

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(() => {
  checked = null;
  checkFailure = null;
  installFailure = null;
  progress = null;
  updatesItself = true;
  ready = null;
  installRelease?.();
  installRelease = null;
  calls.length = 0;
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

async function check() {
  const view = render(<CheckForUpdates />);
  // The shell has said this build updates itself before anybody clicks.
  await view.findByText(/^OpenBot updates itself/);
  fireEvent.click(view.getByRole("button", { name: "Check for updates" }));
  return view;
}

test("the feed isn't read until somebody checks", async () => {
  const view = render(<CheckForUpdates />);
  await view.findByText(/^OpenBot updates itself/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toEqual(["app_update_offer"]);
});

test("a build that updates itself says so up front and offers the check", async () => {
  const view = render(<CheckForUpdates />);
  await view.findByText(
    "OpenBot updates itself with signed updates from its publisher. The next Start after an update brings this installation to the same version and keeps your data.",
  );
  expect(view.getByRole("button", { name: "Check for updates" })).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/doesn't update itself/);
});

/*
 * The bug, on an internal build on Windows: the section opened with "OpenBot updates itself with
 * signed updates from its publisher", and Check for updates then said "This version of OpenBot
 * doesn't update itself" in the same box.
 */
test("a build that never updates itself says so up front and promises no updates", async () => {
  updatesItself = false;
  const view = render(<CheckForUpdates />);
  await view.findByText(
    "This version of OpenBot doesn't update itself. Install a released version of OpenBot to get updates.",
  );
  expect(view.container.textContent).not.toMatch(
    /updates itself with|signed updates|after an update/,
  );
  expect(view.queryByRole("button", { name: "Check for updates" })).toBeNull();
  expect(calls).toEqual(["app_update_offer"]);
});

test("on the newest release it says this version is up to date", async () => {
  checked = { found: "upToDate", current: "0.3.2" };
  const view = await check();
  expect((await view.findByRole("status")).textContent).toBe(
    "OpenBot 0.3.2 is up to date.",
  );
  expect(calls).toEqual(["app_update_offer", "check_app_update"]);
  expect(view.container.textContent).not.toMatch(/configured|shell/i);
});

test("a newer version is offered with Update and restart, which installs it", async () => {
  checked = { found: "available", version: "0.3.3", current: "0.3.2" };
  const view = await check();
  expect((await view.findByRole("status")).textContent).toBe(
    "OpenBot 0.3.3 is available. You are running 0.3.2.",
  );
  fireEvent.click(view.getByRole("button", { name: "Update and restart" }));
  await waitFor(() => expect(calls).toContain("install_app_update"));
  progress = { downloaded: 50, total: 200, restarting: false };
  await waitFor(() =>
    expect(view.getByRole("button", { name: /Downloading/ }).textContent).toBe(
      "Downloading… 25%",
    ),
  );
  expect(
    (
      view.getByRole("button", {
        name: "Check for updates",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("an install that fails says so and offers it again", async () => {
  checked = { found: "available", version: "0.3.3", current: "0.3.2" };
  installFailure = { said: "signature verification failed" };
  const view = await check();
  fireEvent.click(
    await view.findByRole("button", { name: "Update and restart" }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "OpenBot could not install the update: signature verification failed",
  );
  expect(view.getByRole("button", { name: "Update and restart" })).toBeTruthy();
});

test("a build without the updater says so in plain words", async () => {
  checked = { found: "notOffered", current: "0.3.2-internal.731.gabc1234" };
  const view = await check();
  expect((await view.findByRole("status")).textContent).toBe(
    "This version of OpenBot doesn't update itself. Install a released version of OpenBot to get updates.",
  );
  expect(view.container.textContent).not.toMatch(/configured|feature|shell/i);
  expect(view.queryByRole("button", { name: "Update and restart" })).toBeNull();
});

test("a check that fails says what to do, and can be tried again", async () => {
  checkFailure = {
    said: "OpenBot couldn't check for updates. Check your internet connection and try again.",
    detail: "https://downloads.copilotkit.ai/latest/latest.json: timed out",
  };
  const view = await check();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(
    "OpenBot couldn't check for updates. Check your internet connection and try again.",
  );
  checkFailure = null;
  checked = { found: "upToDate", current: "0.3.2" };
  fireEvent.click(view.getByRole("button", { name: "Check for updates" }));
  expect((await view.findByRole("status")).textContent).toBe(
    "OpenBot 0.3.2 is up to date.",
  );
  expect(view.queryByRole("alert")).toBeNull();
});

test("while an update downloads it says so", async () => {
  checked = { found: "installing", version: "0.3.3", current: "0.3.2" };
  const view = await check();
  expect((await view.findByRole("status")).textContent).toBe(
    "OpenBot is downloading 0.3.3 and restarts when it's done.",
  );
});

test("a newer version says it is downloading in the background, then that it is ready to install", async () => {
  checked = {
    found: "available",
    version: "0.3.3",
    current: "0.3.2",
    ready: { state: "preparing", done: 250, total: 1000 },
  };
  const view = await check();
  expect((await view.findByRole("status")).textContent).toBe(
    "OpenBot 0.3.3 is downloading in the background (25%). You are running 0.3.2.",
  );
  // Update and restart does not wait for it.
  expect(view.getByRole("button", { name: "Update and restart" })).toBeTruthy();
  // It goes on getting ready after the check, and the section asks again until it is.
  ready = { state: "ready" };
  await waitFor(
    () =>
      expect(view.getByRole("status").textContent).toBe(
        "OpenBot 0.3.3 is ready to install. It takes a few minutes. You are running 0.3.2.",
      ),
    { timeout: 7_000 },
  );
}, 10_000);
