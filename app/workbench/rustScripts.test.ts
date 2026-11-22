import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_PAGE_SCRIPT_SOURCES,
  readDesktopPageScripts,
  rustIncludeStr,
  rustRawString,
} from "./rustScripts";

const SAMPLE = [
  "/// A doc line.",
  'const FIRST_PAGE: &str = r#"(() => { return "a"; })();"#;',
  "",
  'pub(crate) const SECOND_PAGE: &str = r##"',
  'say("#");',
  '"##;',
  'pub const QUIT_PAGE: &str = include_str!("quit.js");',
].join("\n");

describe("rustRawString", () => {
  test("gives the text of each raw string", () => {
    expect(rustRawString(SAMPLE, "FIRST_PAGE")).toBe(
      '(() => { return "a"; })();',
    );
    expect(rustRawString(SAMPLE, "SECOND_PAGE")).toBe('\nsay("#");\n');
  });

  test("gives null for a missing name or another kind of constant", () => {
    expect(rustRawString(SAMPLE, "MISSING_PAGE")).toBeNull();
    expect(rustRawString(SAMPLE, "QUIT_PAGE")).toBeNull();
    expect(rustRawString(SAMPLE, "FIRST")).toBeNull();
  });
});

describe("rustIncludeStr", () => {
  test("gives the path of an include_str! constant", () => {
    expect(rustIncludeStr(SAMPLE, "QUIT_PAGE")).toBe("quit.js");
  });

  test("gives null for a missing name or a raw string", () => {
    expect(rustIncludeStr(SAMPLE, "MISSING_PAGE")).toBeNull();
    expect(rustIncludeStr(SAMPLE, "FIRST_PAGE")).toBeNull();
  });
});

describe("readDesktopPageScripts on the real Rust source", () => {
  const root = join(import.meta.dir, "..", "..");
  const scripts = readDesktopPageScripts(root);
  const byName = new Map(scripts.map((script) => [script.name, script]));

  test("every listed script has code", () => {
    expect([...new Set(scripts.map((script) => script.name))]).toEqual(
      DESKTOP_PAGE_SCRIPT_SOURCES.map((source) => source.name),
    );
    for (const script of scripts) expect(script.code.trim()).not.toBe("");
  });

  test("a source with a list of OSes gives one script for each", () => {
    expect(
      scripts.map((script) => `${script.name} ${script.os}`).sort(),
    ).toEqual(
      [
        "APP_THEME_PAGE any",
        "OUTSIDE_LINKS_PAGE any",
        "OVERLAY_TITLE_BAR_PAGE mac",
        "QUIT_SHORTCUT_PAGE windows",
        "ZOOM_SHORTCUT_PAGE mac",
        "ZOOM_SHORTCUT_PAGE windows",
      ].sort(),
    );
  });

  test("the zoom shortcut starts with whether the View menu answers, as zoom::shortcut_page() does", () => {
    const zoom = scripts.filter(
      (script) => script.name === "ZOOM_SHORTCUT_PAGE",
    );
    const mac = zoom.find((script) => script.os === "mac")?.code ?? "";
    const windows = zoom.find((script) => script.os === "windows")?.code ?? "";
    expect(mac.startsWith("window.__openbotZoomMenu = true;\n")).toBe(true);
    expect(windows.startsWith("window.__openbotZoomMenu = false;\n")).toBe(
      true,
    );
    expect(mac).toContain("window.__openbotZoomMenu === true");
    const body = readFileSync(
      join(root, "desktop", "src-tauri", "src", "zoom-shortcut.js"),
      "utf8",
    );
    expect(mac).toBe(`window.__openbotZoomMenu = true;\n${body}`);
  });

  test("the outside links script is not the relay's, as outside_links::page_for(false) gives", () => {
    const links = byName.get("OUTSIDE_LINKS_PAGE")?.code ?? "";
    expect(links.startsWith("window.__openbotConnected = false;\n")).toBe(true);
    expect(links).toContain("window.__openbotConnected === true");
  });

  test("each script is the one the name says", () => {
    expect(byName.get("OVERLAY_TITLE_BAR_PAGE")?.code).toContain(
      'desktopTitlebar = "overlay"',
    );
    expect(byName.get("APP_THEME_PAGE")?.code).toContain(
      "plugin:openbot-desktop|appearance",
    );
    expect(byName.get("QUIT_SHORTCUT_PAGE")?.code.trim()).not.toBe("");
    expect(byName.get("QUIT_SHORTCUT_PAGE")?.os).toBe("windows");
  });

  test("a missing script throws a sentence that names it", () => {
    const fake = mkdtempSync(join(tmpdir(), "rust-scripts-"));
    try {
      mkdirSync(join(fake, "desktop", "src-tauri", "src"), { recursive: true });
      writeFileSync(join(fake, "desktop", "src-tauri", "src", "main.rs"), "");
      expect(() => readDesktopPageScripts(fake)).toThrow(
        "Workbench: OVERLAY_TITLE_BAR_PAGE is not in desktop/src-tauri/src/main.rs. The desktop page scripts moved: update app/workbench/rustScripts.ts.",
      );
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });
});
