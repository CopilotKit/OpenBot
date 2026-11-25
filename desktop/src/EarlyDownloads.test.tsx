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
import type { Problem } from "./Problem";
import type { Progress } from "./SetupProgress";

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
/** What the early downloads say once they have looked at the disk, when Install asks. */
let measured: () => Promise<unknown> = async () => null;
/** How the move of the engine to another drive ends, when the person asks for it. */
let moveEngine: () => Promise<unknown> = () => new Promise(() => {});
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
    case "move_engine_here":
      return moveEngine();
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
  MarkImage: () => null,
}));

const { App } = await import("./App");
const { EarlyDownloadsLine, earlyDownload, earlyDownloadsSaid } = await import(
  "./EarlyDownloads"
);
const { installingBehind, SetupProgress } = await import("./SetupProgress");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  setSystemTime();
  invokeCalls = [];
  downloadListeners.clear();
  measured = async () => null;
  moveEngine = () => new Promise(() => {});
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

/*
 * On a computer with nothing of OpenBot on it, the first screen downloads nothing: somebody who
 * only connects to their company's OpenBot would download about 2 GB for nothing (seen on a clean
 * Windows machine). Install with Self-hosted chosen starts them, as the first thing it does.
 */
test("the big downloads start with Install, before anyone signs in, and never before the choice", async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  await view.findByRole("heading", { name: "Set up OpenBot" });

  // Nothing was clicked: nothing downloads, and the line says nothing.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(called("start_early_downloads")).toEqual([]);
  expect(view.queryByRole("status")).toBeNull();

  // Install starts them for the installation's folder, then moves on to the account step. The row
  // for what is installing in the background says how far they are, with the bytes under its bar.
  await userEvent.click(view.getByRole("button", { name: "Install" }));
  expect(called("start_early_downloads")).toEqual([
    {
      command: "start_early_downloads",
      args: { root: "/tmp/openbot-early-downloads" },
    },
  ]);
  // The account step, checking the sign-in, which here never answers.
  await view.findByRole("heading", { name: "Your OpenBot account" });
  const welcome = {
    state: "downloading" as const,
    bytes: 1.2 * GB,
    size: 2.9 * GB,
    bytesPerSecond: 10_000_000,
  };
  await said(welcome);
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
  // They were started once, by Install.
  expect(called("start_early_downloads")).toHaveLength(1);
});

/*
 * Where they run on the first screen (an installation already on this computer starts them when it
 * shows, and a disk too full keeps the person there), its line says how far they are in the
 * background row's words, with the bytes under its bar, and the time left once the speed is steady.
 */
test("on the first screen, the line says how far the downloads are, with one bar", async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  await view.findByRole("heading", { name: "Set up OpenBot" });
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
  measured = async () => WINDOWS_F_SHORT;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  await view.findByRole("heading", { name: "Set up OpenBot" });
  // Install starts the downloads, which look at the disk first and find it too full.
  await userEvent.click(view.getByRole("button", { name: "Install" }));
  await said(WINDOWS_F_SHORT);
  expect(called("start_early_downloads")).toHaveLength(1);
  expect(called("prepare_installation")).toEqual([]);
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
  expect(view.getByRole("heading", { name: "Set up OpenBot" })).toBeTruthy();
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
  await view.findByRole("heading", { name: "Set up OpenBot" });
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
  expect(view.getByRole("heading", { name: "Set up OpenBot" })).toBeTruthy();
  expect(
    view.getByRole("status").textContent?.replaceAll("\u00a0", " "),
  ).toContain("This computer has 15 GB of free space");
  expect(install.disabled).toBe(true);
});

/**
 * Behind the account step the downloads pause while it asks the person to free space: the line says
 * so, and the background row gets no bar that stopped.
 */
test("a download paused for space says so, with no bar and no time running on", () => {
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

  // Install's own pulls hold too: its images row is paused (`report_holding_for_room`). The
  // background row says so in its badge, where it said "Step 2 of 4 · 0s elapsed".
  const row = installingBehind({
    steps: [
      { step: "engine", ok: true, detail: "", running: false },
      {
        step: "images",
        ok: true,
        running: true,
        paused: true,
        detail: earlyDownloadsSaid(paused, false) ?? "",
      },
    ],
    installing: true,
    installed: false,
    since: Date.now() - 95_000,
    backEnd: {
      at: null,
      running: false,
      stopped: false,
      ready: false,
      detail: null,
      download: null,
      since: null,
    },
    early: earlyDownload(paused),
  });
  expect(row?.paused).toBe(true);
  expect(row?.downloads).toBeUndefined();
  const view = render(
    <SetupProgress steps={row ? [row] : []} label="Background install" />,
  );
  const item = within(
    view.getByRole("listitem", {
      name: "Installing OpenBot in the background",
    }),
  );
  expect(item.getByText("Step 2 of 4 · Paused")).toBeTruthy();
  expect(item.queryByText(/elapsed/)).toBeNull();
  expect(view.container.querySelector(".step-spinner")).toBeNull();
  expect(
    item.getByText(
      "The download is paused until there's enough free space. It carries on by itself.",
    ),
  ).toBeTruthy();
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

test("the background row carries the first screen's download as one bar, and keeps what the person has to see", () => {
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
    step: Progress,
    first: { bytes: number; size?: number } | null = early,
  ) =>
    installingBehind({
      steps: [{ step: "engine", ok: true, detail: "", running: false }, step],
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

/*
 * The disk is short on C:, and the install folder's drive has room: the space message offers to
 * move the engine there. Only the person's click moves it, and the line under the button says
 * what the move stops.
 */
const SHORT_ON_C: EarlyDownloads = { ...WINDOWS_F_SHORT, moveTo: "F:" };
const MOVE_TO_F = "Move OpenBot's storage to F:";
const WSL_STOPS =
  "Docker Desktop and other Linux apps on this computer stop for a moment.";

/** The line on a screen behind the first one, after the native side says `payload`. */
async function lineSaying(payload: EarlyDownloads) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<EarlyDownloadsLine />);
  });
  await said(payload);
  return view;
}

test("the space message offers no move when moving would not help", async () => {
  const view = await lineSaying(WINDOWS_F_SHORT);
  expect(view.getByRole("status").textContent).toContain("Free up some space");
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByText(WSL_STOPS)).toBeNull();
});

test("the space message offers to move the engine, and says what the move stops", async () => {
  const view = await lineSaying(SHORT_ON_C);
  expect(view.getByRole("button", { name: MOVE_TO_F })).toBeTruthy();
  expect(view.getByText(WSL_STOPS)).toBeTruthy();
  expect(called("move_engine_here")).toEqual([]);
});

test("a click moves the engine once, and the button is gone while it moves", async () => {
  const view = await lineSaying(SHORT_ON_C);
  await userEvent.click(view.getByRole("button", { name: MOVE_TO_F }));
  expect(called("move_engine_here")).toEqual([
    { command: "move_engine_here", args: undefined },
  ]);
  expect(view.queryByRole("button", { name: MOVE_TO_F })).toBeNull();
  expect(view.getByText("Moving OpenBot's storage to F:…")).toBeTruthy();
});

test("a move that fails says why, and offers the move again", async () => {
  const failed: Problem = {
    said: "OpenBot couldn't move its storage to F:. It is still on C:.",
    detail: "wsl --manage failed",
  };
  moveEngine = async () => Promise.reject(failed);
  const view = await lineSaying(SHORT_ON_C);
  await userEvent.click(view.getByRole("button", { name: MOVE_TO_F }));
  expect(view.getByRole("alert").textContent).toContain(
    "OpenBot couldn't move its storage to F:. It is still on C:.",
  );
  expect(view.getByRole("button", { name: MOVE_TO_F })).toBeTruthy();
  expect(view.queryByText("Moving OpenBot's storage to F:…")).toBeNull();
});

/*
 * The native side measures the disk again within about 10 seconds of a move. Until it does, the
 * window still holds the old summary with its offer: the button must not offer a second move.
 */
test("after a move, the same summary offers no second move", async () => {
  moveEngine = async () => null;
  const view = await lineSaying(SHORT_ON_C);
  await userEvent.click(view.getByRole("button", { name: MOVE_TO_F }));
  expect(
    view.getByText(
      "OpenBot's storage is on F: now. OpenBot checks the free space again.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: MOVE_TO_F })).toBeNull();
  // The old summary again, as it comes twice a second until the disk is measured again.
  await said({ ...SHORT_ON_C });
  expect(view.queryByRole("button", { name: MOVE_TO_F })).toBeNull();
  expect(called("move_engine_here")).toHaveLength(1);
});
