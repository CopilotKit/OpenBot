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
  // Box I: ExecWait writes its own "Execute: ...uninstall.exe /UPDATE /S _?=..." to the page's
  // status line, over the plain one, for as long as the old uninstaller ran. Around the wait the
  // details go to the list only, so the plain line stays on screen.
  const listOnly = at("SetDetailsPrint listonly");
  const both = at("SetDetailsPrint both");
  expect(asked).toBeLessThan(said);
  expect(said).toBeLessThan(moving);
  expect(moving).toBeLessThan(listOnly);
  expect(listOnly).toBeLessThan(run);
  expect(run).toBeLessThan(both);
  expect(both).toBeLessThan(stopped);
  expect(
    old.slice(said + 1, run).filter((line) => line.startsWith("DetailPrint")),
  ).toEqual([]);
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

/**
 * Box H: after an in-app update the new OpenBot opened behind the maximised Edge that Windows put in
 * front as the old one closed, and Starting OpenBot ran there unseen for four minutes. Every OpenBot
 * the installer starts, after an update (/R) and from its last page, is started the same way: the
 * installer first passes on its right to bring a window to the front (AllowSetForegroundWindow with
 * ASFW_ANY, -1), then starts OpenBot with the flag that has it come forward as its window first shows
 * (STARTED_BY_INSTALLER in src-tauri/src/main.rs), added once to the arguments an update hands on.
 */
test("every OpenBot the installer starts may come to the front and is told the installer started it", () => {
  expect(hooks()).toContain(
    '!define OPENBOT_STARTED_BY_INSTALLER "--started-by-installer"',
  );
  const run = code(
    between(hooks(), "!macro OPENBOT_RUN_AFTER_INSTALL args\n", "!macroend"),
  );
  const at = (line: string) => {
    const index = run.indexOf(line);
    expect(index).toBeGreaterThan(-1);
    return index;
  };
  const allowed = at("System::Call 'user32::AllowSetForegroundWindow(i -1)'");
  const given = at('StrCpy $OpenBotRunArgs "${args}"');
  const looked = at(
    '${StrLoc} $OpenBotFlagAt "$OpenBotRunArgs" "${OPENBOT_STARTED_BY_INSTALLER}" ">"',
  );
  const started = at(
    'nsis_tauri_utils::RunAsUser "$INSTDIR\\${MAINBINARYNAME}.exe" "$OpenBotRunArgs"',
  );
  expect(allowed).toBeLessThan(started);
  expect(given).toBeLessThan(looked);
  expect(looked).toBeLessThan(started);
  // Exactly one launch in the macro.
  expect(run.filter((line) => line.includes("RunAsUser"))).toHaveLength(1);

  // After an update: the arguments the updater handed on (/ARGS), then nothing of Tauri's runs.
  const success = code(
    between(template(), "Function .onInstSuccess", "FunctionEnd"),
  );
  const handed = success.indexOf('${GetOptions} $CMDLINE "/ARGS" $R0');
  expect(handed).toBeGreaterThan(-1);
  expect(success.slice(handed + 1, handed + 3)).toEqual([
    '!insertmacro OPENBOT_RUN_AFTER_INSTALL "$R0"',
    "Return",
  ]);
  // From the last page: no arguments, the page stays until OpenBot's window is up, then nothing
  // of Tauri's runs.
  const finish = code(
    between(template(), "Function RunMainBinary", "FunctionEnd"),
  );
  expect(finish.slice(0, 3)).toEqual([
    '!insertmacro OPENBOT_RUN_AFTER_INSTALL ""',
    "!insertmacro OPENBOT_STAY_UNTIL_OPEN",
    "Return",
  ]);
});

/**
 * Box H, a clean install of 1.0.2: while Microsoft's WebView2 Runtime installed, the Installing
 * page's status line said "Execute: C:\Users\ADMINI~1\AppData\Local\Temp\
 * MicrosoftEdgeWebview2Setup.exe /silent /install" for as long as it took. NSIS's ExecWait writes
 * its command there itself. Box I saw the same for the old version's uninstaller (#1462). So every
 * ExecWait, in Tauri's template and in OpenBot's hooks, says it to the details list only
 * (`SetDetailsPrint listonly`) and puts the status line back after (`SetDetailsPrint both`),
 * https://nsis.sourceforge.io/Docs/Chapter4.html#setdetailsprint, so the plain line before it
 * stays on screen.
 */
test("no ExecWait in the installer puts its command on the page", () => {
  for (const [file, text, count] of [
    ["windows/installer.nsi", template(), 4],
    ["windows/hooks.nsh", hooks(), 1],
  ] as const) {
    const lines = code(text);
    const waits = lines.flatMap((line, at) =>
      line.startsWith("ExecWait ") || line.startsWith("ExecWait\t") ? [at] : [],
    );
    expect({ file, waits: waits.length }).toEqual({ file, waits: count });
    for (const at of waits) {
      expect({ file, wait: lines[at], before: lines[at - 1] }).toEqual({
        file,
        wait: lines[at],
        before: "SetDetailsPrint listonly",
      });
      expect({ file, wait: lines[at], after: lines[at + 1] }).toEqual({
        file,
        wait: lines[at],
        after: "SetDetailsPrint both",
      });
    }
    // Nothing else of NSIS's own runs a program and says so (Exec, ExecShell).
    expect(
      lines.filter((line) => /^Exec(Shell)?\b(?!Wait)/.test(line)),
    ).toEqual([]);
  }
});

/**
 * The WebView2 Runtime installs under the plain line (installingWebview2 in
 * windows/installer-english.nsh), with the page's bar moving, as the old version's uninstall does.
 */
test("the WebView2 Runtime installs under a plain line with the bar moving", () => {
  const install = code(
    between(template(), "install_webview2:", "webview2_done:"),
  );
  expect(install.slice(0, 6)).toEqual([
    'DetailPrint "$(installingWebview2)"',
    "!insertmacro OPENBOT_PROGRESS_MOVING 1",
    "SetDetailsPrint listonly",
    'ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1',
    "SetDetailsPrint both",
    "!insertmacro OPENBOT_PROGRESS_MOVING 0",
  ]);
  // An older Runtime brought up to date the same way.
  const update = code(between(template(), "update_webview:", "SectionEnd"));
  const run = update.findIndex((line) => line.startsWith("ExecWait "));
  expect(update.slice(run - 2, run + 3)).toEqual([
    "!insertmacro OPENBOT_PROGRESS_MOVING 1",
    "SetDetailsPrint listonly",
    'ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1',
    "SetDetailsPrint both",
    "!insertmacro OPENBOT_PROGRESS_MOVING 0",
  ]);
  expect(update[0]).toBe('DetailPrint "$(installingWebview2)"');

  // Box H: NSISdl's own box said "Downloading MicrosoftEdgeWebview2Setup.exe" and "Connecting ..."
  // over the page. The bootstrapper comes quietly, from the address Tauri's own line uses, under
  // the plain line with the bar moving, and Tauri's own lines after it are not reached.
  const download = code(
    between(
      template(),
      '!if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"',
      "!endif",
    ),
  );
  const quiet = download.findIndex((line) =>
    line.startsWith("NSISdl::download_quiet "),
  );
  const tauris = download.findIndex((line) =>
    line.startsWith("NSISdl::download "),
  );
  expect(download.slice(quiet - 3, quiet + 3)).toEqual([
    'Delete "$TEMP\\MicrosoftEdgeWebview2Setup.exe"',
    'DetailPrint "$(webview2Downloading)"',
    "!insertmacro OPENBOT_PROGRESS_MOVING 1",
    download[quiet],
    "Pop $0",
    "!insertmacro OPENBOT_PROGRESS_MOVING 0",
  ]);
  expect(download[quiet].replace("download_quiet", "download")).toBe(
    download[tauris],
  );
  const leave = download.indexOf("Goto install_webview2");
  expect(leave).toBeGreaterThan(quiet);
  expect(leave).toBeLessThan(tauris);
});

/**
 * Box H: after Finish on a clean computer nothing was on screen for about ten seconds, the
 * installer gone and OpenBot's window not up yet. The last page stays, saying OpenBot is opening,
 * until a visible window with the class and title Tauri gives OpenBot's (tauri-runtime-wry's
 * "Tauri Window", tauri.conf.json's title), for a minute at most; nothing on it can be pressed
 * meanwhile, and it hands on its messages so Windows never shows it as not responding.
 */
test("after Finish the installer stays on screen until OpenBot's window is up", () => {
  const config = readJson("tauri.conf.json");
  const main = config.app.windows.find(
    (window: { label?: string }) => (window.label ?? "main") === "main",
  );
  expect(main.title).toBe(config.productName);
  expect(hooks()).toContain('!define OPENBOT_WINDOW_CLASS "Tauri Window"');
  expect(hooks()).toContain("!define OPENBOT_OPEN_WAIT_TENTHS 600");
  const stay = code(
    between(hooks(), "!macro OPENBOT_STAY_UNTIL_OPEN\n", "!macroend"),
  );
  const at = (line: string) => {
    const index = stay.indexOf(line);
    expect({ line, found: index > -1 }).toEqual({ line, found: true });
    return index;
  };
  // Finish, Cancel and Back, both boxes and the close button are off before it waits.
  for (const button of [1, 2, 3]) {
    at(`GetDlgItem $OpenBotWaitWindow $HWNDPARENT ${button}`);
  }
  at("EnableWindow $mui.FinishPage.Run 0");
  at("EnableWindow $mui.FinishPage.ShowReadme 0");
  const closed = at(
    "System::Call 'user32::EnableMenuItem(p $OpenBotWaitWindow, i ${SC_CLOSE}, i ${MF_GRAYED})'",
  );
  const said = at(
    'SendMessage $mui.FinishPage.Text ${WM_SETTEXT} 0 "STR:Opening OpenBot. This can take a minute."',
  );
  const found = at(
    'FindWindow $OpenBotWaitWindow "${OPENBOT_WINDOW_CLASS}" "${PRODUCTNAME}"',
  );
  const visible = at(
    "System::Call 'user32::IsWindowVisible(p $OpenBotWaitWindow) i.s'",
  );
  const handed = at(
    "System::Call 'user32::DispatchMessageW(p $OpenBotWaitMessage)'",
  );
  const slept = at("Sleep 100");
  expect(closed).toBeLessThan(found);
  expect(said).toBeLessThan(found);
  expect(found).toBeLessThan(visible);
  expect(visible).toBeLessThan(handed);
  expect(handed).toBeLessThan(slept);
  at(
    "System::Call 'user32::PeekMessageW(p $OpenBotWaitMessage, p 0, i 0, i 0, i ${PM_REMOVE}) i.s'",
  );
  at("${If} $OpenBotWaitTenths >= ${OPENBOT_OPEN_WAIT_TENTHS}");
  at("IntOp $OpenBotWaitTenths $OpenBotWaitTenths + 1");
  // A silent install has no page to keep.
  expect(stay[0]).toBe("${IfNot} ${Silent}");
});
