import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * Guard: a browser test waits for the page to be still, never for a fixed time.
 *
 * The browser tests draw a screen, add the app's stylesheet after it has drawn, and measure or
 * photograph it. The styles start transitions as they land (a dialog sliding into place, a fade),
 * and a row that measures itself lays out again. A fixed `page.waitForTimeout(400)` guessed how long
 * that takes; under a full CI run, eight files at once in Chromium and WebKit, it sometimes guessed
 * short and the test failed on a screen caught mid-move. About thirty files carried their own copy
 * of that guess. They now call `still(page)` from ./page-still, which waits until nothing that ends
 * is moving and nothing in the page changes.
 *
 * Some waits are fixed on purpose: to prove something does NOT happen within a time (no second tab
 * opens, a read is not asked again), to let a timer the test is about run, or to poll something the
 * page cannot be asked about. Those files are listed below, each with the most waits it may hold
 * and why. Any other file that calls `waitForTimeout` fails here.
 */

const TESTS = import.meta.dir;

/** File, under app/tests: the most fixed waits it may hold, and why they are fixed. */
const ALLOWED: Record<string, { most: number; why: string }> = {
  "chunk-recovery.test.tsx": {
    most: 1,
    why: "proves a page that failed to load stays put and is not loaded again",
  },
  "composer-keeps-draft-browser.test.tsx": {
    most: 1,
    why: "gives the browser's storage its write before the page reloads",
  },
  "composer-touch-return.test.tsx": {
    most: 1,
    why: "proves Return did not send, after a send it started would have arrived",
  },
  "computer-panel-phone-layout.test.tsx": {
    most: 2,
    why: "proves the Computer does not open itself, and stays open, over a stretch of time",
  },
  "connect-your-ai.test.tsx": {
    most: 3,
    why: "polls the fake provider for the tab the app opened, and proves a left sign-in is not read again",
  },
  "consent-handoff.test.tsx": {
    most: 14,
    why: "the hand-off's countdown is what is tested: nothing opens before it ends, and a tab after",
  },
  "conversation-access-ended.test.tsx": {
    most: 1,
    why: "lets three seconds of the access read's clock go by",
  },
  "moved-apps-reconnect.test.tsx": {
    most: 9,
    why: "proves nothing is said or asked after a move; its one settle wait, after styling, is still to move to still()",
  },
  "moved-elsewhere.test.tsx": {
    most: 8,
    why: "proves the moved Bots bar does not come back after a reload, a switch or a dismiss",
  },
  "organization-unavailable-admin-pages.test.tsx": {
    most: 1,
    why: "lets every read a page makes be answered before it is judged",
  },
  "organization-unavailable-chat.test.tsx": {
    most: 7,
    why: "holds the organization out of reach for the time a send takes, and lets a stopped turn's notice land",
  },
  "people-lists.test.tsx": {
    most: 2,
    why: "lets a typeahead's search, which waits for typing to stop, be asked and answered",
  },
  "roster-working.test.tsx": {
    most: 3,
    why: "polls the fake server for a read, and proves a row's Working is not settled back",
  },
  "section-strip-routines.test.tsx": {
    most: 1,
    why: "polls what the strip shows until it is what is wanted, for a few seconds at most",
  },
  "sidebar-current-row.test.tsx": {
    most: 1,
    why: "lets the browser work out what is under a pointer that has not moved, which it does on a timer",
  },
};

/** Every .ts and .tsx file under app/tests, as a path from there. */
function files(dir = TESTS): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) ? [relative(TESTS, path)] : [];
  });
}

/** How many fixed waits each file holds. */
function fixedWaits(): Record<string, number> {
  const self = relative(TESTS, import.meta.path);
  return Object.fromEntries(
    files()
      .filter((file) => file !== self)
      .map((file) => [
        file,
        (
          readFileSync(join(TESTS, file), "utf8").match(
            /\.waitForTimeout\(/g,
          ) ?? []
        ).length,
      ])
      .filter(([, count]) => Number(count) > 0),
  );
}

describe("browser tests wait for the page, not the clock", () => {
  test("no file waits a fixed time unless it is listed with why", () => {
    const over = Object.entries(fixedWaits())
      .filter(([file, count]) => count > (ALLOWED[file]?.most ?? 0))
      .map(
        ([file, count]) =>
          `${file}: ${count} fixed wait${count === 1 ? "" : "s"}, ${ALLOWED[file]?.most ?? 0} allowed`,
      )
      .sort();
    expect(
      over,
      "A fixed wait for the page to settle flakes under load. Wait with `await still(page)` from ./page-still. A wait that proves something does not happen goes in ALLOWED with why.",
    ).toEqual([]);
  });

  test("every listed file is still there", () => {
    const present = new Set(files());
    expect(Object.keys(ALLOWED).filter((file) => !present.has(file))).toEqual(
      [],
    );
  });
});
