import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { waitFor, within } from "@testing-library/react";

/*
 * FOUND ON 1.2.0-rc.3, a Mac, after an update: the setup window stayed a plain ground with nothing
 * on it, across two launches, while the page's code was still running. A screen that fails to draw
 * took every screen with it (there was no error boundary) and nothing reached the log.
 *
 * The whole window as `main.tsx` mounts it, with the shell scripted: the update offer beside setup
 * is handed an answer it can't draw (this app's version as an object), as any screen might be.
 */

const calls: Array<{ command: string; args?: unknown }> = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    calls.push({ command, args });
    if (command === "app_update_offer")
      return {
        version: "1.3.0",
        current: { broken: true },
        installing: null,
        updatesItself: true,
      };
    return null;
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));

mock.module("./Mark", () => ({
  Mark: ({ name }: { name: string }) => <span>{name}</span>,
  ButtonMark: () => null,
  MarkImage: ({ id, name }: { id: string; name: string }) => (
    <img alt={name} data-mark={id} />
  ),
}));

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
document.body.innerHTML = '<div id="root"></div>';
const root = document.getElementById("root") as HTMLElement;

await import("./main");
const { shownNow } = await import("./heartbeat");

const reported = () =>
  calls
    .filter((call) => call.command === "page_error")
    .map((call) => call.args as { kind: string; message: string });

test("a screen that fails to draw shows OpenBot hit a problem, with Reload and the logs, and tells the log", async () => {
  const view = within(root);
  await view.findByRole(
    "heading",
    { name: "OpenBot hit a problem" },
    { timeout: 5_000 },
  );
  expect(root.textContent).toContain(
    "This window stopped working. Reload it to carry on.",
  );
  expect(view.getByRole("button", { name: "Reload" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Copy logs" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Save to a file" })).toBeTruthy();
  await waitFor(() =>
    expect(reported()).toContainEqual(
      expect.objectContaining({
        kind: "screen failed to draw",
        message: expect.stringContaining(
          "Objects are not valid as a React child",
        ),
      }),
    ),
  );
  // The heartbeat says what is on screen: this sheet, drawn.
  expect(shownNow()).toEqual({
    screen: "OpenBot hit a problem",
    drawn: true,
  });
});

test("uncaught errors and unhandled rejections go to the log, once each", async () => {
  const error = new Error("the window's code broke");
  window.dispatchEvent(
    new ErrorEvent("error", { error, message: error.message }),
  );
  window.dispatchEvent(
    new ErrorEvent("error", { error, message: error.message }),
  );
  const rejection = new Event("unhandledrejection") as Event & {
    reason?: unknown;
  };
  rejection.reason = { said: "OpenBot couldn't reach its server." };
  window.dispatchEvent(rejection);
  const ours = reported().filter(
    (call) => call.kind !== "screen failed to draw",
  );
  expect(ours).toEqual([
    expect.objectContaining({
      kind: "uncaught error",
      message: "Error: the window's code broke",
    }),
    expect.objectContaining({
      kind: "unhandled rejection",
      message: "OpenBot couldn't reach its server.",
    }),
  ]);
});

test("a window with nothing drawn says so in its heartbeat", () => {
  // A window whose page drew only the ground behind its screens.
  root.id = "drawn";
  const blank = document.createElement("div");
  blank.id = "root";
  blank.innerHTML = '<div class="backdrop" aria-hidden="true"></div>';
  document.body.append(blank);
  try {
    expect(shownNow()).toEqual({ screen: null, drawn: false });
  } finally {
    blank.remove();
    root.id = "root";
  }
});
