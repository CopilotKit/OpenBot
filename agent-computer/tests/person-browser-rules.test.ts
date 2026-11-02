import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECORDER_EXTENSION_ID,
  RECORDER_NATIVE_HOST,
} from "../../shared/recorder-extension";
import { navigationFailure } from "../src/navigation";
import {
  computerOwner,
  NOT_ITS_OWN_COMPUTER,
  ONLY_THE_PERSONS,
  personMayUse,
  refusedHere,
} from "../src/person-access";
import { isBrowserNotInstalled, PersonOpenError } from "../src/person-browser";
import {
  browserExecutableCandidates,
  copyNativeMessagingHosts,
  defaultNativeMessagingHosts,
  forgetRecorderPins,
  PLAYWRIGHT_DEFAULTS_A_PERSON_DOES_NOT_GET,
  personBrowserEnv,
  personNativeLaunch,
  recorderLaunchOptions,
  runnable,
} from "../src/person-launch";
import {
  extensionIdFromKey,
  findRecorder,
  isRecorderSetupPage,
} from "../src/recorder";
import { addressFrom } from "../src/request-validation";

/**
 * The rules a person's browser is opened by, against real inputs: the Recorder's real key and real
 * build directories, the switches Playwright really passes, real manifest folders. The launch itself
 * is driven against real browsers in `person-browser.test.ts`.
 */

const REPO = join(import.meta.dir, "..", "..");
const FIXTURE = join(import.meta.dir, "fixtures", "recorder");
let scratch: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openbot-person-rules-"));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    scratch.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  scratch = [];
});

describe("finding the built Recorder", () => {
  test("its key gives the Recorder's one id", async () => {
    const key = await readFile(
      join(REPO, "extension", "keys", "public-key.txt"),
      "utf8",
    );
    expect(extensionIdFromKey(key.trim())).toBe(RECORDER_EXTENSION_ID);
  });

  test("a built Recorder is found, with the id its key fixes", async () => {
    const found = await findRecorder(FIXTURE);
    expect(found).toEqual({
      ok: true,
      recorder: {
        dir: FIXTURE,
        id: RECORDER_EXTENSION_ID,
        worker: "service-worker.js",
      },
    });
  });

  test("no directory, a relative one, or the Recorder's source is refused, saying which", async () => {
    const unset = await findRecorder(undefined);
    expect(unset.ok).toBe(false);
    if (!unset.ok) expect(unset.error).toContain("OPENBOT_RECORDER_DIR");

    const relative = await findRecorder("extension/dist");
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.error).toContain("absolute");

    // The usual mistake: the source, which has no manifest.json until it is built.
    const source = await findRecorder(join(REPO, "extension"));
    expect(source.ok).toBe(false);
    if (!source.ok) {
      expect(source.error).toContain("not a built OpenBot Recorder");
      expect(source.error).toContain("manifest.json");
    }
  });

  test("a manifest without a key, or without its worker, is not a Recorder", async () => {
    const manifest = JSON.parse(
      await readFile(join(FIXTURE, "manifest.json"), "utf8"),
    );
    const keyless = await tempDir();
    await writeFile(
      join(keyless, "manifest.json"),
      JSON.stringify({ ...manifest, key: undefined }),
    );
    await writeFile(join(keyless, "service-worker.js"), "");
    const noKey = await findRecorder(keyless);
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.error).toContain("no key");

    const workerless = await tempDir();
    await writeFile(
      join(workerless, "manifest.json"),
      JSON.stringify(manifest),
    );
    const noWorker = await findRecorder(workerless);
    expect(noWorker.ok).toBe(false);
    if (!noWorker.ok) expect(noWorker.error).toContain("service-worker.js");
  });

  test("its setup and connect pages are the ones a browser OpenBot opened closes", () => {
    const id = RECORDER_EXTENSION_ID;
    expect(isRecorderSetupPage(`chrome-extension://${id}/setup.html`, id)).toBe(
      true,
    );
    expect(
      isRecorderSetupPage(`chrome-extension://${id}/connect.html?from=x`, id),
    ).toBe(true);
    expect(isRecorderSetupPage(`chrome-extension://${id}/popup.html`, id)).toBe(
      false,
    );
    // Another extension's setup page is the person's business.
    expect(
      isRecorderSetupPage("chrome-extension://abcdefghijklmnop/setup.html", id),
    ).toBe(false);
  });
});

describe("finding the person's browser on Linux", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  test("the launcher on the PATH is looked for after the vendor's package, and only one that runs counts", async () => {
    // NixOS's shape: no /opt, the vendor's launcher name on the PATH.
    dir = await mkdtemp(join(tmpdir(), "openbot-linux-path-"));
    const edge = join(dir, "microsoft-edge");
    await writeFile(edge, "#!/bin/sh\nexec true\n", { mode: 0o755 });
    // Not executable: a file that happens to have the name.
    await writeFile(join(dir, "google-chrome"), "", { mode: 0o644 });
    // After the vendor's own package, which this machine may or may not have.
    expect(
      browserExecutableCandidates("msedge", { PATH: dir }, "linux"),
    ).toEqual([
      "/opt/microsoft/msedge/msedge",
      join(dir, "microsoft-edge-stable"),
      edge,
    ]);
    expect(await runnable(edge, "linux")).toBe(true);
    expect(await runnable(join(dir, "google-chrome"), "linux")).toBe(false);
    expect(await runnable(join(dir, "microsoft-edge-stable"), "linux")).toBe(
      false,
    );
  });
});

describe("launching a person's browser", () => {
  const native = personNativeLaunch(
    { dir: "/profiles/person-1", headless: false, display: {} },
    "darwin",
  );

  test("a native window starts with exactly what OpenBot's control needs, and no test default that stops a person using it as their own", () => {
    // Started without Playwright, so this is its whole command line: none of Playwright's defaults is under it.
    expect(native.args).toEqual([
      "--remote-debugging-pipe",
      "--user-data-dir=/profiles/person-1",
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-features=CDPScreenshotNewSurface",
      "--edge-skip-compat-layer-relaunch",
      "--disable-blink-features=AutomationControlled",
      "--enable-unsafe-extension-debugging",
    ]);
    for (const keptOut of [
      ...PLAYWRIGHT_DEFAULTS_A_PERSON_DOES_NOT_GET,
      // And the debugging bar stays: the person's own extensions are in it, and the bar is how they
      // see that one attached.
      "--silent-debugger-extension-api",
      // Its own startup setting decides what the first window shows.
      "about:blank",
    ])
      expect(native.args).not.toContain(keptOut);
    expect(native.env).toBeUndefined();
    // Headless only for the tests, which never open a window.
    expect(
      personNativeLaunch(
        { dir: "/profiles/person-1", headless: true, display: {} },
        "darwin",
      ).args.at(-1),
    ).toBe("--headless");
  });

  test("the hosted browser keeps a Bot's launch, with only the Recorder let in", () => {
    const screen = recorderLaunchOptions(
      {
        recorderDir: FIXTURE,
        headless: true,
        sandbox: false,
        botArgs: ["--no-sandbox", "--password-store=basic"],
      },
      { width: 1280, height: 800 },
    );
    expect(screen.args).toEqual([
      "--no-sandbox",
      "--password-store=basic",
      `--disable-extensions-except=${FIXTURE}`,
      `--load-extension=${FIXTURE}`,
      // So an earlier build of the Recorder's worker can be replaced over DevTools.
      "--enable-unsafe-extension-debugging",
      // No debugging bar to take the page's height from the live screen while the Recorder records.
      "--silent-debugger-extension-api",
    ]);
    expect(screen.ignoreDefaultArgs).toEqual([
      "--enable-automation",
      "--disable-extensions",
    ]);
    expect(screen.viewport).toEqual({ width: 1280, height: 800 });
  });
});

describe("the Recorder's toolbar pin", () => {
  test("is taken out of the profile before a launch, so the launch pins it once", async () => {
    // The desktop profile from the end-to-end run: one pin per launch, beside another extension's.
    const OTHER = "ghbmnnjooekpmoecnnnilnnbdlolhkhi";
    const profile = await tempDir();
    await mkdir(join(profile, "Default"));
    const file = join(profile, "Default", "Preferences");
    await writeFile(
      file,
      JSON.stringify({
        download: { default_directory: "/Users/pat/Downloads" },
        extensions: {
          pinned_extensions: [
            RECORDER_EXTENSION_ID,
            OTHER,
            RECORDER_EXTENSION_ID,
            RECORDER_EXTENSION_ID,
          ],
          last_chrome_version: "156.0.8078.47",
        },
      }),
    );
    await forgetRecorderPins(profile, RECORDER_EXTENSION_ID);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      download: { default_directory: "/Users/pat/Downloads" },
      extensions: {
        pinned_extensions: [OTHER],
        last_chrome_version: "156.0.8078.47",
      },
    });
  });

  test("a profile with nothing pinned, no preferences yet, or unreadable ones is left as it is", async () => {
    const fresh = await tempDir();
    await forgetRecorderPins(fresh, RECORDER_EXTENSION_ID);
    expect(await readdir(fresh)).toEqual([]);

    const halfWritten = await tempDir();
    await mkdir(join(halfWritten, "Default"));
    await writeFile(join(halfWritten, "Default", "Preferences"), '{"exten');
    await forgetRecorderPins(halfWritten, RECORDER_EXTENSION_ID);
    expect(
      await readFile(join(halfWritten, "Default", "Preferences"), "utf8"),
    ).toBe('{"exten');
  });
});

describe("the display a person's native window opens on", () => {
  // What a headed computer on Linux has done to its own environment by the time a browser starts.
  const computer = { DISPLAY: ":99", PATH: "/usr/bin" };

  test("on Linux, the person's own display rather than the computer's virtual one", () => {
    expect(
      personBrowserEnv("native", { DISPLAY: ":0" }, computer, "linux"),
    ).toEqual({ DISPLAY: ":0", PATH: "/usr/bin" });
    // A Wayland session with no X display: no X display at all, so the browser draws on Wayland.
    expect(
      personBrowserEnv(
        "native",
        { WAYLAND_DISPLAY: "wayland-0" },
        computer,
        "linux",
      ),
    ).toEqual({ WAYLAND_DISPLAY: "wayland-0", PATH: "/usr/bin" });
  });

  test("the launch carries it", () => {
    const options = personNativeLaunch(
      {
        dir: "/profiles/person-1",
        headless: false,
        display: { DISPLAY: ":0" },
      },
      "linux",
    );
    expect(options.env?.DISPLAY).toBe(":0");
  });

  test("the hosted browser, and every other platform, keep the computer's environment", () => {
    expect(
      personBrowserEnv("screen", { DISPLAY: ":0" }, computer, "linux"),
    ).toBeUndefined();
    expect(
      personBrowserEnv("native", { DISPLAY: ":0" }, computer, "darwin"),
    ).toBeUndefined();
    expect(personBrowserEnv("native", {}, computer, "win32")).toBeUndefined();
  });
});

describe("the person's password manager hookups", () => {
  test("come from the default profile of the same browser", () => {
    expect(
      defaultNativeMessagingHosts("chrome", {}, "darwin", "/Users/p"),
    ).toBe(
      "/Users/p/Library/Application Support/Google/Chrome/NativeMessagingHosts",
    );
    expect(
      defaultNativeMessagingHosts("msedge", {}, "darwin", "/Users/p"),
    ).toBe(
      "/Users/p/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
    );
    expect(defaultNativeMessagingHosts("chrome", {}, "linux", "/home/p")).toBe(
      "/home/p/.config/google-chrome/NativeMessagingHosts",
    );
    expect(
      defaultNativeMessagingHosts(
        "msedge",
        { XDG_CONFIG_HOME: "/cfg" },
        "linux",
        "/home/p",
      ),
    ).toBe("/cfg/microsoft-edge/NativeMessagingHosts");
    // Windows registers hosts in the registry, which every profile reads.
    expect(
      defaultNativeMessagingHosts("chrome", {}, "win32", "C:\\Users\\p"),
    ).toBeNull();
  });

  test("only the manifests are copied, and one the person uninstalled goes", async () => {
    const theirs = await tempDir();
    const ours = await tempDir();
    const onePassword = JSON.stringify({
      name: "com.1password.1password",
      path: "/Applications/1Password.app/Contents/Library/LoginItems/1Password Browser Helper.app/Contents/MacOS/1Password-BrowserSupport",
      type: "stdio",
      allowed_origins: ["chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/"],
    });
    await writeFile(join(theirs, "com.1password.1password.json"), onePassword);
    // An installer may link its manifest in.
    const elsewhere = await tempDir();
    await writeFile(join(elsewhere, "linked.json"), '{"name":"com.linked"}');
    await symlink(
      join(elsewhere, "linked.json"),
      join(theirs, "com.linked.json"),
    );
    // Not manifests: anything else in the folder, a folder named like one, something far too large.
    await writeFile(join(theirs, "notes.txt"), "not a manifest");
    await mkdir(join(theirs, "folder.json"));
    await writeFile(join(theirs, "huge.json"), "x".repeat(200 * 1024));
    // Copied at an earlier launch, and since uninstalled.
    await writeFile(join(ours, "com.gone.json"), "{}");

    const copied = await copyNativeMessagingHosts(theirs, ours);

    expect(copied).toEqual(["com.1password.1password.json", "com.linked.json"]);
    expect((await readdir(ours)).sort()).toEqual(copied);
    expect(
      await readFile(join(ours, "com.1password.1password.json"), "utf8"),
    ).toBe(onePassword);
  });

  test("OpenBot Desktop's own Recorder host is not copied: the launcher connects the Recorder itself", async () => {
    const theirs = await tempDir();
    const ours = join(await tempDir(), "NativeMessagingHosts");
    await writeFile(
      join(theirs, `${RECORDER_NATIVE_HOST}.json`),
      JSON.stringify({ name: RECORDER_NATIVE_HOST }),
    );
    await writeFile(
      join(theirs, "com.1password.1password.json"),
      '{"name":"com.1password.1password"}',
    );
    // Left by a launch before this rule: removed like any host that is no longer copied.
    await mkdir(ours, { recursive: true });
    await writeFile(join(ours, `${RECORDER_NATIVE_HOST}.json`), "{}");

    expect(await copyNativeMessagingHosts(theirs, ours)).toEqual([
      "com.1password.1password.json",
    ]);
    expect(await readdir(ours)).toEqual(["com.1password.1password.json"]);
  });

  test("no folder of theirs leaves ours empty", async () => {
    const ours = join(await tempDir(), "NativeMessagingHosts");
    expect(await copyNativeMessagingHosts("/nonexistent/hosts", ours)).toEqual(
      [],
    );
    expect(await readdir(ours)).toEqual([]);
  });
});

describe("what a person's browser id may reach", () => {
  test("their browser, its live screen and their own input", () => {
    for (const path of [
      "/browser/open",
      "/browser/state",
      "/browser/recording",
      "/browser/narration",
      "/browser/tabs",
      "/browser/navigate",
      "/browser/close",
      "/stream",
      "/human/click",
      "/human/type",
      "/control",
      "/egress-policy",
      "/computers/stop",
    ])
      expect(personMayUse(path)).toBe(true);
  });

  test("nothing a Bot acts or reads through", () => {
    for (const path of [
      "/navigate",
      "/click",
      "/type",
      "/key",
      "/scroll",
      "/snapshot",
      "/read",
      "/screenshot",
      "/exec",
      "/files/read",
      "/files/write",
      "/sign-in/fill",
      "/control/request",
      "/control/take",
      "/human/secret",
    ])
      expect(personMayUse(path)).toBe(false);
  });
});

describe("which computer a person's browser may run on", () => {
  const PERSON = "person-0123456789abcdef0123456789abcdef";
  const OTHER = "person-fedcba9876543210fedcba9876543210";

  test("how each deployment starts its computers says whose they are", () => {
    // Compose's and the chart's shared computer, and the all-in-one image's: nothing set.
    expect(computerOwner({})).toEqual({ kind: "shared" });
    expect(computerOwner({ COMPUTER_BOT_ID: "" })).toEqual({ kind: "shared" });
    // A supervisor's container and a Sandbox's pod, for a Bot and for a person.
    expect(computerOwner({ COMPUTER_BOT_ID: "invoice-collector" })).toEqual({
      kind: "one",
      id: "invoice-collector",
    });
    expect(computerOwner({ COMPUTER_BOT_ID: PERSON })).toEqual({
      kind: "one",
      id: PERSON,
    });
    // A person's computer, carrying every Bot they use.
    expect(computerOwner({ COMPUTER_PERSON_ID: "u-ada" })).toEqual({
      kind: "person",
      id: "u-ada",
    });
    // OpenBot Desktop's host-side computer.
    expect(computerOwner({ COMPUTER_PEOPLE_ONLY: "on" })).toEqual({
      kind: "people",
    });
    expect(computerOwner({ COMPUTER_PEOPLE_ONLY: "off" })).toEqual({
      kind: "shared",
    });
  });

  test("never beside Bots: not on the shared computer, and not on a Bot's", () => {
    for (const owner of [
      computerOwner({}),
      computerOwner({ COMPUTER_BOT_ID: "invoice-collector" }),
      // Nor on a person's own computer, where their Bots run: their browser gets a computer of its own.
      computerOwner({ COMPUTER_PERSON_ID: "u-ada" }),
    ]) {
      expect(refusedHere(owner, PERSON)).toEqual({
        status: 503,
        error: NOT_ITS_OWN_COMPUTER,
      });
      expect(refusedHere(owner, "invoice-collector")).toBeNull();
      expect(refusedHere(owner, "shared")).toBeNull();
    }
  });

  test("on a computer of its own, and nothing else there", () => {
    const own = computerOwner({ COMPUTER_BOT_ID: PERSON });
    expect(refusedHere(own, PERSON)).toBeNull();
    for (const id of [OTHER, "invoice-collector", "shared"])
      expect(refusedHere(own, id)).toEqual({
        status: 403,
        error: ONLY_THE_PERSONS,
      });
    const desktop = computerOwner({ COMPUTER_PEOPLE_ONLY: "on" });
    expect(refusedHere(desktop, PERSON)).toBeNull();
    expect(refusedHere(desktop, OTHER)).toBeNull();
    for (const id of ["invoice-collector", "shared"])
      expect(refusedHere(desktop, id)).toEqual({
        status: 403,
        error: ONLY_THE_PERSONS,
      });
  });
});

describe("an address a person types", () => {
  test("a web address, with or without its scheme", () => {
    expect(addressFrom("https://example.com/a?b=c")).toBe(
      "https://example.com/a?b=c",
    );
    expect(addressFrom(" example.com/path ")).toBe("https://example.com/path");
    expect(addressFrom("example.com:8080")).toBe("https://example.com:8080");
    expect(addressFrom("http://127.0.0.1:3000/")).toBe(
      "http://127.0.0.1:3000/",
    );
  });

  test("never the computer's files or a script", () => {
    expect(addressFrom("file:///proc/self/environ")).toBeNull();
    expect(addressFrom("javascript:alert(1)")).toBeNull();
    expect(addressFrom("chrome://settings")).toBeNull();
    expect(addressFrom("data:text/html,hi")).toBeNull();
    // A search, which the app turns into an address of its own choosing.
    expect(addressFrom("openbot recorder")).toBeNull();
    expect(addressFrom("intranet")).toBeNull();
  });
});

describe("a page that did not open, said to the person", () => {
  // Playwright 1.62.1's own messages, captured from real navigations, with the call log it appends.
  const callLog = (url: string) =>
    `\nCall log:\n\u001b[2m  - navigating to "${url}", waiting until "domcontentloaded"\u001b[22m\n`;
  const failed = (message: string, name = "Error") =>
    Object.assign(new Error(message), { name });

  test("names the address and says it did not load or was refused, never the call log", () => {
    const cases: [string, Error, string][] = [
      [
        "https://www.google.com/",
        failed(
          `goto: net::ERR_ABORTED at https://www.google.com/${callLog("https://www.google.com/")}`,
        ),
        "www.google.com did not load.",
      ],
      [
        "http://127.0.0.1:7759/",
        failed(
          `goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:7759/${callLog("http://127.0.0.1:7759/")}`,
        ),
        "127.0.0.1:7759 refused the connection.",
      ],
      [
        "http://nothing-here.invalid/",
        failed(
          `goto: net::ERR_NAME_NOT_RESOLVED at http://nothing-here.invalid/${callLog("http://nothing-here.invalid/")}`,
        ),
        "nothing-here.invalid did not load.",
      ],
      [
        "https://www.bing.com/",
        failed(
          `goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.bing.com/${callLog("https://www.bing.com/")}`,
        ),
        "www.bing.com did not load.",
      ],
      [
        "https://slow.example.com/report?id=7",
        failed(
          `goto: Timeout 30000ms exceeded.${callLog("https://slow.example.com/report?id=7")}`,
          "TimeoutError",
        ),
        "slow.example.com did not load in time.",
      ],
      [
        "http://127.0.0.1:7753/file",
        failed(
          `goto: Download is starting${callLog("http://127.0.0.1:7753/file")}`,
        ),
        "127.0.0.1:7753 started a download rather than opening a page.",
      ],
      [
        "https://intranet.example.com/",
        failed(
          `goto: net::ERR_BLOCKED_BY_ADMINISTRATOR at https://intranet.example.com/${callLog("https://intranet.example.com/")}`,
        ),
        "intranet.example.com was refused.",
      ],
    ];
    for (const [address, error, said] of cases) {
      const sentence = navigationFailure(address, error);
      expect(sentence).toBe(said);
      expect(sentence).not.toContain("Call log");
      expect(sentence).not.toContain("net::");
    }
  });
});

describe("a browser that cannot start here, said to whoever runs OpenBot", () => {
  /*
   * Playwright 1.62.1's own messages. The first two were captured from real launches on this Mac
   * (PLAYWRIGHT_BROWSERS_PATH pointing at an empty folder, and a channel whose browser is not
   * installed); the third is its Linux dependency check's, from playwright-core's own source, with the
   * box it draws around it.
   */
  const NO_CHROMIUM =
    "launchPersistentContext: Executable doesn't exist at /tmp/browsers/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing\n╔════════════════════════════════════════════════════════════╗\n║ Looks like Playwright was just installed or updated.       ║\n║ Please run the following command to download new browsers: ║\n║                                                            ║\n║     npx playwright install                                 ║\n║                                                            ║\n║ <3 Playwright Team                                         ║\n╚════════════════════════════════════════════════════════════╝";
  const NO_CHANNEL =
    "Chromium distribution 'msedge-canary' is not found at /Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary";
  const NO_LIBRARIES =
    "launchPersistentContext: \n╔══════════════════════════════════════════════════════╗\n║ Host system is missing dependencies to run browsers. ║\n║ Missing libraries:                                   ║\n║     libnss3.so                                       ║\n╚══════════════════════════════════════════════════════╝";

  test("a browser not installed, or missing what it needs to run, is the computer's setup", () => {
    for (const message of [NO_CHROMIUM, NO_CHANNEL, NO_LIBRARIES]) {
      expect(isBrowserNotInstalled(message)).toBe(true);
      expect(new PersonOpenError("launch", new Error(message)).setup).toBe(
        true,
      );
    }
    // The built Recorder's files unreadable is the computer's setup too, whatever the error says.
    expect(
      new PersonOpenError(
        "recorder-files",
        new Error(
          "ENOENT: no such file or directory, open '/recorder/service-worker.js'",
        ),
      ).setup,
    ).toBe(true);
  });

  test("a browser that is installed and failed this once is not", () => {
    for (const message of [
      // Another browser holds the profile, as one of the person's own might after a crash: Google
      // Chrome 156's refusal, captured by person-browser.test.ts (its call log cut short here).
      "launchPersistentContext: Failed to create a ProcessSingleton for your profile directory. This usually means that the profile is already in use by another instance of Chromium.\nCall log:\n  - <launching> /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --remote-debugging-pipe",
      "launchPersistentContext: Timeout 180000ms exceeded.",
      "The Recorder in this browser did not start.",
    ]) {
      expect(isBrowserNotInstalled(message)).toBe(false);
      expect(new PersonOpenError("launch", new Error(message)).setup).toBe(
        false,
      );
    }
  });
});
