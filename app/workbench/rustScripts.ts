/*
 * Reads the scripts that OpenBot Desktop runs in the app's page (the Desktop page scripts) from
 * the Rust source, so the app frame of the workbench runs the same code. This file runs in the
 * Vite config process and in bun tests, never in the browser.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DesktopPageScript = {
  name: string;
  os: "mac" | "windows" | "any";
  code: string;
};

type DesktopPageScriptSource = {
  /** The script's name in the workbench. Also the Rust constant's name unless `constant` says. */
  name: string;
  /** The Rust constant's name, when it is not `name` (a short name such as `PAGE`). */
  constant?: string;
  file: string;
  /** Which OS runs it: one OS, "any" for every OS, or a list (one script for each OS). */
  os: DesktopPageScript["os"] | readonly ("mac" | "windows")[];
  /** Text that Rust puts before the constant when it injects it (a `format!` around it). */
  prefix?: (os: DesktopPageScript["os"]) => string;
};

export const DESKTOP_PAGE_SCRIPT_SOURCES: readonly DesktopPageScriptSource[] = [
  {
    name: "OVERLAY_TITLE_BAR_PAGE",
    file: "desktop/src-tauri/src/main.rs",
    os: "mac",
  },
  { name: "APP_THEME_PAGE", file: "desktop/src-tauri/src/main.rs", os: "any" },
  {
    name: "QUIT_SHORTCUT_PAGE",
    file: "desktop/src-tauri/src/desktop_page.rs",
    os: "windows",
  },
  // zoom::shortcut_page(): `window.__openbotZoomMenu = <macOS>;\n` and then SHORTCUT_PAGE.
  {
    name: "ZOOM_SHORTCUT_PAGE",
    constant: "SHORTCUT_PAGE",
    file: "desktop/src-tauri/src/zoom.rs",
    os: ["mac", "windows"],
    prefix: (os) => `window.__openbotZoomMenu = ${os === "mac"};\n`,
  },
  // outside_links::page_for(connected): the app frame is never the relay's page, so not connected.
  {
    name: "OUTSIDE_LINKS_PAGE",
    constant: "PAGE",
    file: "desktop/src-tauri/src/outside_links.rs",
    os: "any",
    prefix: () => "window.__openbotConnected = false;\n",
  },
];

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The start of `(pub )?(pub(crate) )?const NAME: &str = ` at the start of a line. */
function declaration(name: string): string {
  return `(?:^|\\n)[ \\t]*(?:pub(?:\\([a-z:]+\\))?[ \\t]+)?const[ \\t]+${escapeName(name)}[ \\t]*:[ \\t]*&(?:'static[ \\t]+)?str[ \\t]*=[ \\t]*`;
}

/** Gives the text of `const NAME: &str = r#"..."#;` (or `r##"..."##`, and more `#`), else null. */
export function rustRawString(source: string, name: string): string | null {
  const found = new RegExp(`${declaration(name)}r(#*)"`).exec(source);
  if (!found) return null;
  const hashes = found[1] ?? "";
  const start = found.index + found[0].length;
  const end = source.indexOf(`"${hashes}`, start);
  if (end < 0) return null;
  return source.slice(start, end);
}

/** Gives the path of `const NAME: &str = include_str!("<path>");`, else null. */
export function rustIncludeStr(source: string, name: string): string | null {
  const found = new RegExp(
    `${declaration(name)}include_str!\\(\\s*"([^"]+)"\\s*\\)\\s*;`,
  ).exec(source);
  return found ? (found[1] ?? null) : null;
}

function readCode(repoRoot: string, name: string, file: string): string {
  const path = join(repoRoot, file);
  const source = readFileSync(path, "utf8");
  const raw = rustRawString(source, name);
  if (raw !== null) return raw;
  const included = rustIncludeStr(source, name);
  if (included !== null) {
    return readFileSync(join(dirname(path), included), "utf8");
  }
  throw new Error(
    `Workbench: ${name} is not in ${file}. The desktop page scripts moved: update app/workbench/rustScripts.ts.`,
  );
}

/**
 * Reads each Desktop page script. Throws when one is not where the list says. A source with a list
 * of OSes gives one script for each of them, each with the prefix that OS gets.
 */
export function readDesktopPageScripts(repoRoot: string): DesktopPageScript[] {
  return DESKTOP_PAGE_SCRIPT_SOURCES.flatMap(
    ({ name, constant, file, os, prefix }) => {
      const code = readCode(repoRoot, constant ?? name, file);
      const systems: readonly DesktopPageScript["os"][] =
        typeof os === "string" ? [os] : os;
      return systems.map((one) => ({
        name,
        os: one,
        code: prefix ? prefix(one) + code : code,
      }));
    },
  );
}
