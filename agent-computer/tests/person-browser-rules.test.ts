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
import { RECORDER_EXTENSION_ID } from "../../shared/recorder-extension";
import { personMayUse } from "../src/person-access";
import {
  copyNativeMessagingHosts,
  defaultNativeMessagingHosts,
  PLAYWRIGHT_DEFAULTS_A_PERSON_DOES_NOT_GET,
  personBrowserEnv,
  personLaunchOptions,
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
      recorder: { dir: FIXTURE, id: RECORDER_EXTENSION_ID },
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

describe("launching a person's browser", () => {
  const native = personLaunchOptions(
    {
      window: "native",
      recorderDir: FIXTURE,
      headless: false,
      sandbox: true,
      botArgs: ["--disable-dev-shm-usage"],
      display: {},
    },
    { width: 1280, height: 800 },
  );

  test("a native window drops every test default that stops a person using it as their own", () => {
    for (const keptOut of [
      "--disable-extensions",
      "--disable-sync",
      "--use-mock-keychain",
      "--password-store=basic",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-popup-blocking",
      "--enable-automation",
    ])
      expect(native.ignoreDefaultArgs).toContain(keptOut);
    expect(native.ignoreDefaultArgs).toEqual([
      ...PLAYWRIGHT_DEFAULTS_A_PERSON_DOES_NOT_GET,
    ]);
    // And keeps what OpenBot's control needs: the pipe and profile are not in the list at all.
    expect(native.ignoreDefaultArgs).not.toContain("--remote-debugging-pipe");
    expect(native.ignoreDefaultArgs).not.toContain("--no-first-run");
    expect(native.args).toEqual([
      "--disable-blink-features=AutomationControlled",
      "--enable-unsafe-extension-debugging",
    ]);
    expect(native.chromiumSandbox).toBe(true);
    // A window the person resizes, in their own colour scheme.
    expect(native.viewport).toBeNull();
    expect(native.colorScheme).toBeNull();
  });

  test("the hosted browser keeps a Bot's launch, with only the Recorder let in", () => {
    const screen = personLaunchOptions(
      {
        window: "screen",
        recorderDir: FIXTURE,
        headless: true,
        sandbox: false,
        botArgs: ["--no-sandbox", "--password-store=basic"],
        display: {},
      },
      { width: 1280, height: 800 },
    );
    expect(screen.args).toEqual([
      "--no-sandbox",
      "--password-store=basic",
      `--disable-extensions-except=${FIXTURE}`,
      `--load-extension=${FIXTURE}`,
    ]);
    expect(screen.ignoreDefaultArgs).toEqual([
      "--enable-automation",
      "--disable-extensions",
    ]);
    expect(screen.viewport).toEqual({ width: 1280, height: 800 });
    expect(screen.env).toBeUndefined();
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
    const options = personLaunchOptions(
      {
        window: "native",
        recorderDir: FIXTURE,
        headless: false,
        sandbox: true,
        botArgs: [],
        display: { DISPLAY: ":0" },
      },
      { width: 1280, height: 800 },
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
