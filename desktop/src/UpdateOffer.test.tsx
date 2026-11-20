import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AppUpdate } from "./UpdateOffer";

/*
 * The shell's three commands, answered the way main.rs answers them: `app_update_offer` from what
 * the shell last read in its feed, `dismiss_app_update` remembering the version, and
 * `install_app_update` resolving only when it failed (on success the app restarts).
 */
let offer: AppUpdate | null = null;
let offerFailure: unknown = null;
let installFailure: unknown = null;
let dismissFailure: unknown = null;
let installRelease: (() => void) | null = null;
const calls: { command: string; args: unknown }[] = [];

async function handle(command: string, args: unknown) {
  if (command === "app_update_offer") {
    if (offerFailure) throw offerFailure;
    return offer;
  }
  calls.push({ command, args });
  if (command === "dismiss_app_update") {
    if (dismissFailure) throw dismissFailure;
    if (offer) offer = { ...offer, version: null };
    return null;
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

// The seam App.test.tsx and the other desktop tests use; see RuntimeUpdates.test.tsx.
mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => handle(command, args),
}));
const { UpdateOffer, describe } = await import("./UpdateOffer");

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(() => {
  offer = null;
  offerFailure = null;
  installFailure = null;
  dismissFailure = null;
  installRelease?.();
  installRelease = null;
  calls.length = 0;
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

function available(version = "0.3.2"): AppUpdate {
  return { version, current: "0.3.1", installing: null, updatesItself: true };
}

test("a shell with nothing to say says nothing", async () => {
  offerFailure = "plugin not found";
  const view = render(<UpdateOffer />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.container.textContent).toBe("");
  expect(view.queryByRole("alert")).toBeNull();
});

test("no newer version, or one already closed, says nothing", async () => {
  offer = {
    version: null,
    current: "0.3.1",
    installing: null,
    updatesItself: true,
  };
  const view = render(<UpdateOffer />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.container.textContent).toBe("");
});

test("a newer version is offered with both versions named", async () => {
  offer = available();
  const view = render(<UpdateOffer />);
  expect(
    await view.findByRole("heading", { name: "OpenBot 0.3.2 is available" }),
  ).toBeTruthy();
  expect(view.container.textContent).toContain("You are running 0.3.1");
});

test("while the new version downloads in the background it says how far, then that it is ready", async () => {
  offer = {
    ...available(),
    ready: { state: "preparing", done: 600, total: 1000 },
  };
  const view = render(<UpdateOffer />);
  expect(
    await view.findByRole("heading", { name: "OpenBot 0.3.2 is available" }),
  ).toBeTruthy();
  expect(view.container.textContent).toContain(
    "You are running 0.3.1. OpenBot is downloading it in the background (60%).",
  );
  // Nothing waits for it.
  expect(view.getByRole("button", { name: "Update and restart" })).toBeTruthy();
  offer = { ...available(), ready: { state: "ready" } };
  expect(
    await view.findByRole(
      "heading",
      { name: "OpenBot 0.3.2 is ready to install" },
      { timeout: 7_000 },
    ),
  ).toBeTruthy();
  expect(view.container.textContent).toContain(
    "You are running 0.3.1. Installing it takes a few minutes and restarts OpenBot.",
  );
}, 10_000);

test("installing asks the shell, and shows the shell's progress until it restarts", async () => {
  offer = available();
  const view = render(<UpdateOffer />);
  fireEvent.click(
    await view.findByRole("button", { name: "Update and restart" }),
  );
  await waitFor(() =>
    expect(calls).toEqual([{ command: "install_app_update", args: undefined }]),
  );
  offer = {
    ...available(),
    installing: { downloaded: 50, total: 200, restarting: false },
  };
  await waitFor(() =>
    expect(view.getByRole("button", { name: /Downloading/ }).textContent).toBe(
      "Downloading… 25%",
    ),
  );
  offer = {
    ...available(),
    installing: { downloaded: 200, total: 200, restarting: true },
  };
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Restarting…" })).toBeTruthy(),
  );
  expect(
    (view.getByRole("button", { name: "Not now" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("an install that fails says so and offers it again", async () => {
  offer = available();
  installFailure = { said: "signature verification failed" };
  const view = render(<UpdateOffer />);
  fireEvent.click(
    await view.findByRole("button", { name: "Update and restart" }),
  );
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "OpenBot could not install the update: signature verification failed",
  );
  expect(view.getByRole("button", { name: "Update and restart" })).toBeTruthy();
});

test("Not now closes it and asks the shell to remember which version", async () => {
  offer = available();
  const view = render(<UpdateOffer />);
  fireEvent.click(await view.findByRole("button", { name: "Not now" }));
  await waitFor(() => expect(view.container.textContent).toBe(""));
  expect(calls).toEqual([
    { command: "dismiss_app_update", args: { version: "0.3.2" } },
  ]);
});

test("Not now still closes it for this run when the shell could not remember it", async () => {
  offer = available();
  dismissFailure = { said: "read-only disk" };
  const view = render(<UpdateOffer />);
  fireEvent.click(await view.findByRole("button", { name: "Not now" }));
  await waitFor(() => expect(view.container.textContent).toBe(""));
  // The shell still offers it; this window does not, until a newer one.
  expect(offer?.version).toBe("0.3.2");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(view.container.textContent).toBe("");
});

test("progress reads as a person would say it", () => {
  expect(describe(null)).toBe("Downloading…");
  expect(describe({ downloaded: 0, total: null, restarting: false })).toBe(
    "Downloading…",
  );
  expect(describe({ downloaded: 199, total: 200, restarting: false })).toBe(
    "Downloading… 100%",
  );
  expect(describe({ downloaded: 200, total: 200, restarting: true })).toBe(
    "Restarting…",
  );
});
