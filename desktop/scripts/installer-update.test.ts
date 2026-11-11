// biome-ignore-all lint/suspicious/noTemplateCurlyInString: NSIS's own `${...}`, read as text.
/**
 * Installing a new OpenBot over an installed one never offers to delete the person's data.
 *
 * Run by hand over an installed OpenBot, Tauri's installer shows "Already Installed" with
 * "Uninstall before installing" chosen, then runs the old version's uninstaller as it is: its
 * window opens in the middle of the update, with a "Delete the application data" box. One wrong
 * tick there deleted the person's Bots and conversations during what they took for an update.
 *
 * Tauri 2's installer hooks run too late to change that: the "Already Installed" page runs the old
 * uninstaller as the person leaves it, and NSIS_HOOK_PREINSTALL runs later, in the Install section.
 * No setting changes the command either. So bundle > windows > nsis > template
 * (https://v2.tauri.app/reference/config/#nsisconfig) points at src-tauri/windows/installer.nsi,
 * which is Tauri's own template with OpenBot's lines added, and the old uninstaller runs with
 * /UPDATE and /S: as an update, which keeps the data, and silently, with no window and no box.
 *
 * The template is Tauri's file, so it is held to the Tauri CLI it was copied from, pinned against
 * desktop/bun.lock: a CLI upgrade fails this test until the file is copied again.
 *
 * Plain file reads only, so it runs on any runner. Windows CI runs the real installer over itself
 * (scripts/test-windows-installer-update.ps1).
 */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

const TEMPLATE = "./windows/installer.nsi";

/** The Tauri CLI whose installer.nsi the template was copied from. */
const COPIED_FROM_CLI = "2.11.4";

/**
 * SHA-256 of installer.nsi at tauri-cli-v2.11.4,
 * crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi.
 */
const TAURI_TEMPLATE_SHA256 =
  "20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079";

const template = () => {
  const path = join(tauri, TEMPLATE);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8");
};

/** The template without OpenBot's blocks, `; >>> OpenBot` to `; <<< OpenBot`. */
function tauriPart(text: string) {
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "; >>> OpenBot") {
      expect(inside).toBe(false);
      inside = true;
    } else if (line.trim() === "; <<< OpenBot") {
      expect(inside).toBe(true);
      inside = false;
    } else if (!inside) kept.push(line);
  }
  expect(inside).toBe(false);
  return kept.join("\n");
}

/** The text between `start` and the first `end` after it. */
function between(text: string, start: string, end: string) {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return text.slice(from + start.length, to);
}

const builds = {
  "desktop CI": readJson("tauri.conf.json"),
  "Windows signing": merge(
    readJson("tauri.conf.json"),
    readJson("tauri.windows-signing.conf.json"),
  ),
};

for (const [build, config] of Object.entries(builds)) {
  test(`the ${build} build uses OpenBot's installer template and hooks`, () => {
    expect(nsisOf(config)).toMatchObject({
      template: TEMPLATE,
      installerHooks: "./windows/hooks.nsh",
    });
  });
}

test("the template is Tauri's, with only OpenBot's marked lines added", () => {
  const lock = readFileSync(join(desktop, "bun.lock"), "utf8");
  const locked = /"@tauri-apps\/cli": \["@tauri-apps\/cli@([^"]+)"/.exec(
    lock,
  )?.[1];
  expect(locked).toBe(COPIED_FROM_CLI);
  const tauriOnly = tauriPart(template());
  expect(createHash("sha256").update(tauriOnly).digest("hex")).toBe(
    TAURI_TEMPLATE_SHA256,
  );
});

const hooks = () => readFileSync(join(tauri, "windows", "hooks.nsh"), "utf8");

/** The code lines of `text`, trimmed, without comments or blank lines. */
const code = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(";"));

/**
 * The page never runs the old uninstaller itself. Tauri's page hides the installer's window
 * (HideWindow) and waits for the old uninstaller there. Run silently, that left nothing on screen:
 * on a live update from 1.0.1, OpenBot had closed and no window showed for two and a half minutes.
 * So for an NSIS install the page only notes the choice and goes on, and the old version is
 * uninstalled on the Installing page.
 */
test("leaving the Already Installed page never hides the installer to run the old uninstaller", () => {
  const leave = between(
    template(),
    "Function PageLeaveReinstall",
    "FunctionEnd",
  );
  // A choice made on an earlier visit to the page never carries over.
  expect(code(leave)[0]).toBe("StrCpy $OpenBotUninstallFirst 0");
  const uninstall = code(leave.slice(leave.indexOf("reinst_uninstall:")));
  const hidden = uninstall.indexOf("HideWindow");
  expect(hidden).toBeGreaterThan(-1);
  // Before Tauri's HideWindow, an NSIS install (not WiX) notes the choice and leaves the page.
  expect(uninstall.slice(0, hidden)).toEqual([
    "reinst_uninstall:",
    "${If} $WixMode <> 1",
    "!insertmacro OPENBOT_BEFORE_OLD_UNINSTALLER",
    "StrCpy $OpenBotUninstallFirst 1",
    "Goto reinst_done",
    "${EndIf}",
  ]);
});

test("the old uninstaller runs on the Installing page, silently and as an update, with a line and moving progress", () => {
  const preinstall = code(
    between(hooks(), "!macro NSIS_HOOK_PREINSTALL\n", "!macroend"),
  );
  expect(preinstall.slice(0, 3)).toEqual([
    "${If} $OpenBotUninstallFirst = 1",
    "!insertmacro OPENBOT_UNINSTALL_OLD_VERSION",
    "${EndIf}",
  ]);
  const old = code(
    between(hooks(), "!macro OPENBOT_UNINSTALL_OLD_VERSION\n", "!macroend"),
  );
  const at = (line: string) => {
    const index = old.indexOf(line);
    expect(index).toBeGreaterThan(-1);
    return index;
  };
  // Asked first if OpenBot was opened again since the page, before anything is removed.
  const asked = at(
    '!insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"',
  );
  const said = at(
    'DetailPrint "Removing the previous version of OpenBot. Your Bots and data stay."',
  );
  const moving = at("!insertmacro OPENBOT_PROGRESS_MOVING 1");
  // /UPDATE keeps the data and shows no box, /S shows no window of its own, and `_?=` comes last,
  // as NSIS reads it, so the installer waits for the uninstaller.
  const run = at(
    "ExecWait '$OpenBotOldUninstaller /UPDATE /S _?=$OpenBotOldFolder' $0",
  );
  const stopped = at("!insertmacro OPENBOT_PROGRESS_MOVING 0");
  expect(asked).toBeLessThan(said);
  expect(said).toBeLessThan(moving);
  expect(moving).toBeLessThan(run);
  expect(run).toBeLessThan(stopped);
  expect(old).not.toContain("HideWindow");

  // The Installing page's own progress bar (control 1004, as MUI2's InstallFiles.nsh reads it)
  // moves on its own while the installer waits: a marquee, which needs a window that is shown.
  const progress = code(
    between(hooks(), "!macro OPENBOT_PROGRESS_MOVING on\n", "!macroend"),
  );
  expect(progress).toContain("${IfNot} ${Silent}");
  expect(progress).toContain(
    'FindWindow $OpenBotProgress "#32770" "" $HWNDPARENT',
  );
  expect(progress).toContain(
    "GetDlgItem $OpenBotProgress $OpenBotProgress 1004",
  );
  expect(progress).toContain("${NSD_AddStyle} $OpenBotProgress ${PBS_MARQUEE}");
  expect(progress).toContain(
    "SendMessage $OpenBotProgress ${PBM_SETMARQUEE} 1 50",
  );
});

test("a running OpenBot is asked about and closed when the person leaves the page", () => {
  const macro = between(
    hooks(),
    "!macro OPENBOT_BEFORE_OLD_UNINSTALLER\n",
    "!macroend",
  );
  // The words a running OpenBot gets everywhere else (#1428). Cancel stays on the page.
  expect(macro).toContain('"$(appRunningOkKill)"');
  expect(macro).toContain("MB_OKCANCEL");
  expect(macro).toMatch(/IDCANCEL`\n\s*Abort/);
  // OK closes it there and then, as the words say, before the next page.
  expect(macro).toContain("nsis_tauri_utils::KillProcessCurrentUser");
  // Passive installs ask nothing, as Tauri's own check doesn't.
  expect(macro).toContain("${If} $PassiveMode <> 1");
});

test("the uninstaller deletes the data only when it is not an update", () => {
  const text = template();
  // /UPDATE is what the uninstaller reads into $UpdateMode.
  const init = between(text, "Function un.onInit", "FunctionEnd");
  expect(init).toContain('${GetOptions} $CMDLINE "/UPDATE" $UpdateMode');
  // The box's choice is acted on only when $UpdateMode isn't 1.
  const uninstall = between(text, "\nSection Uninstall\n", "\nSectionEnd");
  const remove = between(
    uninstall,
    "${If} $DeleteAppDataCheckboxState = 1",
    "${EndIf}",
  );
  expect(uninstall).toContain(
    "${If} $DeleteAppDataCheckboxState = 1\n  ${AndIf} $UpdateMode <> 1",
  );
  expect(remove).toContain('RmDir /r "$APPDATA\\${BUNDLEID}"');
  expect(remove).toContain('RmDir /r "$LOCALAPPDATA\\${BUNDLEID}"');
});
