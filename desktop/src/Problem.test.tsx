import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let invokeFailure: string | null = null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    if (invokeFailure) return Promise.reject(invokeFailure);
    return Promise.resolve(null);
  },
}));

const { Failure, InlineFailure } = await import("./Problem");

const previousSupportUrl = process.env.VITE_OPENBOT_SUPPORT_URL;

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(() => {
  invokeCalls = [];
  invokeFailure = null;
  if (previousSupportUrl === undefined)
    delete process.env.VITE_OPENBOT_SUPPORT_URL;
  else process.env.VITE_OPENBOT_SUPPORT_URL = previousSupportUrl;
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

for (const Component of [Failure, InlineFailure]) {
  test(`${Component.name} offers external setup help without including error data`, () => {
    delete process.env.VITE_OPENBOT_SUPPORT_URL;
    const view = render(
      <Component
        problem={{
          said: "Synthetic start failure for private-user@example.test.",
          detail: "API_KEY=synthetic-private-key /Users/private-user/install",
        }}
      />,
    );
    const help = view.getByRole("link", { name: "Get setup help" });
    expect(help.getAttribute("href")).toBe(
      "https://github.com/CopilotKit/OpenBot/issues/new/choose",
    );
    expect(help.getAttribute("target")).toBe("_blank");
    expect(help.getAttribute("rel")).toBe("noreferrer");
    expect(invokeCalls).toEqual([]);
    fireEvent.click(help);
    expect(invokeCalls).toEqual([
      {
        command: "plugin:opener|open_url",
        args: {
          url: "https://github.com/CopilotKit/OpenBot/issues/new/choose",
        },
      },
    ]);
  });
}

test("setup help honors a branded support URL", () => {
  process.env.VITE_OPENBOT_SUPPORT_URL = "https://support.example.test/openbot";
  const view = render(<Failure problem={{ said: "Synthetic failure." }} />);
  expect(
    view.getByRole("link", { name: "Get setup help" }).getAttribute("href"),
  ).toBe("https://support.example.test/openbot");
  fireEvent.click(view.getByRole("link", { name: "Get setup help" }));
  expect(invokeCalls).toEqual([
    {
      command: "plugin:opener|open_url",
      args: { url: "https://support.example.test/openbot" },
    },
  ]);
});

test("setup help reports a failed browser open and allows retry", async () => {
  delete process.env.VITE_OPENBOT_SUPPORT_URL;
  invokeFailure = "synthetic browser refusal";
  const view = render(<Failure problem={{ said: "Synthetic failure." }} />);
  const help = view.getByRole("link", { name: "Get setup help" });

  fireEvent.click(help);
  const failure = await view.findByText(/Could not open your browser/);
  expect(failure.textContent).toContain("synthetic browser refusal");
  expect(failure.textContent).toContain(
    "https://github.com/CopilotKit/OpenBot/issues/new/choose",
  );

  invokeFailure = null;
  fireEvent.click(help);
  await waitFor(() =>
    expect(view.queryByText(/Could not open your browser/) === null).toBe(true),
  );
  expect(invokeCalls).toHaveLength(2);
});
