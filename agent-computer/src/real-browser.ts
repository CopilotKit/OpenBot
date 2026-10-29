/**
 * THE PERSON'S OWN BROWSER: their everyday Google Chrome or Microsoft Edge, with their own profile,
 * extensions and logins, as opposed to the OpenBot-profile browser `browser-host.ts` opens. OpenBot
 * Desktop registers the Recorder with it from the store, and these routes do the two things OpenBot
 * then needs of it: bring it forward when its Recorder is connected, and open the Recorder's store
 * page in it while the Recorder is not there yet.
 *
 * Only on the host-side local Chrome computer (`COMPUTER_BROWSER_BACKEND=local-chrome`), the one that
 * runs on the person's own desktop. Every other computer runs in a container or a cluster, where
 * there is no person's browser to reach, and refuses these routes.
 *
 * NOTHING HERE DRIVES THE BROWSER. It is not started on a DevTools pipe and no Playwright reaches it:
 * the person's everyday browser is started, or handed an address, the way the person's own desktop
 * does it, and is never this process's child. That last part matters as much as the first. OpenBot
 * Desktop stops the computer by stopping its whole process tree (`stop_host_children`), so a browser
 * started as this process's child would be killed, with every tab the person had open, the next time
 * they pressed Stop. Each command below hands the browser to something else and exits:
 *
 *   - macOS: `open -b <bundle id> [url]`. LaunchServices starts or activates the browser, which
 *     launchd then owns, and opens the address in that browser rather than the default one.
 *   - Windows: the browser's executable as its App Paths entry names it, started through `cmd /c
 *     start`, which returns at once and leaves the browser without a living parent. A running Chrome
 *     or Edge takes the address over from the new process and opens it.
 *   - Linux: the browser's own launcher script beside its executable (what `google-chrome` and
 *     `microsoft-edge` on the PATH are), started in the background of a shell that exits at once.
 *
 * Under the computer token, with the person's browser id in `x-openbot-bot-id`, like the person's
 * browser routes: the server is the only caller, for the signed-in person.
 */
import { spawn } from "node:child_process";
import { posix, win32 } from "node:path";
import {
  isPersonBrowserId,
  type RealBrowser,
  realBrowserComputerPaths,
  realBrowserRequestSchema,
} from "../../shared/openbot-browser";
import type { BrowserRuntime } from "./browser-runtime";
import {
  browserExecutableCandidates,
  LINUX_LAUNCHERS as LAUNCHERS_ON_THE_PATH,
  type PersonDisplay,
  personBrowserEnv,
  runnable,
} from "./person-launch";

type Environment = Record<string, string | undefined>;

/** The person's own browsers, in the order OpenBot prefers them, as the OpenBot browser prefers them. */
const REAL_BROWSERS: readonly RealBrowser[] = ["chrome", "msedge"];

const NAMES: Record<RealBrowser, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
};

/** Each browser's macOS bundle identifier, which `open -b` finds it by wherever it is installed. */
export const MAC_BUNDLE_IDS: Record<RealBrowser, string> = {
  chrome: "com.google.Chrome",
  msedge: "com.microsoft.edgemac",
};

/** The executable each browser registers under App Paths on Windows. */
const WINDOWS_EXECUTABLES: Record<RealBrowser, string> = {
  chrome: "chrome.exe",
  msedge: "msedge.exe",
};

/** The launcher script each browser's Linux package installs beside its executable, and links onto the PATH. */
const LINUX_LAUNCHERS: Record<RealBrowser, string> = {
  chrome: "google-chrome",
  msedge: "microsoft-edge",
};

/** Why these routes are refused here: they act on a person's own desktop, which only OpenBot Desktop's computer is on. */
export const ONLY_ON_THE_PERSONS_DESKTOP =
  "The person's own browser is reached only by the computer on their own desktop (OpenBot Desktop).";

/** What the person is told when their browser was found and did not do what was asked. The reason goes to the log. */
const NOT_BROUGHT_FORWARD =
  "Your browser could not be brought forward. Open it yourself, then try again.";
const STORE_NOT_OPENED =
  "Your browser could not open the Recorder's page. Open your browser, then try again.";

/**
 * The shell line a Linux browser is started by: its own input and output on `/dev/null`, so nothing
 * holds the shell's pipes open, and the command in the background of a shell that then exits, so
 * the browser is not this process's child. The command and its arguments follow as `$@`.
 */
export const LINUX_HANDOFF = 'exec </dev/null >/dev/null 2>&1; "$@" &';

/** How long one command may take. Each hands the browser on and exits; one that does not is not waited for. */
const COMMAND_MS = 15_000;
/** How much of a command's output is kept: enough for `reg query` and a refusal. */
const OUTPUT_LIMIT = 16 * 1024;

/**
 * The store pages the Recorder can be added from, and nothing else: the address is opened in the
 * person's own signed-in browser, so it is held to a detail page on one of the two stores, over
 * https, with nothing a command line could read as anything but an address (no query, fragment,
 * escapes or credentials). `recorderStorePage` in `shared/recorder-extension.ts` builds these.
 */
const STORE_PAGE =
  /^https:\/\/(chromewebstore\.google\.com\/detail|microsoftedge\.microsoft\.com\/addons\/detail)\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

/** The address, normalised, when it is one of the stores' detail pages; otherwise null. */
export function storePage(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.search || url.hash)
    return null;
  return STORE_PAGE.test(url.href) ? url.href : null;
}

/** One command, as `spawn` takes it. `verbatim`: Windows only, the arguments are the command line as written. */
export type Command = {
  file: string;
  args: string[];
  env?: Record<string, string>;
  verbatim?: boolean;
};
export type CommandResult = {
  /** Its exit code; null when it was killed for taking too long. */
  code: number | null;
  stdout: string;
  stderr: string;
};
export type RunCommand = (command: Command) => Promise<CommandResult>;

/**
 * Run a command to its exit, with its output. Its own process group, so a signal meant for this
 * process's group never reaches it, and no console window on Windows.
 */
export const runCommand: RunCommand = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      env: command.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim ?? false,
    });
    const output = { stdout: "", stderr: "" };
    for (const name of ["stdout", "stderr"] as const)
      child[name]?.on("data", (chunk: Buffer) => {
        if (output[name].length < OUTPUT_LIMIT)
          output[name] += chunk.toString("utf8");
      });
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? null : code, ...output });
    });
  });

/**
 * The environment the person's browser starts in: this process's, which is OpenBot Desktop's and
 * so the person's session's, without what this computer was given for itself (its token, its port
 * and folders, the Recorder's build), and on Linux with the person's own display rather than the
 * virtual one a headed computer draws its Bots' browsers on. `open` and `start` pass the environment
 * on to a browser they start, and the browser keeps it for as long as the person keeps it open.
 */
export function realBrowserEnv(
  current: Environment,
  display: PersonDisplay,
  platform: string = process.platform,
): Record<string, string> {
  const shown = personBrowserEnv("native", display, current, platform);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(shown ?? current)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (
      upper.startsWith("COMPUTER_") ||
      upper.startsWith("OPENBOT_") ||
      ["PORT", "PROFILES_DIR", "WORKSPACE_DIR"].includes(upper)
    )
      continue;
    env[name] = value;
  }
  return env;
}

export type InstalledRealBrowser = { browser: RealBrowser; executable: string };

/**
 * The person's own browsers installed here, found exactly where the OpenBot browser finds them
 * (`browserExecutableCandidates`, Playwright's own stable-channel locations). Nothing is started.
 */
export async function installedRealBrowsers(
  env: Environment,
  platform: string,
  exists: (path: string) => Promise<boolean>,
): Promise<InstalledRealBrowser[]> {
  const found: InstalledRealBrowser[] = [];
  for (const browser of REAL_BROWSERS) {
    for (const executable of browserExecutableCandidates(
      browser,
      env,
      platform,
    )) {
      if (await exists(executable)) {
        found.push({ browser, executable });
        break;
      }
    }
  }
  return found;
}

/**
 * The executable a Windows App Paths entry names, from `reg query <key> /ve`. The value's name is
 * the default value's, which Windows writes in the person's own language ("(Default)",
 * "(Standard)"), so the line is found by its type. A REG_EXPAND_SZ entry has its `%NAME%`s expanded
 * as the shell would. https://learn.microsoft.com/en-us/windows/win32/shell/app-registration
 */
export function appPathFromRegQuery(
  stdout: string,
  env: Environment,
): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /\s(REG_SZ|REG_EXPAND_SZ)\s+(.*\S)\s*$/.exec(line);
    if (!match?.[2]) continue;
    let value = match[2].replace(/^"(.*)"$/, "$1");
    if (match[1] === "REG_EXPAND_SZ") {
      const upper = new Map(
        Object.entries(env).map(([name, set]) => [name.toUpperCase(), set]),
      );
      value = value.replace(
        /%([^%]+)%/g,
        (whole, name: string) => upper.get(name.toUpperCase()) ?? whole,
      );
    }
    return value;
  }
  return null;
}

/** Only an absolute path to the browser's own executable, with nothing `cmd` would read as syntax. */
function usableWindowsExecutable(path: string, browser: RealBrowser): boolean {
  return (
    win32.isAbsolute(path) &&
    !path.startsWith("\\\\") &&
    win32.basename(path).toLowerCase() === WINDOWS_EXECUTABLES[browser] &&
    !/["%^&|<>\r\n]/.test(path)
  );
}

export type RealBrowserHostOptions = {
  backend: BrowserRuntime["backend"];
  platform?: string;
  /** This process's environment, read at each request. */
  env?: () => Environment;
  /** The person's own display (Linux), from before a virtual one replaced it. */
  display?: PersonDisplay;
  /** Whether a file is there to run. The browser's own detection by default. */
  exists?: (path: string) => Promise<boolean>;
  /** How a command is run. Real by default; a test hands one that runs nothing. */
  run?: RunCommand;
};

export function createRealBrowserHost(options: RealBrowserHostOptions) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? (() => process.env);
  const exists = options.exists ?? ((path: string) => runnable(path, platform));
  const run = options.run ?? runCommand;
  const display = options.display ?? {};

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  /** A command that must exit 0, said in its own words when it does not. */
  const mustSucceed = async (command: Command): Promise<CommandResult> => {
    const result = await run(command);
    if (result.code === 0) return result;
    const said = (result.stderr || result.stdout).trim().slice(0, 500);
    throw new Error(
      `${command.file} ${result.code === null ? "did not finish" : `exited with ${result.code}`}${said ? `: ${said}` : ""}`,
    );
  };

  /**
   * Windows: the executable App Paths names, per person first and then for the machine (64-bit, then
   * the 32-bit view an older installer wrote), as `ShellExecuteEx` looks it up. One that is missing,
   * or not the browser's own, gives way to the executable the browser was found at.
   */
  const windowsExecutable = async (
    found: InstalledRealBrowser,
  ): Promise<string> => {
    const key = `\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${WINDOWS_EXECUTABLES[found.browser]}`;
    for (const args of [
      ["query", `HKCU${key}`, "/ve"],
      ["query", `HKLM${key}`, "/ve"],
      ["query", `HKLM${key}`, "/ve", "/reg:32"],
    ]) {
      const result = await run({ file: "reg.exe", args }).catch(() => null);
      if (result?.code !== 0) continue;
      const path = appPathFromRegQuery(result.stdout, env());
      if (
        path &&
        usableWindowsExecutable(path, found.browser) &&
        (await exists(path))
      )
        return path;
    }
    return found.executable;
  };

  /** Bring the browser forward, or open `url` in it; started first when it is not running. */
  const show = async (
    found: InstalledRealBrowser,
    url: string | undefined,
  ): Promise<void> => {
    const launchEnv = realBrowserEnv(env(), display, platform);
    const address = url === undefined ? [] : [url];
    if (platform === "darwin") {
      await mustSucceed({
        file: "/usr/bin/open",
        args: ["-b", MAC_BUNDLE_IDS[found.browser], ...address],
        env: launchEnv,
      });
      return;
    }
    if (platform === "win32") {
      const executable = await windowsExecutable(found);
      if (!usableWindowsExecutable(executable, found.browser))
        throw new Error(`${executable} cannot be started safely.`);
      /*
       * `start` returns as soon as the browser is started, so the browser outlives `cmd` with no
       * parent and is not in this computer's process tree. The first, empty, quoted argument is the
       * window title `start` would otherwise take the executable's path for. `/s` takes off the outer
       * quotes, and the arguments go as written, because the usual quoting of each one is not how
       * `cmd` reads a line. Both values were checked above to hold nothing `cmd` treats as syntax.
       * Chrome and Edge, already running, take the new process's command line over and let the
       * running browser come to the front (`AllowSetForegroundWindow`, Chromium's
       * `chrome_process_finder.cc`).
       */
      const line = [
        `start ""`,
        `"${executable}"`,
        ...address.map((a) => `"${a}"`),
      ];
      await mustSucceed({
        file: "cmd.exe",
        args: ["/d", "/s", "/c", `"${line.join(" ")}"`],
        env: launchEnv,
        verbatim: true,
      });
      return;
    }
    if (platform === "linux") {
      // Found as the launcher on the PATH itself (a distribution that keeps the browser elsewhere), it is the launcher.
      const launcher = LAUNCHERS_ON_THE_PATH[found.browser].includes(
        posix.basename(found.executable),
      )
        ? found.executable
        : posix.join(
            posix.dirname(found.executable),
            LINUX_LAUNCHERS[found.browser],
          );
      if (!(await exists(launcher)))
        throw new Error(`${launcher} is not there to start.`);
      /*
       * Handed to init (or the session's subreaper) by `LINUX_HANDOFF`. A running browser takes the
       * command line over and opens a window, or the address, and the window manager brings it
       * forward.
       */
      await mustSucceed({
        file: "/bin/sh",
        args: [
          "-c",
          LINUX_HANDOFF,
          "openbot-real-browser",
          launcher,
          ...address,
        ],
        env: launchEnv,
      });
      return;
    }
    throw new Error(`A person's own browser is not supported on ${platform}.`);
  };

  async function handle(
    request: Request,
    pathname: string,
    botId: string,
  ): Promise<Response> {
    if (options.backend !== "local-chrome")
      return json({ error: ONLY_ON_THE_PERSONS_DESKTOP }, 404);
    if (!isPersonBrowserId(botId))
      return json(
        {
          error:
            "The person's own browser is for a person: send their browser id (person- and 32 hex digits) in x-openbot-bot-id.",
        },
        400,
      );
    const method =
      pathname === realBrowserComputerPaths.installed ? "GET" : "POST";
    if (request.method !== method)
      return json({ error: `Use ${method} for ${pathname}.` }, 405);

    if (pathname === realBrowserComputerPaths.installed) {
      const found = await installedRealBrowsers(env(), platform, exists);
      return json({ browsers: found.map((each) => each.browser) });
    }

    const parsed = realBrowserRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return json(
        { error: `${where}${issue?.message ?? "That request is not valid."}` },
        400,
      );
    }
    const { browser } = parsed.data;
    let url: string | undefined;
    if (pathname === realBrowserComputerPaths.front) {
      if (parsed.data.url !== undefined)
        return json(
          {
            error:
              "Bringing a browser forward opens no address. Open a store page with the store route.",
          },
          400,
        );
    } else {
      url =
        parsed.data.url === undefined
          ? undefined
          : (storePage(parsed.data.url) ?? undefined);
      if (!url)
        return json(
          {
            error:
              "url: Only a Chrome Web Store or Microsoft Edge Add-ons detail page opens here.",
          },
          400,
        );
    }

    const found = (await installedRealBrowsers(env(), platform, exists)).find(
      (each) => each.browser === browser,
    );
    if (!found)
      return json(
        { error: `${NAMES[browser]} is not installed on this computer.` },
        409,
      );
    const arrived = Date.now();
    try {
      await show(found, url);
    } catch (error) {
      console.info(
        JSON.stringify({
          type: "computer-real-browser-failed",
          botId,
          path: pathname,
          browser,
          error: error instanceof Error ? error.message : String(error),
          ms: Date.now() - arrived,
        }),
      );
      return json(
        { error: url === undefined ? NOT_BROUGHT_FORWARD : STORE_NOT_OPENED },
        502,
      );
    }
    return json({ ok: true });
  }

  return { handle };
}

export type RealBrowserHost = ReturnType<typeof createRealBrowserHost>;

/** Whether a path is one of these routes, so the dispatcher hands it over. */
export function isRealBrowserPath(pathname: string): boolean {
  return (Object.values(realBrowserComputerPaths) as string[]).includes(
    pathname,
  );
}
