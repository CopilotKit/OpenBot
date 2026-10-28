import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RealBrowser,
  realBrowserComputerPaths,
} from "../../shared/openbot-browser";
import { recorderStorePage } from "../../shared/recorder-extension";
import { runnable } from "../src/person-launch";
import {
  appPathFromRegQuery,
  type Command,
  type CommandResult,
  createRealBrowserHost,
  installedRealBrowsers,
  LINUX_HANDOFF,
  ONLY_ON_THE_PERSONS_DESKTOP,
  realBrowserEnv,
  runCommand,
  storePage,
} from "../src/real-browser";

/**
 * The person's own everyday browser, reached from the computer on their desktop: which browsers it
 * finds, what it refuses, and the exact command each OS runs to bring one forward or open the
 * Recorder's store page in it.
 *
 * NO TEST HERE STARTS OR SHOWS A BROWSER. The commands go to a stand-in that records them, and the
 * one real run of a command shape (Linux's hand-off) starts a shell script instead of a browser. The
 * running computer is asked only what never reaches the person's browser: which are installed, and
 * the refusals. Bringing the browser forward for real is the end-to-end run's.
 */
const PERSON = "person-0123456789abcdef0123456789abcdef";
const STORE_ID = "abcdefghijklmnopabcdefghijklmnop";
const CHROME_PAGE = recorderStorePage("chrome", STORE_ID);
const EDGE_PAGE = recorderStorePage("edge", STORE_ID);

type Ran = Command[];

/** A host on `platform`, its browsers at `files`, its commands recorded and answered by `answer`. */
function hostOn(
  platform: string,
  options: {
    files?: string[];
    env?: Record<string, string>;
    answer?: (command: Command) => CommandResult;
    backend?: "managed" | "local-chrome";
  } = {},
) {
  const ran: Ran = [];
  const files = new Set(options.files ?? []);
  const host = createRealBrowserHost({
    backend: options.backend ?? "local-chrome",
    platform,
    env: () => options.env ?? {},
    display: { DISPLAY: ":0" },
    exists: async (path) => files.has(path),
    run: async (command) => {
      ran.push(command);
      return options.answer?.(command) ?? { code: 0, stdout: "", stderr: "" };
    },
  });
  const call = (
    path: string,
    body?: unknown,
    init: { botId?: string; method?: string } = {},
  ) =>
    host.handle(
      new Request(`http://127.0.0.1${path}`, {
        method: init.method ?? (body === undefined ? "GET" : "POST"),
        ...(body === undefined
          ? {}
          : {
              body: typeof body === "string" ? body : JSON.stringify(body),
            }),
      }),
      path,
      init.botId ?? PERSON,
    );
  return { ran, call };
}

const MAC_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_EDGE =
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const LINUX_CHROME = "/opt/google/chrome/chrome";
const LINUX_EDGE = "/opt/microsoft/msedge/msedge";
const WINDOWS_ENV = {
  LOCALAPPDATA: "C:\\Users\\Pat\\AppData\\Local",
  PROGRAMFILES: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
};
const WINDOWS_CHROME =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WINDOWS_EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/** `reg query <key> /ve` as Windows prints it, with the default value's name in the person's language. */
const regAnswer = (type: string, value: string, name = "(Default)") => ({
  code: 0,
  stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n    ${name}    ${type}    ${value}\r\n\r\n`,
  stderr: "",
});
const NOT_FOUND = {
  code: 1,
  stdout: "",
  stderr:
    "ERROR: The system was unable to find the specified registry key or value.",
};

describe("which store pages may be opened", () => {
  test("the Recorder's own page in either store, as the shared helper builds it", () => {
    expect(storePage(CHROME_PAGE)).toBe(
      `https://chromewebstore.google.com/detail/${STORE_ID}`,
    );
    expect(storePage(EDGE_PAGE)).toBe(
      `https://microsoftedge.microsoft.com/addons/detail/${STORE_ID}`,
    );
    // The stores' own long form, with the listing's name before the id.
    expect(
      storePage(
        `https://chromewebstore.google.com/detail/openbot-recorder/${STORE_ID}`,
      ),
    ).toBe(
      `https://chromewebstore.google.com/detail/openbot-recorder/${STORE_ID}`,
    );
    // Normalised as a browser would: the host's case and a default port change nothing.
    expect(
      storePage(`https://ChromeWebStore.Google.com:443/detail/${STORE_ID}`),
    ).toBe(`https://chromewebstore.google.com/detail/${STORE_ID}`);
  });

  test("nothing else: another site, another scheme, or anything a command line could misread", () => {
    for (const refused of [
      `http://chromewebstore.google.com/detail/${STORE_ID}`,
      `https://chromewebstore.google.com.example.com/detail/${STORE_ID}`,
      `https://example.com/detail/${STORE_ID}`,
      `https://accounts.google.com/detail/${STORE_ID}`,
      "https://chromewebstore.google.com/",
      "https://chromewebstore.google.com/detail/",
      `https://chromewebstore.google.com/category/${STORE_ID}`,
      `https://microsoftedge.microsoft.com/detail/${STORE_ID}`,
      `https://chromewebstore.google.com/detail/${STORE_ID}?hl=en`,
      `https://chromewebstore.google.com/detail/${STORE_ID}#reviews`,
      `https://pat:secret@chromewebstore.google.com/detail/${STORE_ID}`,
      `https://chromewebstore.google.com:8443/detail/${STORE_ID}`,
      `https://chromewebstore.google.com/detail/${STORE_ID}%22%26calc`,
      `https://chromewebstore.google.com/detail/a"&calc`,
      "javascript:alert(1)",
      "file:///etc/passwd",
      "chrome://settings",
      "not an address",
    ])
      expect(storePage(refused)).toBeNull();
  });
});

describe("what the person's browser is started with", () => {
  test("the person's session, without what the computer was given for itself", () => {
    const env = realBrowserEnv(
      {
        HOME: "/Users/pat",
        PATH: "/usr/bin:/bin",
        LANG: "en_GB.UTF-8",
        COMPUTER_TOKEN: "computer-secret",
        COMPUTER_BROWSER_BACKEND: "local-chrome",
        OPENBOT_RECORDER_DIR: "/deployment/extension/dist",
        PORT: "4101",
        PROFILES_DIR: "/data/profiles",
        WORKSPACE_DIR: "/data/workspace",
      },
      {},
      "darwin",
    );
    expect(env).toEqual({
      HOME: "/Users/pat",
      PATH: "/usr/bin:/bin",
      LANG: "en_GB.UTF-8",
    });
  });

  test("on Linux, the person's own display rather than the virtual one Bots' browsers use", () => {
    const env = realBrowserEnv(
      { HOME: "/home/pat", DISPLAY: ":99", COMPUTER_TOKEN: "computer-secret" },
      { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
      "linux",
    );
    expect(env).toEqual({
      HOME: "/home/pat",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
    });
  });
});

describe("finding the person's own browsers", () => {
  test("where the OpenBot browser finds them, in its order, on each OS", async () => {
    const at = (files: string[]) => async (path: string) =>
      files.includes(path);
    expect(
      await installedRealBrowsers({}, "darwin", at([MAC_EDGE, MAC_CHROME])),
    ).toEqual([
      { browser: "chrome", executable: MAC_CHROME },
      { browser: "msedge", executable: MAC_EDGE },
    ]);
    expect(await installedRealBrowsers({}, "linux", at([LINUX_EDGE]))).toEqual([
      { browser: "msedge", executable: LINUX_EDGE },
    ]);
    expect(
      await installedRealBrowsers(WINDOWS_ENV, "win32", at([WINDOWS_EDGE])),
    ).toEqual([{ browser: "msedge", executable: WINDOWS_EDGE }]);
    expect(await installedRealBrowsers({}, "darwin", at([]))).toEqual([]);
  });

  /*
   * On Linux only `/opt/google/chrome` and `/opt/microsoft/msedge` used to be looked in, so a browser a distribution
   * keeps anywhere else was never found. Google's and Microsoft's own packages use `/opt` on every
   * distribution; NixOS keeps the browser in its store, behind the vendor's launcher name on the PATH. A Flatpak's
   * exported launcher and the Snap Store's Chromium are not the person's Chrome or Edge, and cannot open here.
   */
  test("on Linux, the vendors' own packages first, then the browser's launcher on the PATH, and never a Flatpak or a Snap", async () => {
    const at = (files: string[]) => async (path: string) =>
      files.includes(path);
    const nixos = {
      PATH: "/run/wrappers/bin:/home/pat/.nix-profile/bin:/run/current-system/sw/bin",
    };
    const nixChrome = "/run/current-system/sw/bin/google-chrome-stable";
    const nixEdge = "/home/pat/.nix-profile/bin/microsoft-edge";
    expect(
      await installedRealBrowsers(nixos, "linux", at([nixChrome, nixEdge])),
    ).toEqual([
      { browser: "chrome", executable: nixChrome },
      { browser: "msedge", executable: nixEdge },
    ]);
    // A vendor package links its launcher onto the PATH too, and is found where the browser itself is.
    expect(
      await installedRealBrowsers(
        { PATH: "/usr/bin" },
        "linux",
        at([LINUX_CHROME, "/usr/bin/google-chrome-stable"]),
      ),
    ).toEqual([{ browser: "chrome", executable: LINUX_CHROME }]);
    const flatpakAndSnap = {
      PATH: "/var/lib/flatpak/exports/bin:/home/pat/.local/share/flatpak/exports/bin:/snap/bin:/usr/bin",
    };
    expect(
      await installedRealBrowsers(
        flatpakAndSnap,
        "linux",
        at([
          "/var/lib/flatpak/exports/bin/com.google.Chrome",
          "/home/pat/.local/share/flatpak/exports/bin/com.microsoft.Edge",
          "/snap/bin/chromium",
        ]),
      ),
    ).toEqual([]);
    // A PATH entry that is not a folder anybody named is not looked in.
    expect(
      await installedRealBrowsers(
        { PATH: ":bin:." },
        "linux",
        at(["google-chrome", "bin/google-chrome", "./google-chrome"]),
      ),
    ).toEqual([]);
  });

  test("answers the browsers installed, and runs nothing", async () => {
    const { ran, call } = hostOn("darwin", { files: [MAC_EDGE] });
    const response = await call(realBrowserComputerPaths.installed);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ browsers: ["msedge"] });
    expect(ran).toEqual([]);
  });

  test("on this machine, the browsers that are really here", async () => {
    const platform = process.platform;
    if (!["darwin", "linux", "win32"].includes(platform)) return;
    const host = createRealBrowserHost({ backend: "local-chrome" });
    const response = await host.handle(
      new Request("http://127.0.0.1/browser/real"),
      realBrowserComputerPaths.installed,
      PERSON,
    );
    const expected = await installedRealBrowsers(
      process.env,
      platform,
      (path) => runnable(path, platform),
    );
    expect(await response.json()).toEqual({
      browsers: expected.map((each) => each.browser),
    });
  });
});

describe("bringing the person's browser forward, and opening the store page in it", () => {
  test("macOS: `open -b` with the browser's bundle id, and the page for that browser alone", async () => {
    const { ran, call } = hostOn("darwin", {
      files: [MAC_CHROME, MAC_EDGE],
      env: { HOME: "/Users/pat", COMPUTER_TOKEN: "computer-secret" },
    });
    expect(
      (await call(realBrowserComputerPaths.front, { browser: "chrome" }))
        .status,
    ).toBe(200);
    const stored = await call(realBrowserComputerPaths.store, {
      browser: "msedge",
      url: EDGE_PAGE,
    });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ ok: true });
    expect(ran).toEqual([
      {
        file: "/usr/bin/open",
        args: ["-b", "com.google.Chrome"],
        env: { HOME: "/Users/pat" },
      },
      {
        file: "/usr/bin/open",
        args: ["-b", "com.microsoft.edgemac", EDGE_PAGE],
        env: { HOME: "/Users/pat" },
      },
    ]);
  });

  test("Windows: the executable App Paths names, started through `start` so it is nobody's child", async () => {
    const { ran, call } = hostOn("win32", {
      files: [WINDOWS_CHROME],
      env: { ...WINDOWS_ENV, COMPUTER_TOKEN: "computer-secret" },
      answer: (command) =>
        command.file === "reg.exe" && command.args[1]?.startsWith("HKCU")
          ? regAnswer("REG_SZ", WINDOWS_CHROME)
          : { code: 0, stdout: "", stderr: "" },
    });
    const response = await call(realBrowserComputerPaths.store, {
      browser: "chrome",
      url: CHROME_PAGE,
    });
    expect(response.status).toBe(200);
    expect(ran).toEqual([
      {
        file: "reg.exe",
        args: [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
          "/ve",
        ],
      },
      {
        file: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          `"start "" "${WINDOWS_CHROME}" "${CHROME_PAGE}""`,
        ],
        env: WINDOWS_ENV,
        verbatim: true,
      },
    ]);
  });

  test("Windows: the machine's App Paths entry when the person has none, expanded as the shell would", async () => {
    const { ran, call } = hostOn("win32", {
      files: [WINDOWS_EDGE],
      env: WINDOWS_ENV,
      answer: (command) => {
        if (command.file !== "reg.exe")
          return { code: 0, stdout: "", stderr: "" };
        if (command.args[1]?.startsWith("HKCU")) return NOT_FOUND;
        return regAnswer(
          "REG_EXPAND_SZ",
          "%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe",
          "(Standard)",
        );
      },
    });
    expect(
      (await call(realBrowserComputerPaths.front, { browser: "msedge" }))
        .status,
    ).toBe(200);
    expect(ran.map((command) => command.args)).toEqual([
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
        "/ve",
      ],
      [
        "query",
        "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
        "/ve",
      ],
      ["/d", "/s", "/c", `"start "" "${WINDOWS_EDGE}""`],
    ]);
  });

  test("Windows: where App Paths names nothing usable, the executable the browser was found at", async () => {
    for (const answer of [
      () => NOT_FOUND,
      // Another program's, or one `cmd` would read as syntax: never started.
      () => regAnswer("REG_SZ", "C:\\Tools\\evil.exe"),
      () => regAnswer("REG_SZ", 'C:\\x" & calc & "\\chrome.exe'),
      () => regAnswer("REG_SZ", "chrome.exe"),
    ]) {
      const { ran, call } = hostOn("win32", {
        files: [WINDOWS_CHROME, "C:\\Tools\\evil.exe"],
        env: WINDOWS_ENV,
        answer: (command) =>
          command.file === "reg.exe"
            ? answer()
            : { code: 0, stdout: "", stderr: "" },
      });
      expect(
        (await call(realBrowserComputerPaths.front, { browser: "chrome" }))
          .status,
      ).toBe(200);
      expect(ran.filter((command) => command.file === "reg.exe")).toHaveLength(
        3,
      );
      expect(ran.at(-1)?.args.at(-1)).toBe(`"start "" "${WINDOWS_CHROME}""`);
    }
  });

  test("Linux: the browser's own launcher beside it, handed off by a shell that exits, on the person's display", async () => {
    const launcher = "/opt/microsoft/msedge/microsoft-edge";
    const chromeLauncher = "/opt/google/chrome/google-chrome";
    const { ran, call } = hostOn("linux", {
      files: [LINUX_EDGE, launcher, LINUX_CHROME, chromeLauncher],
      env: { HOME: "/home/pat", DISPLAY: ":99", COMPUTER_TOKEN: "s" },
    });
    expect(
      (
        await call(realBrowserComputerPaths.store, {
          browser: "msedge",
          url: EDGE_PAGE,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(realBrowserComputerPaths.front, { browser: "chrome" }))
        .status,
    ).toBe(200);
    const shown = { HOME: "/home/pat", DISPLAY: ":0" };
    expect(ran).toEqual([
      {
        file: "/bin/sh",
        args: [
          "-c",
          LINUX_HANDOFF,
          "openbot-real-browser",
          launcher,
          EDGE_PAGE,
        ],
        env: shown,
      },
      {
        file: "/bin/sh",
        args: ["-c", LINUX_HANDOFF, "openbot-real-browser", chromeLauncher],
        env: shown,
      },
    ]);
  });

  test("Linux: a browser found by its launcher on the PATH is started by that launcher", async () => {
    const nixChrome = "/run/current-system/sw/bin/google-chrome-stable";
    const { ran, call } = hostOn("linux", {
      files: [nixChrome],
      env: { PATH: "/run/current-system/sw/bin", DISPLAY: ":99" },
    });
    expect(
      (await call(realBrowserComputerPaths.front, { browser: "chrome" }))
        .status,
    ).toBe(200);
    expect(ran).toEqual([
      {
        file: "/bin/sh",
        args: ["-c", LINUX_HANDOFF, "openbot-real-browser", nixChrome],
        env: { PATH: "/run/current-system/sw/bin", DISPLAY: ":0" },
      },
    ]);
  });

  test("Linux: a browser whose launcher is missing is not started blind", async () => {
    const { ran, call } = hostOn("linux", { files: [LINUX_CHROME] });
    const response = await call(realBrowserComputerPaths.front, {
      browser: "chrome",
    });
    expect(response.status).toBe(502);
    expect(ran).toEqual([]);
  });

  test("a browser that is not installed is said so, and nothing is started", async () => {
    const { ran, call } = hostOn("darwin", { files: [MAC_EDGE] });
    const response = await call(realBrowserComputerPaths.front, {
      browser: "chrome",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Google Chrome is not installed on this computer.",
    });
    expect(ran).toEqual([]);
  });

  test("a command that fails is a refusal the person can act on, and its words go to the log", async () => {
    const { call } = hostOn("darwin", {
      files: [MAC_CHROME],
      answer: () => ({
        code: 1,
        stdout: "",
        stderr:
          "Unable to find application with bundle identifier com.google.Chrome",
      }),
    });
    const logged: string[] = [];
    const info = console.info;
    console.info = (line: string) => logged.push(line);
    try {
      const front = await call(realBrowserComputerPaths.front, {
        browser: "chrome",
      });
      expect(front.status).toBe(502);
      expect(await front.json()).toEqual({
        error:
          "Your browser could not be brought forward. Open it yourself, then try again.",
      });
      const store = await call(realBrowserComputerPaths.store, {
        browser: "chrome",
        url: CHROME_PAGE,
      });
      expect(store.status).toBe(502);
      expect(await store.json()).toEqual({
        error:
          "Your browser could not open the Recorder's page. Open your browser, then try again.",
      });
    } finally {
      console.info = info;
    }
    expect(logged).toHaveLength(2);
    expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({
      type: "computer-real-browser-failed",
      browser: "chrome",
      error:
        "/usr/bin/open exited with 1: Unable to find application with bundle identifier com.google.Chrome",
    });
  });
});

describe("what the routes refuse", () => {
  test("every computer but the one on the person's desktop, before reading anything", async () => {
    const { ran, call } = hostOn("darwin", {
      backend: "managed",
      files: [MAC_CHROME],
    });
    for (const [path, body] of [
      [realBrowserComputerPaths.installed, undefined],
      [realBrowserComputerPaths.front, { browser: "chrome" }],
      [realBrowserComputerPaths.store, { browser: "chrome", url: CHROME_PAGE }],
    ] as const) {
      const response = await call(path, body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: ONLY_ON_THE_PERSONS_DESKTOP,
      });
    }
    expect(ran).toEqual([]);
  });

  test("a Bot's id, or none", async () => {
    const { ran, call } = hostOn("darwin", { files: [MAC_CHROME] });
    for (const botId of ["shared", "sales-bot", "person-123"]) {
      expect(
        (
          await call(
            realBrowserComputerPaths.front,
            { browser: "chrome" },
            { botId },
          )
        ).status,
      ).toBe(400);
      expect(
        (await call(realBrowserComputerPaths.installed, undefined, { botId }))
          .status,
      ).toBe(400);
    }
    expect(ran).toEqual([]);
  });

  test("a request the contract does not allow, or one that asks the wrong route", async () => {
    const { ran, call } = hostOn("darwin", { files: [MAC_CHROME, MAC_EDGE] });
    const refusals: [string, unknown, number][] = [
      [realBrowserComputerPaths.front, "not json", 400],
      [realBrowserComputerPaths.front, {}, 400],
      [realBrowserComputerPaths.front, { browser: "chromium" }, 400],
      [realBrowserComputerPaths.front, { browser: "safari" }, 400],
      [realBrowserComputerPaths.front, { browser: "chrome", extra: 1 }, 400],
      // Forward opens no address: a page goes through the store route, which checks it.
      [
        realBrowserComputerPaths.front,
        { browser: "chrome", url: CHROME_PAGE },
        400,
      ],
      [realBrowserComputerPaths.store, { browser: "chrome" }, 400],
      [
        realBrowserComputerPaths.store,
        { browser: "chrome", url: "https://example.com/" },
        400,
      ],
      [
        realBrowserComputerPaths.store,
        { browser: "chrome", url: `${CHROME_PAGE}?ref=openbot` },
        400,
      ],
      [
        realBrowserComputerPaths.store,
        { browser: "chrome", url: "not a url" },
        400,
      ],
    ];
    for (const [path, body, status] of refusals) {
      const response = await call(path, body);
      expect({ path, body, status: response.status }).toEqual({
        path,
        body,
        status,
      });
    }
    expect(
      (
        await call(realBrowserComputerPaths.installed, undefined, {
          method: "POST",
        })
      ).status,
    ).toBe(405);
    expect(
      (await call(realBrowserComputerPaths.front, undefined, { method: "GET" }))
        .status,
    ).toBe(405);
    expect(ran).toEqual([]);
  });

  test("a Chrome Web Store page may open in Edge, which installs from it too", async () => {
    const { ran, call } = hostOn("darwin", { files: [MAC_EDGE] });
    const browser: RealBrowser = "msedge";
    expect(
      (
        await call(realBrowserComputerPaths.store, {
          browser,
          url: CHROME_PAGE,
        })
      ).status,
    ).toBe(200);
    expect(ran[0]?.args).toEqual(["-b", "com.microsoft.edgemac", CHROME_PAGE]);
  });
});

describe("reading App Paths", () => {
  test("the default value, whatever the person's language calls it", () => {
    for (const name of ["(Default)", "(Standard)", "(Par défaut)", "(既定)"])
      expect(
        appPathFromRegQuery(
          regAnswer("REG_SZ", WINDOWS_CHROME, name).stdout,
          {},
        ),
      ).toBe(WINDOWS_CHROME);
  });

  test("quotes taken off, and an expandable value expanded by any case of its names", () => {
    expect(
      appPathFromRegQuery(
        regAnswer("REG_SZ", `"${WINDOWS_CHROME}"`).stdout,
        {},
      ),
    ).toBe(WINDOWS_CHROME);
    expect(
      appPathFromRegQuery(
        regAnswer(
          "REG_EXPAND_SZ",
          "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe",
        ).stdout,
        { LOCALAPPDATA: "C:\\Users\\Pat\\AppData\\Local" },
      ),
    ).toBe(
      "C:\\Users\\Pat\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    );
    expect(appPathFromRegQuery("", {})).toBeNull();
    expect(appPathFromRegQuery(NOT_FOUND.stderr, {})).toBeNull();
  });
});

describe("the commands, run for real", () => {
  const scratch: string[] = [];
  afterAll(async () => {
    await Promise.all(
      scratch.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test("a command's exit code and output, and a missing one refused", async () => {
    if (process.platform === "win32") return;
    expect(
      await runCommand({
        file: "/bin/sh",
        args: ["-c", 'echo "out $1"; echo err >&2; exit 3', "sh", "one"],
      }),
    ).toEqual({ code: 3, stdout: "out one\n", stderr: "err\n" });
    await expect(
      runCommand({ file: "/nonexistent/openbot-browser", args: [] }),
    ).rejects.toThrow();
  });

  test("Linux's hand-off returns at once and leaves what it started nobody's child but the system's", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "openbot-real-browser-"));
    scratch.push(dir);
    const said = join(dir, "said");
    // Stands in for the browser: it outlives the shell that started it, and says who its parent is
    // once that shell has gone.
    const browser = join(dir, "browser.sh");
    await Bun.write(
      browser,
      `#!/bin/sh\nsleep 1\necho "$PPID $1" > "${said}"\n`,
    );
    await Bun.spawn(["chmod", "+x", browser]).exited;
    const started = Date.now();
    const result = await runCommand({
      file: "/bin/sh",
      args: ["-c", LINUX_HANDOFF, "openbot-real-browser", browser, CHROME_PAGE],
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeLessThan(900);
    const deadline = Date.now() + 10_000;
    let text = "";
    while (Date.now() < deadline) {
      text = await readFile(said, "utf8").catch(() => "");
      if (text) break;
      await Bun.sleep(50);
    }
    const [parent, address] = text.trim().split(" ");
    expect(address).toBe(CHROME_PAGE);
    expect(Number(parent)).not.toBe(process.pid);
    expect(Number(parent)).toBeGreaterThan(0);
  });
});

/*
 * Through the running computer: its token, its dispatcher, and what a person's browser id may reach.
 * The local Chrome backend runs only headed, which on Linux starts the computer's own X server, so
 * this runs where it needs none (macOS and Windows), or on Linux when that is asked for.
 */
const canRunLocal =
  process.platform !== "linux" || process.env.OPENBOT_HEADED_BROWSER === "1";
const TOKEN = "real-browser-computer-token";

type Computer = { base: string; child: ReturnType<typeof Bun.spawn> };
const computers: Computer[] = [];
let root = "";

async function freePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const { port } = probe;
  await probe.stop(true);
  if (port === undefined) throw new Error("The port probe did not listen.");
  return port;
}

async function startComputer(
  name: string,
  env: Record<string, string>,
): Promise<Computer> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      EGRESS_POLICY_REQUIRED: "0",
      PROFILES_DIR: join(root, name, "profiles"),
      WORKSPACE_DIR: join(root, name, "workspace"),
      ...env,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const computer = { base, child };
  computers.push(computer);
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`The computer exited with ${child.exitCode}.`);
    const ready = await fetch(`${base}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return computer;
    if (Date.now() > deadline) throw new Error("The computer did not start.");
    await Bun.sleep(50);
  }
}

function callOn(
  computer: Computer,
  path: string,
  options: { body?: unknown; botId?: string; token?: string } = {},
) {
  return fetch(`${computer.base}${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": options.token ?? TOKEN,
      "x-openbot-bot-id": options.botId ?? PERSON,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

let local: Computer;
let managed: Computer;

beforeAll(async () => {
  if (!canRunLocal) return;
  root = await mkdtemp(join(tmpdir(), "openbot-real-browser-computer-"));
  [local, managed] = await Promise.all([
    // OpenBot Desktop's: people's browsers and no Bot.
    startComputer("local", {
      COMPUTER_BROWSER_BACKEND: "local-chrome",
      COMPUTER_BROWSER_MODE: "headed",
      COMPUTER_PEOPLE_ONLY: "on",
    }),
    // A computer in a container, started for the person's browser alone, as a supervisor starts one.
    startComputer("managed", {
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      COMPUTER_BOT_ID: PERSON,
    }),
  ]);
}, 30_000);

afterAll(async () => {
  for (const running of computers) {
    running.child.kill();
    await running.child.exited;
  }
  if (root) await rm(root, { recursive: true, force: true });
}, 30_000);

describe.skipIf(!canRunLocal)(
  "the person's own browser on the running computer",
  () => {
    test("is behind the computer token", async () => {
      expect(
        (
          await callOn(local, realBrowserComputerPaths.installed, {
            token: "wrong",
          })
        ).status,
      ).toBe(401);
    });

    test("answers a person's id with the browsers installed here, and starts none", async () => {
      const response = await callOn(local, realBrowserComputerPaths.installed);
      expect(response.status).toBe(200);
      const platform = process.platform;
      const expected = await installedRealBrowsers(
        process.env,
        platform,
        (path) => runnable(path, platform),
      );
      expect(await response.json()).toEqual({
        browsers: expected.map((each) => each.browser),
      });
    });

    test("refuses a Bot's id, and every request it cannot carry out as asked", async () => {
      // A Bot never reaches the routes at all: the computer runs people's browsers alone.
      expect(
        (
          await callOn(local, realBrowserComputerPaths.front, {
            body: { browser: "chrome" },
            botId: "shared",
          })
        ).status,
      ).toBe(403);
      for (const [path, body] of [
        [
          realBrowserComputerPaths.front,
          { browser: "chrome", url: CHROME_PAGE },
        ],
        [
          realBrowserComputerPaths.store,
          { browser: "chrome", url: "https://example.com/" },
        ],
        [realBrowserComputerPaths.store, { browser: "chrome" }],
        [realBrowserComputerPaths.front, { browser: "firefox" }],
      ] as const)
        expect((await callOn(local, path, { body })).status).toBe(400);
    });

    test("is refused by a computer that is not on the person's desktop", async () => {
      for (const [path, body] of [
        [realBrowserComputerPaths.installed, undefined],
        [realBrowserComputerPaths.front, { browser: "chrome" }],
        [
          realBrowserComputerPaths.store,
          { browser: "chrome", url: CHROME_PAGE },
        ],
      ] as const) {
        const response = await callOn(managed, path, { body });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: ONLY_ON_THE_PERSONS_DESKTOP,
        });
      }
    });
  },
);
