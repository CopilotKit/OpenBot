import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
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

const { cleanup, render, waitFor, within } = await import(
  "@testing-library/react"
);
const userEvent = (await import("@testing-library/user-event")).default;
const { diagnostics, formatBytes, StatusWindow, totalMemory } = await import(
  "./StatusWindow"
);

afterEach(() => {
  cleanup();
  invokeCalls.length = 0;
});

const running = {
  openbotRunning: true,
  processes: [
    { name: "server", memoryBytes: 200_000_000 },
    { name: "app", memoryBytes: 50_000_000 },
  ],
  containers: [{ name: "openbot-postgres-1", memoryBytes: 150_000_000 }],
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

test("each part shows its state and memory, and Intelligence its CLI readiness", async () => {
  invokeHandler = answers();
  const view = render(<StatusWindow readEveryMs={60_000} />);
  const openbot = await view.findByRole("region", { name: "OpenBot" });
  expect(openbot.textContent).toContain("Running · 400 MB");
  expect(openbot.textContent).toContain("openbot-postgres-1");
  const intelligence = view.getByRole("region", { name: "Intelligence" });
  await waitFor(() =>
    expect(intelligence.textContent).toContain("Ready · 2.4 GB"),
  );
  expect(
    invokeCalls.find((call) => call.command === "run_local_eval")?.args,
  ).toMatchObject({ action: "status", stack: "local-abc" });
});

test("Restart OpenBot restarts its processes; Stop Intelligence stops only the stack", async () => {
  invokeHandler = answers();
  const view = render(<StatusWindow readEveryMs={60_000} />);
  const intelligence = await view.findByRole("region", {
    name: "Intelligence",
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

test("diagnostics carry versions, places and memory, and nothing secret", () => {
  const text = diagnostics(running, "ready");
  expect(text).toContain("OpenBot Desktop 0.2.0");
  expect(text).toContain(
    "Installed in /Users/someone/OpenBot, app on port 3010",
  );
  expect(text).toContain("Intelligence: local-abc, ready");
  expect(text).toContain("k3d-local-abc-server-0 2.4 GB");
  expect(text).not.toMatch(/key|token|secret/i);
});
