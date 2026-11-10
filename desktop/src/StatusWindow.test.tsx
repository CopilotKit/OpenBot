import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

type Invoke = (command: string, args?: unknown) => Promise<unknown>;
let invokeHandler: Invoke = async () => null;
const invokeCalls: { command: string; args: unknown }[] = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return invokeHandler(command, args);
  },
}));

const { diagnostics, formatBytes, StatusWindow, totalMemory } = await import(
  "./StatusWindow"
);

afterEach(() => {
  cleanup();
  invokeCalls.length = 0;
});

const running = {
  openbotRunning: true,
  openbotHeld: true,
  processes: [],
  containers: [
    { name: "openbot-desktop-server-1", memoryBytes: 200_000_000 },
    { name: "openbot-desktop-worker-1", memoryBytes: 50_000_000 },
    { name: "openbot-desktop-postgres-1", memoryBytes: 150_000_000 },
  ],
  intelligenceStack: "local-abc",
  intelligenceContainers: [
    { name: "k3d-local-abc-server-0", memoryBytes: 2_400_000_000 },
  ],
  engine: "docker" as const,
  root: "/Users/someone/OpenBot",
  appPort: 3010,
  version: "0.2.0",
  build: "Built 2026-10-23 05:00 UTC from abc1234",
};

function answers(overrides: Partial<Record<string, unknown>> = {}): Invoke {
  return async (command) => {
    if (command in overrides) return overrides[command];
    if (command === "desktop_status") return running;
    if (command === "run_local_eval")
      return {
        outcome: "completed",
        stack: null,
        reason: null,
        readiness: "ready",
        licence: "valid",
        licenceExpiresAt: null,
        checksPassed: false,
      };
    return null;
  };
}

test("memory reads as people read it, and a total ignores what could not be measured", () => {
  expect(formatBytes(2_400_000_000)).toBe("2.4 GB");
  expect(formatBytes(150_000_000)).toBe("150 MB");
  expect(
    totalMemory([
      { name: "a", memoryBytes: 1_000_000 },
      { name: "b", memoryBytes: null },
    ]),
  ).toBe(1_000_000);
  expect(totalMemory([{ name: "b", memoryBytes: null }])).toBeNull();
});

test("each part shows its state and memory, and the backend its CLI readiness", async () => {
  invokeHandler = answers();
  const view = render(<StatusWindow readEveryMs={60_000} />);
  const bots = await view.findByRole("region", { name: "App" });
  expect(bots.textContent).toContain("Running · 400 MB");
  const intelligence = view.getByRole("region", { name: "OpenBot's services" });
  await waitFor(() =>
    expect(intelligence.textContent).toContain("Ready · 2.4 GB"),
  );
  // Each row says which part of OpenBot it is. Docker's names are for Copy diagnostics only.
  const rows = (part: HTMLElement) =>
    [...part.querySelectorAll(".status-list li")].map(
      (row) => row.firstElementChild?.textContent,
    );
  expect(rows(bots)).toEqual(["App and Bots", "Background jobs", "Database"]);
  expect(rows(intelligence)).toEqual(["Conversations and learning"]);
  expect(view.container.textContent).not.toMatch(/openbot-desktop-|k3d-/);
  expect(
    invokeCalls.find((call) => call.command === "run_local_eval")?.args,
  ).toMatchObject({ action: "status", stack: "local-abc" });
});

test("Restart OpenBot restarts its processes; Stop Intelligence stops only the stack", async () => {
  invokeHandler = answers();
  const view = render(<StatusWindow readEveryMs={60_000} />);
  const intelligence = await view.findByRole("region", {
    name: "OpenBot's services",
  });
  await userEvent.click(
    within(intelligence).getByRole("button", { name: "Stop" }),
  );
  await waitFor(() =>
    expect(
      invokeCalls.some(
        (call) =>
          call.command === "run_local_eval" &&
          (call.args as { action: string }).action === "stop",
      ),
    ).toBe(true),
  );
  expect(
    invokeCalls.some((call) => call.command === "stop_openbot_from_status"),
  ).toBe(false);
});

test("Open log folder asks the desktop app to open its own log folder", async () => {
  const logFolder = "/Users/someone/Library/Logs/ai.copilotkit.openbot.desktop";
  invokeHandler = answers({ desktop_status: { ...running, logFolder } });
  const view = render(<StatusWindow readEveryMs={60_000} />);
  await userEvent.click(
    await view.findByRole("button", { name: "Open log folder" }),
  );
  // The window asks; the desktop app opens the folder it writes to, never one it is handed.
  expect(
    invokeCalls
      .filter((call) => call.command === "open_log_folder")
      .map((call) => call.args === undefined),
  ).toEqual([true]);
  expect(
    view.container.querySelector(".status-details")?.textContent,
  ).toContain(`Logs${logFolder}`);
});

test("the Status window offers the troubleshooting logs, with no failure", async () => {
  invokeHandler = answers({ save_troubleshooting_logs: null });
  const view = render(<StatusWindow readEveryMs={60_000} />);
  await userEvent.click(
    await view.findByRole("button", { name: "Save to a file" }),
  );
  expect(
    invokeCalls
      .filter((call) => call.command === "save_troubleshooting_logs")
      .map((call) => call.args),
  ).toEqual([{ failure: null }]);
});

test("a log folder that couldn't be opened says where to find it", async () => {
  invokeHandler = async (command) => {
    if (command === "open_log_folder") throw "no file manager answered";
    return answers({
      desktop_status: {
        ...running,
        logFolder: "/Users/someone/Library/Logs/x",
      },
    })(command);
  };
  const view = render(<StatusWindow readEveryMs={60_000} />);
  await userEvent.click(
    await view.findByRole("button", { name: "Open log folder" }),
  );
  await view.findByText(
    "Couldn't open the log folder. Find it under Logs below.",
  );
});

test("a desktop app without a log offers no Open log folder", async () => {
  invokeHandler = answers();
  const view = render(<StatusWindow readEveryMs={60_000} />);
  await view.findByRole("region", { name: "App" });
  expect(view.queryByRole("button", { name: "Open log folder" })).toBeNull();
});

test("the back end's stack id goes only to Copy diagnostics", async () => {
  invokeHandler = answers({
    desktop_status: { ...running, intelligenceStack: "local-08ff56ec9469e95e" },
  });
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  const view = render(<StatusWindow readEveryMs={60_000} />);
  await view.findByRole("region", { name: "OpenBot's services" });
  expect(view.container.textContent).not.toContain("local-08ff56ec9469e95e");
  await userEvent.click(view.getByRole("button", { name: "Copy diagnostics" }));
  await waitFor(() =>
    expect(copied).toContain("Backend: local-08ff56ec9469e95e"),
  );
});

test("diagnostics carry versions, places and memory, and nothing secret", () => {
  const text = diagnostics(running, "ready");
  expect(text).toContain("OpenBot Desktop 0.2.0");
  expect(text).toContain(
    "Installed in /Users/someone/OpenBot, app on port 3010",
  );
  expect(text).toContain("Backend: local-abc, ready");
  expect(text).toContain("k3d-local-abc-server-0 2.4 GB");
  expect(text).toContain("openbot-desktop-postgres-1 150 MB");
  expect(text).not.toMatch(/key|token|secret/i);
});

/**
 * Words a person reading the Status window doesn't know, and values only support needs: the
 * engine's name, the back end, Docker's container names, the build's commit and time, ports.
 * Docker Desktop is named where the person opens it; Docker alone, as the engine's name, is not.
 * On a live Windows run the window said "Back end", "Container engine" and "Podman".
 */
const TECHNICAL = [
  /Podman/i,
  /\bDocker\b(?! Desktop)/,
  /\bengines?\b/i,
  /back[ -]?end/i,
  /front[ -]?end/i,
  /\bcontainers?\b/i,
  /\bk3[sd]\b/i,
  /Intelligence/,
  /\bCLI\b/,
  /\bCompose\b/,
  /\bstack\b/i,
  /\bports?\b/i,
  /\bUTC\b/,
  /\bBuilt\b/,
  /\b[0-9a-f]{7,40}\b/,
  /openbot-desktop-|local-[0-9a-f]/,
  /\u2014/,
];

/** Everything a person reads on the window: its text and the names a screen reader says. */
function readOn(view: ReturnType<typeof render>): string[] {
  const named = [...view.container.querySelectorAll("[aria-label]")].map(
    (element) => element.getAttribute("aria-label") ?? "",
  );
  return [view.container.textContent ?? "", ...named];
}

test("every label and value on the Status window is in plain words, and the technical detail is in Copy diagnostics", async () => {
  const onAMac = {
    ...running,
    engine: "podman" as const,
    containers: [
      ...running.containers,
      { name: "openbot-desktop-agent-computer-1", memoryBytes: null },
      { name: "openbot-desktop-sidecar-1", memoryBytes: 20_000_000 },
    ],
    intelligenceStack: "local-e0cf90debea88453ad454b93",
    intelligenceContainers: [
      {
        name: "k3d-local-e0cf90debea88453ad454b93-server-0",
        memoryBytes: 2_400_000_000,
      },
      { name: "k3d-local-e0cf90debea88453ad454b93-tools", memoryBytes: 9e6 },
      {
        name: "k3d-local-e0cf90debea88453ad454b93-serverlb",
        memoryBytes: 2e7,
      },
    ],
    build: "Built 2026-11-09 18:30 UTC from 795f619 on main",
    logFolder: "/Users/someone/Library/Logs/ai.copilotkit.openbot.desktop",
  };
  const allStopped = {
    ...onAMac,
    openbotRunning: false,
    openbotHeld: false,
    containers: [],
    intelligenceContainers: [],
    engine: null,
    appPort: null,
  };
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  for (const [state, status] of [
    ["running", onAMac],
    ["stopped", allStopped],
  ] as const) {
    invokeHandler = answers({ desktop_status: status });
    const view = render(<StatusWindow readEveryMs={60_000} />);
    await view.findByRole("region", { name: "App" });
    if (state === "running")
      await waitFor(() =>
        expect(view.container.textContent).toContain("Ready"),
      );
    const technical = readOn(view).flatMap((said) =>
      TECHNICAL.filter((word) => word.test(said)).map(
        (word) => said.match(word)?.[0],
      ),
    );
    expect({ state, technical }).toEqual({ state, technical: [] });
    // Each part has its place and says what it is, in the words setup uses.
    expect(
      view.getByRole("region", { name: "Software OpenBot runs on" })
        .textContent,
    ).toContain(state === "running" ? "Running" : "Not running");
    expect(
      view.queryByRole("region", { name: "OpenBot's services" }),
    ).not.toBeNull();
    expect(
      view.container.querySelector(".status-details")?.textContent,
    ).toContain(`Version${running.version}Logs`);
    // What support needs is one click away.
    await userEvent.click(
      view.getByRole("button", { name: "Copy diagnostics" }),
    );
    await waitFor(() => expect(copied).toContain(status.build));
    expect(copied).toContain(
      `Container engine: ${status.engine ?? "not answering"}`,
    );
    expect(copied).toContain("local-e0cf90debea88453ad454b93");
    cleanup();
  }
});
