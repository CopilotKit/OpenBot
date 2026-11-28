/**
 * One React in a test run, wherever `bun test` starts.
 *
 * The desktop is not a workspace of this repository: it has its own `node_modules`, with its own
 * copy of React. The desktop workbench draws with the app's components (app/src/components/ui,
 * see desktop/workbench/README.md, "The rule"), and those import React from `app/node_modules`. Two
 * copies of React in one render fail at run time with "Invalid hook call".
 *
 * So every import of the desktop's React gets the app's copy instead. The two are the same version
 * (desktop/workbench/appUi.test.ts checks it). The app's tests are untouched: they already use the
 * app's copy. In the browser, Vite does the same the other way round (`dedupe` in
 * desktop/vite.workbench.config.ts).
 *
 * Without the desktop's packages installed (a checkout that runs only the app's tests), there is
 * nothing to redirect, and this does nothing.
 */
import { mock } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const fromDesktop = createRequire(join(root, "desktop", "package.json"));
const fromApp = createRequire(join(root, "app", "package.json"));

const ENTRIES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
];

function resolved(from: NodeJS.Require, name: string): string | null {
  try {
    return from.resolve(name);
  } catch {
    return null;
  }
}

for (const name of ENTRIES) {
  const desktopPath = resolved(fromDesktop, name);
  const appPath = resolved(fromApp, name);
  if (desktopPath === null || appPath === null || desktopPath === appPath)
    continue;
  // Loaded only when a desktop file imports it: loading react-dom here would run React's scheduler
  // before app/tests/react-teardown.ts can hold its queue.
  mock.module(desktopPath, () => fromApp(name));
}
