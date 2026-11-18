import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let invokeFailure: string | null = null;
/** What the shell answers a command, where a test needs more than nothing. */
let answers: Record<string, unknown> = {};

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    if (invokeFailure) return Promise.reject(invokeFailure);
    return Promise.resolve(answers[command] ?? null);
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
  answers = {};
  if (previousSupportUrl === undefined)
    delete process.env.VITE_OPENBOT_SUPPORT_URL;
  else process.env.VITE_OPENBOT_SUPPORT_URL = previousSupportUrl;
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

/** What the shell says when the OpenBot on this computer needs a newer app (`client_version.rs`). */
const LOCAL_APP_TOO_OLD = {
  said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
  detail:
    "the deployment's minimumClients.desktop is 1.2.0; this app is desktop/1.1.0 and speaks v2",
  kind: "app-too-old",
};

/*
 * An OpenBot that needs a newer version of this app is not a failure. Wherever setup shows a
 * problem, it says "Update OpenBot" with the shell's sentence, and Update and restart reads the
 * update feed and installs what it finds: no failure heading, no technical details, no logs.
 */
test("an OpenBot that needs a newer app says Update OpenBot and Update and restart installs the update", async () => {
  answers = {
    app_update_offer: {
      version: null,
      current: "1.1.0",
      installing: null,
      updatesItself: true,
    },
    check_app_update: {
      found: "available",
      version: "1.2.0",
      current: "1.1.0",
    },
    // On success the app restarts into the new version, and never answers.
    install_app_update: new Promise(() => {}),
  };
  const view = render(<Failure problem={LOCAL_APP_TOO_OLD} />);
  const card = view.getByRole("alert");
  expect(view.getByRole("heading", { name: "Update OpenBot" })).toBeTruthy();
  expect(card.textContent).toContain(LOCAL_APP_TOO_OLD.said);
  expect(view.queryByText("That didn’t finish")).toBeNull();
  expect(view.queryByText("Technical details")).toBeNull();
  expect(view.queryByRole("button", { name: "Copy logs" })).toBeNull();
  // Drawn as a notice, not as the failure card.
  expect(card.classList.contains("blocker")).toBe(false);
  const update = view.getByRole("button", { name: "Update and restart" });
  await waitFor(() => expect(update).toHaveProperty("disabled", false));
  fireEvent.click(update);
  await waitFor(() =>
    expect(invokeCalls.map((call) => call.command)).toEqual([
      "app_update_offer",
      "check_app_update",
      "install_app_update",
    ]),
  );
  await waitFor(() => expect(update.textContent).toBe("Downloading…"));
});

// A build that never updates itself has nothing to press: it says how to get one that does.
test("an OpenBot that needs a newer app, on a build that doesn't update itself, says how to get one", async () => {
  answers = {
    app_update_offer: {
      version: null,
      current: "1.1.0-internal.12.gabc",
      installing: null,
      updatesItself: false,
    },
  };
  const view = render(<Failure problem={LOCAL_APP_TOO_OLD} />);
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain(
      "This version of OpenBot doesn't update itself. Install a released version of OpenBot to get updates.",
    ),
  );
  expect(view.queryByRole("button", { name: "Update and restart" })).toBeNull();
});

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
