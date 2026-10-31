import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { browserRuntimeFromEnv } from "../agent-computer/src/browser-runtime";
import {
  type InstalledBrowser,
  installedBrowser,
  NO_INSTALLED_BROWSER,
} from "../agent-computer/src/person-launch";

type Environment = Record<string, string | undefined>;

/** Resolve only app-owned paths; inherited container or personal-profile paths are never reused. */
export function localChromeConfiguration(
  env: Environment,
  platform: string = process.platform,
  userHome = homedir(),
) {
  if (!env.COMPUTER_TOKEN?.trim()) {
    throw new Error(
      "COMPUTER_TOKEN is required. Use the same secret as the local OpenBot API.",
    );
  }
  if (
    env.COMPUTER_BROWSER_BACKEND?.trim() &&
    env.COMPUTER_BROWSER_BACKEND.trim() !== "local-chrome"
  ) {
    throw new Error(
      "This helper requires COMPUTER_BROWSER_BACKEND=local-chrome; unset the managed backend setting.",
    );
  }
  const path = platform === "win32" ? win32 : posix;
  const dataHome =
    platform === "darwin"
      ? path.join(userHome, "Library", "Application Support", "OpenBot")
      : platform === "win32"
        ? path.join(
            env.LOCALAPPDATA || path.join(userHome, "AppData", "Local"),
            "OpenBot",
          )
        : path.join(
            env.XDG_DATA_HOME || path.join(userHome, ".local", "share"),
            "openbot",
          );
  const root =
    env.OPENBOT_LOCAL_COMPUTER_DIR?.trim() ||
    path.join(dataHome, "local-computer");
  if (!path.isAbsolute(root))
    throw new Error("OPENBOT_LOCAL_COMPUTER_DIR must be an absolute path.");
  const port = env.PORT?.trim() || "4101";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PORT must be a whole number between 1 and 65535.");
  }
  const childEnv: Environment = {
    ...env,
    COMPUTER_BROWSER_BACKEND: "local-chrome",
    COMPUTER_BROWSER_MODE: env.COMPUTER_BROWSER_MODE?.trim() || "headed",
    COMPUTER_SANDBOX: "on",
    PORT: port,
    PROFILES_DIR: path.join(root, "profiles"),
    WORKSPACE_DIR: path.join(root, "workspace"),
  };
  browserRuntimeFromEnv(childEnv, platform);
  return { root: path.normalize(root), port: Number(port), env: childEnv };
}

/**
 * The installed browser this computer can open windows in: Google Chrome, else Microsoft Edge, each
 * at Playwright's stable-channel location and never an executable from a tool input.
 *
 * Edge because it ships with Windows, so a machine without Chrome still has a browser Google or
 * Microsoft keeps patched to open a person's own browser in. A Bot's browser here is Chrome, as
 * before: with only Edge installed, a person's browser opens and a Bot's does not.
 */
export async function requireInstalledBrowser(
  env: Environment,
  platform: string = process.platform,
): Promise<InstalledBrowser> {
  const found = await installedBrowser(env, platform);
  if (!found) throw new Error(NO_INSTALLED_BROWSER);
  return found;
}

export async function requireAvailablePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) =>
      reject(
        new Error(
          `Cannot listen on 127.0.0.1:${port}; free that port or set PORT explicitly.`,
          { cause: error },
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

async function main(): Promise<void> {
  const config = localChromeConfiguration(process.env);
  await requireInstalledBrowser(config.env);
  await requireAvailablePort(config.port);
  await mkdir(config.root, { recursive: true, mode: 0o700 });
  for (const directory of [config.env.PROFILES_DIR, config.env.WORKSPACE_DIR]) {
    if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const computerDirectory = join(import.meta.dir, "..", "agent-computer");
  console.info(
    `Starting local Chrome computer at http://127.0.0.1:${config.port}; data: ${config.root}`,
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
    cwd: computerDirectory,
    env: config.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Local Chrome startup failed.",
    );
    process.exitCode = 1;
  }
}
