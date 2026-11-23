import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { FloorStatus } from "./SecurityFloor";
import type { AppUpdate } from "./UpdateOffer";

/*
 * The shell's commands, answered the way main.rs answers them: `security_floor` from the last floor
 * the shell verified, `app_update_offer` from its feed, and `install_app_update` resolving only when
 * it failed (on success the app restarts).
 */
let status: FloorStatus | null = null;
let floorFailure: unknown = null;
let offer: AppUpdate | null = null;
let installFailure: unknown = null;
const calls: string[] = [];

async function handle(command: string) {
  if (command === "security_floor") {
    if (floorFailure) throw floorFailure;
    return status;
  }
  if (command === "app_update_offer") return offer;
  calls.push(command);
  if (command === "install_app_update") {
    if (installFailure) throw installFailure;
    return new Promise(() => {});
  }
  throw new Error(`unexpected command ${command}`);
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string) => handle(command),
}));
const { SecurityFloorGate, isSecurityFloorPage } = await import(
  "./SecurityFloor"
);

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(() => {
  status = null;
  floorFailure = null;
  offer = null;
  installFailure = null;
  calls.length = 0;
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

const update: AppUpdate = {
  version: "1.1.2",
  current: "1.1.1",
  installing: null,
  updatesItself: true,
};

function gated() {
  return render(
    <SecurityFloorGate>
      <p>Setup</p>
    </SecurityFloorGate>,
  );
}

test("below the floor, the notice is the only thing in the window", async () => {
  status = { blocked: true };
  offer = update;
  const view = gated();
  await waitFor(() =>
    expect(
      view.getByRole("heading", {
        name: "This version of OpenBot has a security problem.",
      }),
    ).toBeTruthy(),
  );
  expect(view.getByText("Update to keep using it.")).toBeTruthy();
  expect(view.queryByText("Setup")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Update and restart" }));
  await waitFor(() => expect(calls).toEqual(["install_app_update"]));
});

test("at or above the floor, or where it doesn't apply, the window is as it was", async () => {
  status = { blocked: false };
  const view = gated();
  await waitFor(() => expect(view.getByText("Setup")).toBeTruthy());
  expect(view.queryByRole("heading")).toBeNull();
});

test("a shell from before the floor shows the window as it was", async () => {
  floorFailure = "command security_floor not found";
  const view = gated();
  await waitFor(() => expect(view.getByText("Setup")).toBeTruthy());
});

test("nothing is drawn before the shell answers, so setup never starts behind the notice", async () => {
  status = { blocked: true };
  const view = gated();
  expect(view.container.textContent).toBe("");
  await waitFor(() => expect(view.getByRole("heading")).toBeTruthy());
  expect(view.queryByText("Setup")).toBeNull();
});

test("a failed install says so, and Update and restart can be tried again", async () => {
  status = { blocked: true };
  offer = update;
  installFailure = "the download stopped";
  const view = gated();
  const button = await waitFor(() =>
    view.getByRole("button", { name: "Update and restart" }),
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain(
      "the download stopped",
    ),
  );
  expect(
    view
      .getByRole("button", { name: "Update and restart" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("a build that never updates itself says how to get one that does", async () => {
  status = { blocked: true };
  offer = { ...update, version: null, updatesItself: false };
  const view = gated();
  await waitFor(() =>
    expect(view.getByText(/doesn't update itself/)).toBeTruthy(),
  );
  expect(view.queryByRole("button")).toBeNull();
});

test("the native side opens the notice alone on its own fragment", () => {
  expect(isSecurityFloorPage("#security-floor")).toBe(true);
  expect(isSecurityFloorPage("#shutting-down")).toBe(false);
});
