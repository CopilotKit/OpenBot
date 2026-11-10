import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
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
  setSystemTime();
  invokeCalls = [];
  downloadListeners.clear();
});
afterAll(() => GlobalRegistrator.unregister());

async function said(payload: EarlyDownloads) {
  await act(async () => {
    for (const listener of downloadListeners) listener({ payload });
  });
}

/**
 * The same report again once it has run long enough for its speed to say a time from: no time left
 * is said before 3 seconds and 5 MB (`STEADY_SECONDS`, `STEADY_BYTES` in `journey.ts`).
 */
async function steadied(payload: EarlyDownloads) {
  setSystemTime(new Date(Date.now() + 3_500));
  // A new report, as the native side sends one twice a second.
  await said({ ...payload });
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

  // The first screen says how far they are in the background row's words, with the bytes under
  // its bar, and the time left once the speed is steady.
  const welcome = {
    state: "downloading" as const,
    bytes: 1.2 * GB,
    size: 2.9 * GB,
    bytesPerSecond: 10_000_000,
  };
  await said(welcome);
  expect(view.getByRole("status").textContent).toBe("Downloading OpenBot.");
  await steadied(welcome);
  expect(view.getByRole("status").textContent).toBe(
    "Downloading OpenBot. About 3 minutes left.",
  );
  const bar = view.getByRole("progressbar", { name: "Download progress" });
  expect(Number(bar.getAttribute("value"))).toBeCloseTo(1.2 / 2.9, 3);
  expect(bar.getAttribute("aria-valuetext")).toBe("1.2 GB of 2.9 GB");

  // Install moves on to the CopilotKit sign-in. The row for what is installing in the background
  // carries the download on, in the same words, and its bar goes on from where it was.
  await userEvent.click(view.getByRole("button", { name: "Install" }));
  await view.findByRole("heading", { name: "Self-contained OpenBot" });
  const account = { ...welcome, bytes: 2.0 * GB };
  await said(account);
  await steadied(account);
  const row = within(
    view.getByRole("listitem", {
      name: "Installing OpenBot in the background",
    }),
  );
  expect(
    row.getByText("Downloading OpenBot. About 2 minutes left."),
  ).toBeTruthy();
  const carried = row.getByRole("progressbar", { name: "Download progress" });
  expect(Number(carried.getAttribute("value"))).toBeCloseTo(2.0 / 2.9, 3);
  expect(carried.getAttribute("aria-valuetext")).toBe("2.0 GB of 2.9 GB");
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
  const downloading = {
    state: "downloading" as const,
    bytes: GB,
    size: 2 * GB,
  };
  expect(earlyDownloadsSaid(downloading, true)).toBe("Downloading OpenBot.");
  expect(
    earlyDownloadsSaid(downloading, false, { left: 40, slow: false }),
  ).toBe("Downloading OpenBot. Less than a minute left.");
  expect(
    earlyDownloadsSaid(downloading, false, { left: 80, slow: false }),
  ).toBe("Downloading OpenBot. About a minute left.");
  expect(
    earlyDownloadsSaid(downloading, false, { left: null, slow: true }),
  ).toBe("Downloading OpenBot. Taking longer than usual, still working.");
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
        { left: 200, slow: false },
      ) ?? "";
    expect(line).not.toMatch(/—|Podman|machine|image|quay|engine/i);
  }
});

test("the background row carries the first screen's download as one bar, and keeps what the person has to see", async () => {
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
  const own = {
    done: 0,
    total: 0,
    bytes: 600_000_000,
    size: 937_000_000,
    bytesPerSecond: 20_000_000,
  };
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

  // Install is checking what it needs: the row is the first screen's download.
  const checking = behind({
    step: "install-engine",
    ok: true,
    running: true,
    detail: "Checking the software OpenBot needs.",
  });
  expect(checking?.detail).toBe("Downloading OpenBot.");
  expect(checking?.downloads).toEqual(early);

  // Install waiting on the machine image while the first screen's downloads still run: the same
  // one bar over all of them, so it never goes back to the machine image's own.
  const waitingOnTheMachine = behind({
    step: "create-machine",
    ok: true,
    running: true,
    detail: "Preparing this computer to run OpenBot.",
    downloads: own,
  });
  expect(waitingOnTheMachine?.detail).toBe("Downloading OpenBot.");
  expect(waitingOnTheMachine?.downloads).toEqual(early);

  // Once those are done, a download of Install's own is the row's.
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
  expect(machine?.detail).toBe("Downloading OpenBot.");
  expect(machine?.downloads).toEqual(own);

  // The OS asking in its own window, explained in plain words: the row keeps them.
  const prompting = behind({
    step: "install-engine",
    ok: true,
    running: true,
    elsewhere: true,
    detail: "Enter your Mac password when macOS asks for it.",
  });
  expect(prompting?.detail).toBe(
    "Enter your Mac password when macOS asks for it.",
  );
  expect(prompting?.downloads).toBeUndefined();

  // A closed password prompt: the row says only what it waits for.
  const declined = behind({
    step: "install-engine",
    ok: true,
    running: true,
    asks: true,
    detail: "macOS didn't get your password.",
  });
  expect(declined?.detail).toBe("Waiting for your password.");
  expect(declined?.waiting).toBe(true);

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
