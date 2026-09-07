import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { BrowserMode } from "./browser-mode";

export type DisplayProcess = {
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => boolean;
};

export type DisplayRuntime = {
  spawn: (command: string, args: string[]) => DisplayProcess;
  ready: (socketPath: string) => Promise<boolean>;
  wait: (milliseconds: number) => Promise<void>;
};

export type VirtualDisplay = {
  name: string;
  stop: () => Promise<void>;
};

const DISPLAY = ":99";
const SOCKET = "/tmp/.X11-unix/X99";
const READY_BUDGET_MS = 5_000;
const POLL_MS = 25;
const STOP_BUDGET_MS = 2_000;

const systemRuntime: DisplayRuntime = {
  spawn(command, args) {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const exited = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
    return { exited, kill: (signal) => child.kill(signal) };
  },
  ready: async (socketPath) => {
    try {
      await access(socketPath);
      return true;
    } catch {
      return false;
    }
  },
  wait: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

async function stop(
  process: DisplayProcess,
  runtime: DisplayRuntime,
): Promise<void> {
  let exited = false;
  void process.exited.then(() => {
    exited = true;
  });
  process.kill("SIGTERM");
  await Promise.race([process.exited, runtime.wait(STOP_BUDGET_MS)]);
  if (!exited) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

/** Start the one local-only X display a headed computer needs. */
export async function startVirtualDisplay(
  mode: BrowserMode,
  runtime: DisplayRuntime = systemRuntime,
): Promise<VirtualDisplay | null> {
  if (mode === "headless") return null;

  const process = runtime.spawn("Xvfb", [
    DISPLAY,
    "-screen",
    "0",
    "1280x800x24",
    "-nolisten",
    "tcp",
    "-ac",
  ]);
  let exitCode: number | undefined;
  void process.exited.then((code) => {
    exitCode = code;
  });

  for (let waited = 0; waited < READY_BUDGET_MS; waited += POLL_MS) {
    if (await runtime.ready(SOCKET)) {
      return { name: DISPLAY, stop: () => stop(process, runtime) };
    }
    if (exitCode !== undefined) {
      throw new Error(
        `The virtual display exited before it became ready (exit ${exitCode}).`,
      );
    }
    await runtime.wait(POLL_MS);
  }

  await stop(process, runtime);
  throw new Error(
    `The virtual display did not become ready within ${READY_BUDGET_MS}ms.`,
  );
}
