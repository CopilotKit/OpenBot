import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";

const calls: { command: string; args: unknown }[] = [];
let permitted = true;
let failure: string | null = null;
let shellAvailable = false;
let interrupted: {
  fromVersion: string;
  toVersion: string;
  databaseMayHaveChanged: boolean;
} | null = null;
async function handle(command: string, args: unknown) {
  // Read on every render of the panel; the tests below assert the actions a person takes.
  if (command === "runtime_update_status") return interrupted;
  calls.push({ command, args });
  if (command === "recover_runtime_update") {
    const recovered = {
      version: interrupted?.fromVersion,
      accepted: false,
      databaseRestored: interrupted?.databaseMayHaveChanged ?? false,
    };
    interrupted = null;
    return recovered;
  }
  if (failure) throw failure;
  if (command === "check_shell_update")
    return {
      configured: shellAvailable,
      available: shellAvailable,
      version: shellAvailable ? "0.3.0" : null,
      detail: shellAvailable
        ? "Signed shell update is available."
        : "Signed desktop shell updates are not configured in this build.",
    };
  if (command === "check_runtime_update")
    return {
      allowed: permitted,
      reasons: permitted ? [] : ["wrong distribution"],
      fromVersion: "v0.2.0",
      toVersion: "v0.3.0",
      requiresDowntime: true,
      recovery: "restart-previous",
    };
  return { version: "v0.3.0" };
}
/*
 * The same seam App.test.tsx, Problem.test.tsx and ProviderPicker.test.tsx use. `mockIPC` patches
 * `window.__TAURI_INTERNALS__`, but once any of those files has mocked `@tauri-apps/api/core`, Bun
 * keeps that module mock for the rest of the run and `invoke` never reaches the IPC mock. Mocking
 * the module here as well is what makes this file pass in the whole suite, not only on its own.
 */
mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => handle(command, args),
}));
const { RuntimeUpdates } = await import("./RuntimeUpdates");
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  calls.length = 0;
  permitted = true;
  failure = null;
  shellAvailable = false;
  interrupted = null;
});
afterAll(() => GlobalRegistrator.unregister());
function setup() {
  let applied = 0;
  const view = render(
    createElement(RuntimeUpdates, {
      root: "/customer/openbot",
      onApply: async () => {
        applied++;
        return { version: "v0.3.0" };
      },
    }),
  );
  return { view, applied: () => applied };
}
async function check(view: ReturnType<typeof render>) {
  await userEvent
    .setup({ document: view.container.ownerDocument })
    .type(view.getByLabelText("Release tag"), "v0.3.0");
  fireEvent.click(view.getByRole("button", { name: "Check runtime update" }));
  await waitFor(() =>
    expect(calls.at(-1)?.command).toBe("check_runtime_update"),
  );
}
test("desktop updates are explicit and stage before acknowledged apply", async () => {
  const { view, applied } = setup();
  expect(calls).toEqual([]);
  await check(view);
  fireEvent.click(
    await view.findByRole("button", { name: "Stage runtime update" }),
  );
  const apply = await view.findByRole("button", {
    name: "Apply update and restart",
  });
  expect(apply.hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByRole("checkbox"));
  fireEvent.click(apply);
  await waitFor(() => expect(applied()).toBe(1));
  expect(calls.map((c) => c.command)).toEqual([
    "check_runtime_update",
    "stage_runtime_update",
  ]);
  expect(calls[1]?.args).toEqual({
    root: "/customer/openbot",
    version: "v0.3.0",
  });
  fireEvent.click(
    view.getByRole("button", { name: "Check desktop shell update" }),
  );
  expect(
    await view.findByText(/Signed desktop shell updates are not configured/),
  ).toBeTruthy();
});
test("a refused plan cannot stage or apply and changing target invalidates the plan", async () => {
  permitted = false;
  const { view, applied } = setup();
  await check(view);
  expect(await view.findByText("wrong distribution")).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Stage runtime update" }),
  ).toBeNull();
  expect(applied()).toBe(0);
  await userEvent
    .setup({ document: view.container.ownerDocument })
    .clear(view.getByLabelText("Release tag"));
  await userEvent
    .setup({ document: view.container.ownerDocument })
    .type(view.getByLabelText("Release tag"), "v0.4.0");
  expect(view.queryByText("wrong distribution")).toBeNull();
});
test("baseline verification is a separate explicit action and failures stay visible", async () => {
  const { view } = setup();
  failure = "pinned publisher has no release manifest";
  fireEvent.click(
    view.getByRole("button", { name: "Verify installed release baseline" }),
  );
  expect(await view.findByText(failure)).toBeTruthy();
  expect(calls.map((c) => c.command)).toEqual(["establish_runtime_baseline"]);
});

test("configured shell updates require explicit restart acknowledgment before install", async () => {
  shellAvailable = true;
  const { view } = setup();
  fireEvent.click(
    view.getByRole("button", { name: "Check desktop shell update" }),
  );
  const install = await view.findByRole("button", {
    name: "Install signed desktop update",
  });
  expect(install.hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByRole("checkbox"));
  fireEvent.click(install);
  await waitFor(() => expect(calls.at(-1)?.command).toBe("apply_shell_update"));
  expect(calls.at(-1)?.args).toEqual({
    root: "/customer/openbot",
    version: "0.3.0",
    restartAcknowledged: true,
  });
});

test("an unfinished update offers an explicit restore of the previous release", async () => {
  interrupted = {
    fromVersion: "v0.2.0",
    toVersion: "v0.3.0",
    databaseMayHaveChanged: true,
  };
  const { view } = setup();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("v0.2.0 to v0.3.0 did not finish");
  expect(alert.textContent).toContain("only if the database changed");
  expect(
    view.container
      .querySelector("details.runtime-updates")
      ?.hasAttribute("open"),
  ).toBe(true);
  // Nothing is restored until the person asks.
  expect(calls).toEqual([]);
  fireEvent.click(
    view.getByRole("button", { name: "Restore previous release" }),
  );
  expect(
    await view.findByText(
      "v0.2.0 is back in place, with its database restored. Repair the installation, then start it.",
    ),
  ).toBeTruthy();
  expect(calls).toEqual([
    { command: "recover_runtime_update", args: { root: "/customer/openbot" } },
  ]);
  expect(view.queryByRole("alert")).toBeNull();
});

test("a failed apply shows the restore the native side now requires", async () => {
  const view = render(
    createElement(RuntimeUpdates, {
      root: "/customer/openbot",
      onApply: async () => {
        interrupted = {
          fromVersion: "v0.2.0",
          toVersion: "v0.3.0",
          databaseMayHaveChanged: true,
        };
        throw { said: "The update did not finish starting." };
      },
    }),
  );
  expect(view.queryByRole("alert")).toBeNull();
  await check(view);
  fireEvent.click(
    await view.findByRole("button", { name: "Stage runtime update" }),
  );
  fireEvent.click(await view.findByRole("checkbox"));
  fireEvent.click(
    view.getByRole("button", { name: "Apply update and restart" }),
  );
  expect(
    await view.findByText("The update did not finish starting."),
  ).toBeTruthy();
  expect(
    await view.findByRole("button", { name: "Restore previous release" }),
  ).toBeTruthy();
});
