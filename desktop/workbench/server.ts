// Starts the workbench's Vite server, or reuses one that already runs. For the browser tests and the CLI.
export const WORKBENCH_URL = "http://localhost:3021";

const CLIENT_URL = `${WORKBENCH_URL}/@vite/client`;
const POLL_MS = 200;
const START_TIMEOUT_MS = 30_000;

// The desktop folder: this file is desktop/workbench/server.ts.
const DESKTOP_DIR = `${import.meta.dir}/..`;

async function answers(): Promise<boolean> {
  try {
    return (await fetch(CLIENT_URL)).ok;
  } catch {
    return false;
  }
}

export async function ensureServer(): Promise<{
  url: string;
  started: boolean;
  stop(): Promise<void>;
}> {
  if (await answers()) {
    return { url: WORKBENCH_URL, started: false, stop: async () => {} };
  }

  // `bun x vite` finds node_modules/.bin/vite of the desktop package from this cwd.
  const proc = Bun.spawn(
    ["bun", "x", "vite", "--config", "vite.workbench.config.ts"],
    { cwd: DESKTOP_DIR, stdout: "pipe", stderr: "pipe" },
  );
  let stderr = "";
  const drain = async (stream: ReadableStream<Uint8Array>, keep: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (keep) stderr += decoder.decode(value);
    }
  };
  // Both pipes stay drained so a full pipe cannot stop the server.
  const stderrDone = drain(proc.stderr, true);
  void drain(proc.stdout, false).catch(() => {});

  const stop = async () => {
    proc.kill();
    await proc.exited;
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await answers()) return { url: WORKBENCH_URL, started: true, stop };
    if (proc.exitCode !== null) break;
    await Bun.sleep(POLL_MS);
  }
  await stop();
  await stderrDone.catch(() => {});
  throw new Error(`The workbench server did not start.\n${stderr}`);
}
