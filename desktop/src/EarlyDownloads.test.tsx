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
/** What the early downloads say once they have looked at the disk, when Install asks. */
let measured: () => Promise<unknown> = async () => null;
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
    case "early_downloads_measured":
      return measured();
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
  measured = async () => null;
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
  await view.findByRole("heading", { name: "Set up OpenBot (self-contained)" });

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
  // The account step, checking the sign-in, which here never answers.
  await view.findByRole("heading", { name: "Your OpenBot account" });
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

/** A GB as Windows counts it, and as the account step says its 40 GB. */
const GIB = 1024 ** 3;
/** Windows F's figures, from its log: "16096509952 bytes free, 44436190301 needed". */
const WINDOWS_F_SHORT: EarlyDownloads = {
  state: "short",
  bytes: 0,
  free: 16_096_509_952,
  needed: 40 * GIB,
  download: 1_486_517_341,
};

/**
 * Windows F, filled to 15.0 GB free: this line said "16 GB of free space, and OpenBot needs about
 * 44 GB", and the next screen "It needs 40 GB free". Both were the back end's 40 GiB: this one added
 * the download and counted billions of bytes. It says the 40 and the download apart now, in the GB
 * Windows shows. And Install was pressable: it built OpenBot's machine at 15 GB free, then the next
 * step stopped for space with less free than before. Install waits for room now.
 */
test("a disk too full to download to says what is free and what is needed, and Install waits for room", async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  await view.findByRole("heading", { name: "Set up OpenBot (self-contained)" });
  await said(WINDOWS_F_SHORT);
  const line = view.getByRole("status");
  // Each figure and its unit are kept on one line.
  expect(line.textContent).toContain("2\u00a0GB for its download");
  expect(line.textContent?.replaceAll("\u00a0", " ")).toBe(
    "This computer has 15 GB of free space, and OpenBot needs 40 GB plus about 2 GB for its download. Free up some space and the download starts by itself.",
  );
  // Nothing is downloading, so nothing spins and there is no bar.
  expect(line.querySelector(".step-spinner")).toBeNull();
  expect(view.queryByRole("progressbar")).toBeNull();
  const install = view.getByRole("button", {
    name: "Install",
  }) as HTMLButtonElement;
  expect(install.disabled).toBe(true);
  await userEvent.click(install);
  expect(called("prepare_installation")).toEqual([]);
  expect(view.getByRole("heading", { name: "Set up OpenBot (self-contained)" })).toBeTruthy();
  // Space was freed: the download starts by itself, and Install is there again.
  await said({ state: "downloading", bytes: 0 });
  expect(install.disabled).toBe(false);
});

/**
 * Install pressed in the seconds before the downloads have looked at the disk: it asks them, and on
 * a disk too full it stays on this screen, says why, and builds nothing.
 */
test("an Install pressed before the disk is looked at builds nothing on a disk too full", async () => {
  let looked!: (now: EarlyDownloads) => void;
  measured = () => new Promise((resolve) => (looked = resolve));
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  await view.findByRole("heading", { name: "Set up OpenBot (self-contained)" });
  const install = view.getByRole("button", {
    name: "Install",
  }) as HTMLButtonElement;
  expect(install.disabled).toBe(false);
  await userEvent.click(install);
  // Waiting for the answer, it can't be pressed twice.
  expect(install.disabled).toBe(true);
  await act(async () => {
    for (const listener of downloadListeners)
      listener({ payload: WINDOWS_F_SHORT });
    looked(WINDOWS_F_SHORT);
  });
  expect(called("prepare_installation")).toEqual([]);
  expect(view.getByRole("heading", { name: "Set up OpenBot (self-contained)" })).toBeTruthy();
  expect(
    view.getByRole("status").textContent?.replaceAll("\u00a0", " "),
  ).toContain("This computer has 15 GB of free space");
  expect(install.disabled).toBe(true);
});

/**
 * Behind the account step the downloads pause while it asks the person to free space: the line says
 * so, and the background row gets no bar that stopped.
 */
test("a download paused for space says so, with no bar", async () => {
  const { earlyDownload } = await import("./EarlyDownloads");
  const paused = {
    state: "downloading" as const,
    bytes: 0.6 * GB,
    size: 1.5 * GB,
    paused: true,
  };
  expect(earlyDownloadsSaid(paused, false)).toBe(
    "The download is paused until there's enough free space. It carries on by itself.",
  );
  expect(earlyDownload(paused)).toBeNull();
  expect(earlyDownload({ ...paused, paused: false })).not.toBeNull();
});

test("the line says what is known, and nothing once it is all downloaded", () => {
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
  // Done says nothing, on the first screen too: Install is the next step either way.
  expect(earlyDownloadsSaid({ state: "done", bytes: GB, size: GB }, true)).toBe(
    null,
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
