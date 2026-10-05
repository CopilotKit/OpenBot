import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { BrowserMode } from "./browser-mode";

export type DisplayProcess = {
  /** The display allocated by this exact Xvfb process, reported through -displayfd. */
  ready: Promise<string>;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => boolean;
};

export type DisplayRuntime = {
  spawn: (command: string, args: string[]) => DisplayProcess;
  wait: (milliseconds: number) => Promise<void>;
};

export type VirtualDisplay = {
  name: string;
  /** Resolves for both normal shutdown and a display that failed while the computer was running. */
  terminated: Promise<{ code: number; expected: boolean }>;
  stop: () => Promise<void>;
};

const READY_BUDGET_MS = 5_000;
const STOP_BUDGET_MS = 2_000;

async function allocatedDisplay(stream: Readable): Promise<string> {
  let response = "";
  for await (const chunk of stream) {
    response += String(chunk);
    if (response.length > 32) {
      throw new Error("Xvfb returned an invalid display number.");
    }
    if (response.includes("\n")) break;
  }

  const number = response.trim();
  if (!/^\d+$/.test(number)) {
    throw new Error("Xvfb returned an invalid display number.");
  }
  return `:${number}`;
}

const systemRuntime: DisplayRuntime = {
  spawn(command, args) {
    const child = spawn(command, args, {
      // fd 3 is private to this child. Xvfb writes its selected display there only after that display
      // is ready, so a stale socket or another X server can never satisfy our readiness check.
      stdio: ["ignore", "ignore", "inherit", "pipe"],
    });
    const exited = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
    const displayFd = child.stdio[3] as Readable | null;
    if (!displayFd)
      throw new Error("Xvfb did not expose its display descriptor.");
    return {
      ready: allocatedDisplay(displayFd),
      exited,
      kill: (signal) => child.kill(signal),
    };
  },
  wait: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

async function stop(
  process: DisplayProcess,
  runtime: DisplayRuntime,
): Promise<void> {
  process.kill("SIGTERM");
  const stopped = await Promise.race([
    process.exited.then(() => true),
    runtime.wait(STOP_BUDGET_MS).then(() => false),
  ]);
  if (!stopped) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

/** Start the local-only X display a headed computer needs. */
export async function startVirtualDisplay(
  mode: BrowserMode,
  runtime: DisplayRuntime = systemRuntime,
): Promise<VirtualDisplay | null> {
  if (mode === "headless") return null;

  const displayProcess = runtime.spawn("Xvfb", [
    "-displayfd",
    "3",
    "-screen",
    "0",
    "1280x800x24",
    "-nolisten",
    "tcp",
    "-ac",
  ]);
  let stopping = false;
  let exitCode: number | undefined;
  const exited = displayProcess.exited.then((code) => {
    exitCode = code;
    return code;
  });
  const terminated = exited.then((code) => ({ code, expected: stopping }));

  let name: string;
  try {
    name = await Promise.race([
      displayProcess.ready,
      exited.then((code) => {
        throw new Error(
          `The virtual display exited before it became ready (exit ${code}).`,
        );
      }),
      runtime.wait(READY_BUDGET_MS).then(() => {
        throw new Error(
          `The virtual display did not become ready within ${READY_BUDGET_MS}ms.`,
        );
      }),
    ]);
    if (!/^:\d+$/.test(name)) {
      throw new Error("Xvfb returned an invalid display number.");
    }
  } catch (error) {
    if (exitCode === undefined) {
      stopping = true;
      await stop(displayProcess, runtime);
    }
    throw error;
  }

  return {
    name,
    terminated,
    stop: async () => {
      if (stopping || exitCode !== undefined) return;
      stopping = true;
      await stop(displayProcess, runtime);
    },
  };
}
