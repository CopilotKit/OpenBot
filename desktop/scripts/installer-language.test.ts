/**
 * The Windows installer asks to close a running OpenBot in plain words.
 *
 * Installing over a running OpenBot showed NSIS's stock "OpenBot is running! Click OK to kill it",
 * from Tauri's English.nsh. Tauri 2 replaces that file with one named in
 * bundle > windows > nsis > customLanguageFiles (https://v2.tauri.app/reference/config/), so
 * src-tauri/windows/installer-english.nsh is Tauri's English.nsh with the three running-app
 * messages rewritten. The installer and the uninstaller both show them, with OK and Cancel.
 *
 * The file replaces Tauri's whole English table, so it has to define every string Tauri's
 * template uses. That list belongs to the Tauri CLI version it was copied from, which is pinned
 * here against desktop/bun.lock: a CLI upgrade fails this test until the file is compared again.
 *
 * Plain file reads only, so it runs on any runner.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const desktop = join(import.meta.dir, "..");
const tauri = join(desktop, "src-tauri");
const readJson = (file: string) =>
  JSON.parse(readFileSync(join(tauri, file), "utf8"));

type Json = Record<string, unknown>;

/** RFC 7396 merge, as `tauri build --config` lays an overlay on tauri.conf.json. */
function merge(base: unknown, patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    return patch;
  const out: Json =
    typeof base === "object" && base !== null && !Array.isArray(base)
      ? { ...(base as Json) }
      : {};
  for (const [key, value] of Object.entries(patch as Json)) {
    if (value === null) delete out[key];
    else out[key] = merge(out[key], value);
  }
  return out;
}

const nsisOf = (config: unknown) =>
  (config as { bundle?: { windows?: { nsis?: Json } } }).bundle?.windows
    ?.nsis ?? {};

const LANGUAGE_FILE = "./windows/installer-english.nsh";

/** The Tauri CLI whose English.nsh the file was copied from. */
const COPIED_FROM_CLI = "2.11.4";

/** Every string Tauri 2.11.4's installer.nsi and utils.nsh read from the English table. */
const TAURI_STRINGS = [
  "addOrReinstall",
  "alreadyInstalled",
  "alreadyInstalledLong",
  "appRunning",
  "appRunningOkKill",
  "chooseMaintenanceOption",
  "choowHowToInstall",
  "createDesktop",
  "deleteAppData",
  "dontUninstall",
  "dontUninstallDowngrade",
  "failedToKillApp",
  "installingWebview2",
  "newerVersionInstalled",
  "older",
  "olderOrUnknownVersionInstalled",
  "silentDowngrades",
  "unableToUninstall",
  "uninstallApp",
  "uninstallBeforeInstalling",
  "unknown",
  "webview2AbortError",
  "webview2DownloadError",
  "webview2DownloadSuccess",
  "webview2Downloading",
  "webview2InstallError",
  "webview2InstallSuccess",
];

/** The English table the file defines: string name to text. */
function englishStrings() {
  const path = join(tauri, LANGUAGE_FILE);
  expect(existsSync(path)).toBe(true);
  const strings = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^LangString (\w+) \$\{LANG_ENGLISH\} "(.*)"$/.exec(line);
    if (match) strings.set(match[1], match[2]);
  }
  return strings;
}

const builds = {
  "desktop CI": readJson("tauri.conf.json"),
  "Windows signing": merge(
    readJson("tauri.conf.json"),
    readJson("tauri.windows-signing.conf.json"),
  ),
};

for (const [build, config] of Object.entries(builds)) {
  test(`the ${build} build uses OpenBot's English installer text`, () => {
    expect(nsisOf(config)).toMatchObject({
      languages: ["English"],
      customLanguageFiles: { English: LANGUAGE_FILE },
    });
  });
}

test("installing over a running OpenBot asks to close it in plain words", () => {
  const strings = englishStrings();
  expect(strings.get("appRunningOkKill")).toBe(
    "{{product_name}} is open. Click OK to close it and continue.",
  );
  expect(strings.get("appRunning")).toBe(
    "{{product_name}} is still open. Close it, then try again.",
  );
  expect(strings.get("failedToKillApp")).toBe(
    "Couldn't close {{product_name}}. Close it yourself, then try again.",
  );
  for (const name of ["appRunningOkKill", "appRunning", "failedToKillApp"]) {
    const text = strings.get(name) ?? "";
    expect(text).not.toMatch(/kill|running!|—/i);
  }
});

test("the file defines every string Tauri's installer reads", () => {
  const lock = readFileSync(join(desktop, "bun.lock"), "utf8");
  const locked = /"@tauri-apps\/cli": \["@tauri-apps\/cli@([^"]+)"/.exec(
    lock,
  )?.[1];
  expect(locked).toBe(COPIED_FROM_CLI);
  expect([...englishStrings().keys()].sort()).toEqual(
    [...TAURI_STRINGS].sort(),
  );
});
