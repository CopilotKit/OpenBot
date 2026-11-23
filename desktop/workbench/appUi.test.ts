import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * The workbench page draws with the app's components and the app's theme (README, "The rule").
 * This guard fails when a workbench file draws a control of its own (a raw <button>, <select>,
 * <input>, <textarea> or <details>) or a stylesheet sets its own colors, fonts or shadows.
 *
 * PENDING lists the files not moved yet. The list only gets shorter: a name that is gone, or whose
 * file is already clean, fails too.
 */
const PENDING: readonly string[] = [
  "CommentLayer.tsx",
  "findings/FindingsPage.tsx",
  "findings/findings.css",
  "Inspector.tsx",
  "SceneList.tsx",
  "WarningsList.tsx",
  "windowFrame.css",
  "WindowSettingsPanel.tsx",
  "Workbench.tsx",
  "workbench.css",
];

/*
 * The one exception: the colors of the Mac window buttons (close, minimise, zoom, and the gray of
 * an inactive window). They are macOS's colors, not the app's, and no app token means them.
 */
const OS_COLORS: readonly string[] = [
  "#ff5f57",
  "#febc2e",
  "#28c840",
  "#8e8e93",
];

const DIR = import.meta.dir;
const RAW_CONTROL = /<(button|select|input|textarea|details)[\s>]/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b(?=["'`])|\b(rgba?|hsla?|oklch)\(/g;
const OWN_LOOK =
  /(^|[\s;{])(color|background(-color)?|font(-family|-size|-weight)?|box-shadow|backdrop-filter|border-color)\s*:/m;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === "scenes" || name === "node_modules" ? [] : files(path);
    return [path];
  });
}

/** What is wrong with one file, or null. */
function problem(path: string): string | null {
  const name = relative(DIR, path);
  if (/\.test\.tsx?$/.test(name)) return null;
  const text = readFileSync(path, "utf8");
  if (name.endsWith(".tsx")) {
    const found = RAW_CONTROL.exec(text);
    if (found) return `draws its own <${found[1]}>`;
  }
  if (/\.tsx?$/.test(name)) {
    const colors = [...text.matchAll(COLOR_LITERAL)]
      .map((match) => match[0])
      .filter((color) => !OS_COLORS.includes(color.toLowerCase()));
    return colors.length > 0 ? `sets its own color ${colors[0]}` : null;
  }
  if (name.endsWith(".css")) {
    const found = OWN_LOOK.exec(text);
    return found ? `sets its own ${found[2]}` : null;
  }
  return null;
}

test("the workbench draws with the app's components and theme only", () => {
  const wrong = files(DIR)
    .filter((path) => !PENDING.includes(relative(DIR, path)))
    .flatMap((path) => {
      const found = problem(path);
      return found ? [`${relative(DIR, path)}: ${found}`] : [];
    });
  expect(wrong).toEqual([]);
});

test("PENDING only names files that exist and still need to move", () => {
  const stale = PENDING.filter((name) => {
    const path = join(DIR, name);
    return !existsSync(path) || problem(path) === null;
  });
  expect(stale).toEqual([]);
});

test("the desktop's Tailwind is the app's version", () => {
  const version = (root: string, name: string) =>
    JSON.parse(
      readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
    ).version as string;
  const desktop = join(DIR, "..");
  const app = join(DIR, "..", "..", "app");
  for (const name of ["tailwindcss", "@tailwindcss/vite"]) {
    expect(`${name} ${version(desktop, name)}`).toBe(
      `${name} ${version(app, name)}`,
    );
  }
});
