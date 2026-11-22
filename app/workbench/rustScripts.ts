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

export const DESKTOP_PAGE_SCRIPT_SOURCES = [
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
] as const;

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

/** Reads each Desktop page script. Throws when one is not where the list says. */
export function readDesktopPageScripts(repoRoot: string): DesktopPageScript[] {
  return DESKTOP_PAGE_SCRIPT_SOURCES.map(({ name, file, os }) => {
    const path = join(repoRoot, file);
    const source = readFileSync(path, "utf8");
    const raw = rustRawString(source, name);
    if (raw !== null) return { name, os, code: raw };
    const included = rustIncludeStr(source, name);
    if (included !== null) {
      return {
        name,
        os,
        code: readFileSync(join(dirname(path), included), "utf8"),
      };
    }
    throw new Error(
      `Workbench: ${name} is not in ${file}. The desktop page scripts moved: update app/workbench/rustScripts.ts.`,
    );
  });
}
