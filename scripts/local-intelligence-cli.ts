import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  type CliResult,
  cliEnvironment,
} from "../server/src/learning/ensure-container";

/** Resolve only installed packages. Discovery must never contact a package registry. */
export async function localCliEntrypoint(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  globalRoots = [
    "/opt/homebrew/lib/node_modules/copilotkit",
    "/usr/local/lib/node_modules/copilotkit",
  ],
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const entry = async (root: string) => {
    try {
      const pkg = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      );
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.copilotkit;
      if (
        pkg.name !== "copilotkit" ||
        typeof bin !== "string" ||
        typeof pkg.version !== "string"
      )
        return;
      // Validate before sorting; stale metadata must not break other cached installs.
      Bun.semver.order(pkg.version, pkg.version);
      const path = resolve(root, bin);
      if (
        isAbsolute(relative(root, path)) ||
        relative(root, path).startsWith("..") ||
        !(await stat(path)).isFile()
      )
        return;
      return {
        path,
        version: pkg.version,
      };
    } catch {
      // Partial/stale package-cache entries are not installed CLIs.
      return;
    }
  };
  const npmPrefix =
    environment.npm_config_prefix ?? environment.NPM_CONFIG_PREFIX;
  const installed = [
    join(directory, "node_modules/copilotkit"),
    join(
      environment.BUN_INSTALL ?? join(home, ".bun"),
      "install/global/node_modules/copilotkit",
    ),
    ...(environment.APPDATA
      ? [join(environment.APPDATA, "npm/node_modules/copilotkit")]
      : []),
    ...(npmPrefix ? [join(npmPrefix, "lib/node_modules/copilotkit")] : []),
    ...globalRoots,
    ...(environment.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((bin) => join(dirname(bin), "lib/node_modules/copilotkit")),
  ];
  const candidates: { path: string; version: string; installed: boolean }[] =
    [];
  for (const root of installed) {
    const found = await entry(root);
    if (found) candidates.push({ ...found, installed: true });
  }
  // npm's npx cache is a complete installation with its dependency graph. Bun's raw
  // package cache is not, so only Bun's installed global package is considered above.
  const cacheRoot = join(
    environment.npm_config_cache ??
      environment.NPM_CONFIG_CACHE ??
      (platform === "win32"
        ? join(
            environment.LOCALAPPDATA ?? join(home, "AppData/Local"),
            "npm-cache",
          )
        : join(home, ".npm")),
    "_npx",
  );
  const names = await readdir(cacheRoot).catch(() => [] as string[]);
  for (const name of names.sort()) {
    const found = await entry(join(cacheRoot, name, "node_modules/copilotkit"));
    if (found) candidates.push({ ...found, installed: false });
  }
  candidates.sort(
    (a, b) =>
      Bun.semver.order(b.version, a.version) ||
      Number(b.installed) - Number(a.installed) ||
      a.path.localeCompare(b.path),
  );
  return candidates[0]?.path;
}

/** Execute the installed CLI with Desktop's already-resolved Bun, even with Finder's PATH. */
export async function runLocalIntelligenceCli(
  args: string[],
  directory: string,
  options: {
    signal?: AbortSignal;
    environment?: NodeJS.ProcessEnv;
    home?: string;
    timeoutMs?: number;
    globalRoots?: string[];
  } = {},
): Promise<CliResult> {
  options.signal?.throwIfAborted();
  const environment = options.environment ?? process.env;
  const entry = await localCliEntrypoint(
    directory,
    environment,
    options.home,
    options.globalRoots,
  );
  options.signal?.throwIfAborted();
  if (!entry) return { exitCode: 127, stdout: "" };
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: directory,
      env: cliEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) child.kill("SIGKILL");
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(0, 1_048_576);
    });
    child.stderr.resume();
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) reject(options.signal.reason);
      else resolveResult({ exitCode: timedOut ? 1 : exitCode, stdout });
    };
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}
