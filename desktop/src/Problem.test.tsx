import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";

let invokeCalls: Array<{ command: string; args?: unknown }> = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return Promise.resolve(null);
  },
}));

const { Failure } = await import("./Problem");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  invokeCalls = [];
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

test("problem_ui_has_no_credential_restore_action", () => {
  const view = render(
    <Failure
      problem={{
        said: "Synthetic credential failure.",
        detail: "synthetic path refusal",
      }}
    />,
  );

  expect(view.getByRole("alert").textContent).toContain(
    "Synthetic credential failure.",
  );
  expect(view.queryByRole("button")).toBeNull();
  expect(invokeCalls).toEqual([]);
});
