import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, within } from "@testing-library/react";
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

  // The first screen says how far they are, in plain words, with the bytes under a bar.
  await said({
    state: "downloading",
    bytes: 1.2 * GB,
    size: 2.9 * GB,
    bytesPerSecond: 10_000_000,
  });
  expect(view.getByRole("status").textContent).toBe(
    "Downloading OpenBot. About 3 minutes left.",
  );
  const bar = view.getByRole("progressbar", { name: "Download progress" });
  expect(bar.getAttribute("value")).toBe(String(1.2 * GB));
  expect(bar.getAttribute("max")).toBe(String(2.9 * GB));
  expect(view.getByText("1.2 GB of 2.9 GB")).toBeTruthy();

  // Install moves on to the CopilotKit sign-in. The row for what is installing in the background
  // carries the download on, in the same words.
  await userEvent.click(view.getByRole("button", { name: "Install" }));
  await view.findByRole("heading", { name: /CopilotKit/ });
  await said({
    state: "downloading",
    bytes: 2.0 * GB,
    size: 2.9 * GB,
    bytesPerSecond: 10_000_000,
  });
  const row = within(
    view.getByRole("listitem", {
      name: "Installing OpenBot in the background",
    }),
  );
  expect(
    row.getByText("Downloading OpenBot. About 2 minutes left."),
  ).toBeTruthy();
  expect(row.getByText("2.0 GB of 2.9 GB")).toBeTruthy();
  expect(
    row
      .getByRole("progressbar", { name: "Download progress" })
      .getAttribute("value"),
  ).toBe(String(2.0 * GB));
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
    earlyDownloadsSaid(
      {
        state: "downloading",
        bytes: 450_000_000,
        size: 937_000_000,
        bytesPerSecond: 20_000_000,
      },
      false,
    ),
  ).toBe("Downloading OpenBot. Less than a minute left.");
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
  ).toBe("Downloading OpenBot. About a minute left.");
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

test("the background row carries the first screen's download, and keeps what the person has to do", async () => {
  const { installingBehind } = await import("./SetupProgress");
  const backEnd = {
    at: null,
    running: false,
    stopped: false,
    ready: false,
    detail: null,
    download: null,
    since: null,
  };
  const early = { bytes: 1.5 * GB, size: 2.9 * GB, bytesPerSecond: 10_000_000 };
  const behind = (
    step: Record<string, unknown>,
    first: { bytes: number; size?: number } | null = early,
  ) =>
    installingBehind({
      steps: [
        { step: "engine", ok: true, detail: "", running: false },
        step as never,
      ],
      installing: true,
      installed: false,
      backEnd,
      early: first,
    });

  // Install is checking what it needs: the row is the download.
  const checking = behind({
    step: "install-engine",
    ok: true,
    running: true,
    detail: "Checking the software OpenBot needs.",
  });
  expect(checking?.detail).toBe("Downloading OpenBot. About 2 minutes left.");
  expect(checking?.downloads).toEqual(early);

  // Waiting for the person's Continue: its words stay, and the download goes on under them.
  const asking = behind({
    step: "install-engine",
    ok: true,
    running: true,
    asks: true,
    detail: "Ready to install. Continue when you're ready.",
  });
  expect(asking?.detail).toBe("Ready to install. Continue when you're ready.");
  expect(asking?.waiting).toBe(true);
  expect(asking?.downloads).toEqual(early);

  // A prompt in another window keeps its words too.
  const prompting = behind({
    step: "create-machine",
    ok: true,
    running: true,
    elsewhere: true,
    detail: "Enter your Mac password when macOS asks for it.",
  });
  expect(prompting?.detail).toBe(
    "Enter your Mac password when macOS asks for it.",
  );
  expect(prompting?.downloads).toEqual(early);

  // Install waiting on the machine image itself: its own download, in the same words.
  const own = {
    done: 0,
    total: 0,
    bytes: 600_000_000,
    size: 937_000_000,
    bytesPerSecond: 20_000_000,
  };
  const machine = behind(
    {
      step: "create-machine",
      ok: true,
      running: true,
      detail: "Preparing this computer to run OpenBot.",
      downloads: own,
    },
    null,
  );
  expect(machine?.detail).toBe("Downloading OpenBot. Less than a minute left.");
  expect(machine?.downloads).toEqual(own);

  // Nothing downloading early: the row says what Install is doing, as before.
  const plain = behind(
    {
      step: "create-machine",
      ok: true,
      running: true,
      detail: "Preparing this computer to run OpenBot.",
    },
    null,
  );
  expect(plain?.detail).toBe("Preparing this computer to run OpenBot.");
  expect(plain?.downloads).toBeUndefined();
});
