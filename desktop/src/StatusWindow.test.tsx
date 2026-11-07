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

test("each part shows its state and memory, and the back end its CLI readiness", async () => {
  invokeHandler = answers();
  const view = render(<StatusWindow readEveryMs={60_000} />);
  const bots = await view.findByRole("region", { name: "App" });
  expect(bots.textContent).toContain("Running · 400 MB");
  const intelligence = view.getByRole("region", { name: "Back end" });
  await waitFor(() =>
    expect(intelligence.textContent).toContain("Ready · 2.4 GB"),
  );
  // Each row says which part of OpenBot it is. Docker's names are for Copy diagnostics only.
  const rows = (part: HTMLElement) =>
    [...part.querySelectorAll(".status-list li")].map(
      (row) => row.firstElementChild?.textContent,
    );
  expect(rows(bots)).toEqual([
    "Front end and Bots",
    "Background jobs",
    "Database",
  ]);
  expect(rows(intelligence)).toEqual(["Conversations, memory and learning"]);
  expect(view.container.textContent).not.toMatch(/openbot-desktop-|k3d-/);
  expect(
    invokeCalls.find((call) => call.command === "run_local_eval")?.args,
  ).toMatchObject({ action: "status", stack: "local-abc" });
});

test("Restart OpenBot restarts its processes; Stop Intelligence stops only the stack", async () => {
  invokeHandler = answers();
  const view = render(<StatusWindow readEveryMs={60_000} />);
  const intelligence = await view.findByRole("region", {
    name: "Back end",
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

test("diagnostics carry versions, places and memory, and nothing secret", () => {
  const text = diagnostics(running, "ready");
  expect(text).toContain("OpenBot Desktop 0.2.0");
  expect(text).toContain(
    "Installed in /Users/someone/OpenBot, app on port 3010",
  );
  expect(text).toContain("Back end: local-abc, ready");
  expect(text).toContain("k3d-local-abc-server-0 2.4 GB");
  expect(text).toContain("openbot-desktop-postgres-1 150 MB");
  expect(text).not.toMatch(/key|token|secret/i);
});
