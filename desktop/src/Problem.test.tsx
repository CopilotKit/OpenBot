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

const { Failure, InlineFailure, TroubleshootingLogs } = await import(
  "./Problem"
);

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

/*
 * The card a Mac showed when its disk filled mid-update: containerd's input/output errors and
 * nothing about disk space. The native side recognises the full disk in that output
 * (`problem::disk_full`), and the card says it in a plain line above the raw output.
 */
test("a full disk is said in a plain line above the raw output", () => {
  const view = render(
    <Failure
      problem={{
        said: "OpenBot couldn't update or put the version it had back. Choose Retry to try putting it back again.",
        detail:
          "write /var/lib/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db: input/output error",
        cause:
          "Your Mac's disk is full. Free up space, quit and reopen Docker Desktop, then try again.",
      }}
    />,
  );
  const text = view.getByRole("alert").textContent ?? "";
  const cause = text.indexOf("Your Mac's disk is full.");
  expect(cause).toBeGreaterThan(text.indexOf("OpenBot couldn't update"));
  expect(cause).toBeLessThan(text.indexOf("Technical details"));
});

// An update not started for lack of room: said with the figures it carries.
test("an update with no room is said with its figures", () => {
  const view = render(
    <Failure
      problem={{
        said: "There isn't room on this computer for the update, so nothing changed.",
        shortfall: {
          podman: false,
          cpu: false,
          memory: false,
          disk: true,
          diskGb: "7.5",
          freeOnDrive: true,
          mac: true,
          updating: true,
          neededGb: "13",
        },
      }}
    />,
  );
  expect(view.getByRole("alert").textContent).toContain(
    "This Mac has 7.5 GB of free space, and OpenBot needs about 13 GB to update. Free up some space, then Retry.",
  );
});

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
  // Only the troubleshooting logs' own buttons: nothing that restores a credential.
  expect(
    view.getAllByRole("button").map((button) => button.textContent),
  ).toEqual(["Copy logs", "Save to a file"]);
  expect(invokeCalls).toEqual([]);
});

test("a failure offers its troubleshooting logs, with what failed", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  const view = render(
    <Failure problem={{ said: "OpenBot couldn't start.", detail: "exit 1" }} />,
  );
  expect(view.getByRole("alert").textContent).toContain(
    "Paste these logs into the AI assistant you use",
  );

  fireEvent.click(view.getByRole("button", { name: "Copy logs" }));
  await view.findByRole("button", { name: "Copied" });
  expect(invokeCalls[0]).toEqual({
    command: "troubleshooting_logs",
    args: { failure: "OpenBot couldn't start.\nexit 1" },
  });
  // The stub answers null; what reaches the clipboard is whatever the native side returned.
  expect(copied).toEqual([null as unknown as string]);

  fireEvent.click(view.getByRole("button", { name: "Save to a file" }));
  expect(invokeCalls[1]).toEqual({
    command: "save_troubleshooting_logs",
    args: { failure: "OpenBot couldn't start.\nexit 1" },
  });
  await view.findByText("Saved in the log folder.");
});

test("the logs say what is taken out before they are pasted anywhere", () => {
  const view = render(<TroubleshootingLogs />);
  expect(view.container.textContent).toContain(
    "OpenBot takes out keys, passwords and your email address first.",
  );
});

test("troubleshooting logs that cannot be saved say so", async () => {
  invokeFailure = "synthetic refusal";
  const view = render(<TroubleshootingLogs />);
  fireEvent.click(view.getByRole("button", { name: "Save to a file" }));
  await view.findByText("Couldn't save the logs. Try Copy logs.");
  expect(invokeCalls).toEqual([
    { command: "save_troubleshooting_logs", args: { failure: null } },
  ]);
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
