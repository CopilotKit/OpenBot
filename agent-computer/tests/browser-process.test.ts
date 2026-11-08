import { expect, test } from "bun:test";
import { browsersOnProfile } from "./fixtures/browser-process";

/**
 * Which process on a profile is its browser, against the process table CI printed when the
 * person-browser test failed with "found 2" (the `computer (real browser)` job, Google Chrome on
 * ubuntu-latest). The second process was Chrome's own installed-version check: its binary run again
 * with the browser's command line and `--product-version`, as the browser's child.
 */

const PROFILE =
  "/tmp/openbot-person-browser-XVLqde/person-0123456789abcdef0123456789abcdef";
const SWITCHES = `--remote-debugging-pipe --user-data-dir=${PROFILE} --no-first-run --no-default-browser-check --enable-features=CDPScreenshotNewSurface --edge-skip-compat-layer-relaunch --disable-blink-features=AutomationControlled --enable-unsafe-extension-debugging --headless`;
const BROWSER = `5064    3099 /opt/google/chrome/chrome ${SWITCHES}`;
const VERSION_CHECK = `5375    5064 /opt/google/chrome/chrome ${SWITCHES} --noerrdialogs --ozone-platform=headless --ozone-override-screen-size=800,600 --use-angle=swiftshader-webgl --flag-switches-begin --flag-switches-end --product-version`;
const RENDERER = `5101    5064 /opt/google/chrome/chrome --type=renderer --user-data-dir=${PROFILE} --enable-features=CDPScreenshotNewSurface`;

test("Chrome's installed-version check beside its browser is not a second browser", () => {
  const listing = [
    "  3099     1 bun test tests/person-browser.test.ts",
    BROWSER,
    RENDERER,
    VERSION_CHECK,
    "",
  ].join("\n");
  expect(browsersOnProfile(listing, PROFILE).map(({ pid }) => pid)).toEqual([
    5064,
  ]);
});

test("two browsers started on one profile are both found", () => {
  const second = `6100    3099 /opt/google/chrome/chrome ${SWITCHES}`;
  const listing = [BROWSER, VERSION_CHECK, second].join("\n");
  expect(browsersOnProfile(listing, PROFILE).map(({ pid }) => pid)).toEqual([
    5064, 6100,
  ]);
});

test("a browser on another profile whose path starts the same is not this one's", () => {
  const other = `7000    3099 /opt/google/chrome/chrome --user-data-dir=${PROFILE}-other --headless`;
  expect(
    browsersOnProfile([BROWSER, other].join("\n"), PROFILE).map(
      ({ pid }) => pid,
    ),
  ).toEqual([5064]);
});
