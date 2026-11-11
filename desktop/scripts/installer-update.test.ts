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

test("installing over OpenBot runs the old uninstaller silently, as an update", () => {
  const leave = between(
    template(),
    "Function PageLeaveReinstall",
    "FunctionEnd",
  );
  // Tauri's own NSIS branch: the old uninstaller's command, built up, then run and waited for.
  const uninstall = leave.slice(leave.indexOf("reinst_uninstall:"));
  const nsis = between(uninstall, "${Else}", "${EndIf}");
  const lines = nsis
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(";"));
  const read = lines.indexOf(
    'ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"',
  );
  const flags = lines.indexOf('StrCpy $R1 "$R1 /UPDATE /S"');
  const folder = lines.indexOf(
    'StrCpy $R1 "$R1 _?=$4" ; append uninstall directory',
  );
  const run = lines.indexOf("ExecWait '$R1' $0");
  expect(read).toBeGreaterThan(-1);
  // After the command is read, and before `_?=`, which NSIS takes only as the last parameter.
  expect(flags).toBeGreaterThan(read);
  expect(folder).toBeGreaterThan(flags);
  expect(run).toBeGreaterThan(folder);
});

test("a running OpenBot is asked about before the old uninstaller closes it", () => {
  const leave = between(
    template(),
    "Function PageLeaveReinstall",
    "FunctionEnd",
  );
  const uninstall = leave.slice(leave.indexOf("reinst_uninstall:"));
  const ask = uninstall.indexOf("!insertmacro OPENBOT_BEFORE_OLD_UNINSTALLER");
  expect(ask).toBeGreaterThan(-1);
  expect(uninstall.indexOf("HideWindow")).toBeGreaterThan(ask);

  const hooks = readFileSync(join(tauri, "windows", "hooks.nsh"), "utf8");
  const macro = between(
    hooks,
    "!macro OPENBOT_BEFORE_OLD_UNINSTALLER\n",
    "!macroend",
  );
  // The words a running OpenBot gets everywhere else (#1428), and Cancel stays on the page.
  expect(macro).toContain('"$(appRunningOkKill)"');
  expect(macro).toContain("MB_OKCANCEL");
  expect(macro).toMatch(/IDCANCEL`\n\s*Abort/);
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
