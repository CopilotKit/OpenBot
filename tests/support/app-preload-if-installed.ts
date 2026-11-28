/**
 * The app's test preload (app/tests/preload.ts), for `bun test` run from inside desktop/, but only
 * where the app's packages are installed.
 *
 * The desktop workbench draws with the app's components, and its tests need that preload: Base UI
 * evaluated while a DOM exists, so its popups mount. But the desktop's release jobs (desktop-build,
 * desktop-signing, desktop-macos-signing) install only desktop/ and run a few desktop tests from
 * there. In those, the app's preload cannot load: it imports packages that only app/ installs, and a
 * preload that throws fails every test file in the run. None of the tests those jobs run draws an app
 * component, so there it is left out.
 *
 * desktop/workbench/desktopOnlyInstall.test.ts runs the desktop's preloads with nothing installed.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

const fromApp = createRequire(
  join(import.meta.dir, "..", "..", "app", "package.json"),
);

/** The packages app/tests/preload.ts imports. */
const PRELOAD_PACKAGES = [
  "@happy-dom/global-registrator",
  "@base-ui/react/dialog",
  "msw",
];

function installed(name: string): boolean {
  try {
    fromApp.resolve(name);
    return true;
  } catch {
    return false;
  }
}

if (PRELOAD_PACKAGES.every(installed)) {
  await import("../../app/tests/preload");
}
