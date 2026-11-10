import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EarlyDownloads } from "./EarlyDownloads";

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
const downloadListeners = new Set<
  (event: { payload: EarlyDownloads }) => void
>();

/** A first run on a computer with nothing installed: every startup question answered plainly. */
async function answer(command: string): Promise<unknown> {
  switch (command) {
    case "windows_restart_pending":
      return false;
    case "default_root":
      return "/tmp/openbot-early-downloads";
    case "already_configured":
      return {
        values: {},
        saved: {
          modelApiKeys: { openai: false, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    case "already_running":
    case "take_ai_connection_change":
      return false;
    case "early_downloads_now":
      return { state: "idle", bytes: 0 };
    // Install and the sign-in stay in progress: the account step is where the person is.
    case "prepare_installation":
    case "sign_in_to_copilotkit":
      return new Promise(() => {});
    default:
      return null;
  }
}

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return answer(command);
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    listener: (event: { payload: EarlyDownloads }) => void,
  ) => {
    if (name === "setup:downloads") downloadListeners.add(listener);
    return () => downloadListeners.delete(listener);
  },
}));

mock.module("./Mark", () => ({
  Mark: ({ name }: { name: string }) => <span>{name}</span>,
  ButtonMark: () => null,
}));

const { App } = await import("./App");
const { earlyDownloadsSaid } = await import("./EarlyDownloads");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  invokeCalls = [];
  downloadListeners.clear();
});
afterAll(() => GlobalRegistrator.unregister());

async function said(payload: EarlyDownloads) {
  await act(async () => {
    for (const listener of downloadListeners) listener({ payload });
  });
}

function called(command: string) {
  return invokeCalls.filter((call) => call.command === command);
}

const GB = 1_000_000_000;

test("the big downloads start when the first screen shows, before Install is clicked or anyone signs in", async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  await view.findByRole("heading", { name: "Set up OpenBot" });

  // Nothing was clicked: the first screen alone started them, for the installation's folder.
  expect(called("start_early_downloads")).toEqual([
    {
      command: "start_early_downloads",
      args: { root: "/tmp/openbot-early-downloads" },
    },
  ]);
  expect(called("prepare_installation")).toEqual([]);
  expect(called("sign_in_to_copilotkit")).toEqual([]);

  // The first screen says how far they are, in plain words.
  await said({
    state: "downloading",
    bytes: 1.2 * GB,
    size: 2.9 * GB,
    bytesPerSecond: 10_000_000,
  });
  expect(view.getByRole("status").textContent).toBe(
    "Downloading OpenBot (1.2 of 2.9 GB, about 3 minutes left).",
  );
  const bar = view.getByRole("progressbar", { name: "Download progress" });
  expect(bar.getAttribute("value")).toBe(String(1.2 * GB));
  expect(bar.getAttribute("max")).toBe(String(2.9 * GB));

  // Install moves on to the CopilotKit sign-in, and the downloads keep saying where they are.
  await userEvent.click(view.getByRole("button", { name: "Install" }));
  await view.findByRole("heading", { name: /CopilotKit/ });
  await said({
    state: "downloading",
    bytes: 2.0 * GB,
    size: 2.9 * GB,
    bytesPerSecond: 10_000_000,
  });
  expect(
    view.getByText(
      "Downloading OpenBot (2.0 of 2.9 GB, about 2 minutes left).",
    ),
  ).toBeTruthy();
  // They were started once, by the first screen.
  expect(called("start_early_downloads")).toHaveLength(1);
});

test("a disk too full to download to is said plainly, with what is free and what is needed", async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  await view.findByRole("heading", { name: "Set up OpenBot" });
  await said({
    state: "short",
    bytes: 0,
    free: 14.6 * GB,
    needed: 44.3 * GB,
  });
  const line = view.getByRole("status");
  expect(line.textContent).toBe(
    "This computer has 15 GB of free space, and OpenBot needs about 44 GB. Free up some space and the download starts by itself.",
  );
  // Nothing is downloading, so nothing spins and there is no bar.
  expect(line.querySelector(".step-spinner")).toBeNull();
  expect(view.queryByRole("progressbar")).toBeNull();
});

test("the line says what is known, and only the first screen says when it is all downloaded", () => {
  expect(earlyDownloadsSaid({ state: "downloading", bytes: 0 }, true)).toBe(
    "Downloading OpenBot.",
  );
  expect(
    earlyDownloadsSaid({ state: "downloading", bytes: 0.4 * GB }, true),
  ).toBe("Downloading OpenBot (0.4 GB so far).");
  expect(
    earlyDownloadsSaid(
      {
        state: "downloading",
        bytes: 450_000_000,
        size: 937_000_000,
        bytesPerSecond: 20_000_000,
      },
      false,
    ),
  ).toBe("Downloading OpenBot (450 of 937 MB, less than a minute left).");
  expect(
    earlyDownloadsSaid(
      {
        state: "downloading",
        bytes: GB,
        size: 2 * GB,
        bytesPerSecond: 12_500_000,
      },
      false,
    ),
  ).toBe("Downloading OpenBot (1.0 of 2.0 GB, about a minute left).");
  expect(earlyDownloadsSaid({ state: "done", bytes: GB, size: GB }, true)).toBe(
    "OpenBot is downloaded and ready to install.",
  );
  expect(
    earlyDownloadsSaid({ state: "done", bytes: GB, size: GB }, false),
  ).toBe(null);
  expect(earlyDownloadsSaid({ state: "failed", bytes: 0 }, true)).toBe(
    "Some downloads didn’t finish. Install tries them again.",
  );
  expect(earlyDownloadsSaid({ state: "nothing", bytes: 0 }, true)).toBe(null);
  // No em dashes, and nothing technical, in anything it says.
  for (const state of ["downloading", "short", "done", "failed"] as const) {
    const line =
      earlyDownloadsSaid(
        { state, bytes: GB, size: 2 * GB, free: GB, needed: 44 * GB },
        true,
      ) ?? "";
    expect(line).not.toMatch(/—|Podman|machine|image|quay|engine/i);
  }
});
