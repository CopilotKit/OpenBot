import { expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import {
  DOESNT_UPDATE_ITSELF,
  installProgressSaid,
  outcomeSaid,
  panelState,
  UPDATING_LEDE,
  type UpdateOutcome,
  updatingTitle,
  updateOffered,
} from "./desktop-updates";

const ROOT = join(import.meta.dir, "..");

test("a build that doesn't update itself says what happened and what to do", () => {
  expect(DOESNT_UPDATE_ITSELF).toBe(
    "This version of OpenBot doesn't update itself. Install a released version of OpenBot to get updates.",
  );
});

/**
 * The setup window and Settings › This computer said this in two spellings once, one of them
 * without "of OpenBot". Each now reads the shared sentence, so neither may write its own.
 */
test("the setup window and Settings say it only through the shared sentence", async () => {
  const spelled: string[] = [];
  for (const dir of ["app/src", "desktop/src"]) {
    for await (const file of new Glob("**/*.{ts,tsx}").scan(join(ROOT, dir))) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const text = await Bun.file(join(ROOT, dir, file)).text();
      // JSX wraps long text across lines, so the words are compared with the whitespace folded.
      if (
        /This\s+version\s+of\s+OpenBot\s+doesn't\s+update\s+itself/.test(text)
      )
        spelled.push(`${dir}/${file}`);
    }
  }
  expect(spelled).toEqual([]);
});

test("a newer version says how ready it is, in one plain sentence", () => {
  expect(updateOffered("1.0.1")).toBe("OpenBot 1.0.1 is available.");
  expect(updateOffered("1.0.1", null)).toBe("OpenBot 1.0.1 is available.");
  expect(
    updateOffered("1.0.1", { state: "preparing", done: 40, total: 100 }),
  ).toBe("OpenBot 1.0.1 is downloading in the background (40%).");
  // Never 100% until every byte is in and the app says it is ready.
  expect(
    updateOffered("1.0.1", { state: "preparing", done: 999, total: 1000 }),
  ).toContain("(99%)");
  expect(
    updateOffered("1.0.1", { state: "preparing", done: 0, total: 0 }),
  ).toContain("(0%)");
  expect(updateOffered("1.0.1", { state: "ready" })).toBe(
    "OpenBot 1.0.1 is ready to install. It takes a few minutes.",
  );
});

const outcome = (over: Partial<UpdateOutcome> = {}): UpdateOutcome => ({
  version: "1.0.4",
  release: "ok",
  backEnd: "ok",
  failedStep: null,
  ...over,
});

test("the panel is restarting whenever an install runs, even with an outcome", () => {
  expect(
    panelState({
      version: "1.0.4",
      installing: { downloaded: 0, total: null, restarting: false },
      outcome: outcome(),
    }),
  ).toBe("restarting");
});

test("the panel says updated or failed from the outcome", () => {
  expect(
    panelState({ version: null, installing: null, outcome: outcome() }),
  ).toBe("updated");
  expect(
    panelState({
      version: null,
      installing: null,
      outcome: outcome({ backEnd: "failed" }),
    }),
  ).toBe("failed");
  expect(
    panelState({
      version: null,
      installing: null,
      outcome: outcome({ release: "failed", backEnd: "notDue" }),
    }),
  ).toBe("failed");
});

test("the panel reads a minimized version like an offered one", () => {
  expect(
    panelState({
      version: null,
      minimized: "1.0.4",
      installing: null,
      ready: { state: "ready" },
    }),
  ).toBe("ready");
  expect(
    panelState({
      version: "1.0.4",
      installing: null,
      ready: { state: "preparing", done: 1, total: 2 },
    }),
  ).toBe("downloading");
  expect(panelState({ version: "1.0.4", installing: null })).toBe("available");
});

test("the panel is null with no version, minimized version or outcome", () => {
  expect(panelState({ version: null, installing: null })).toBeNull();
  expect(
    panelState({ version: null, minimized: null, installing: null }),
  ).toBeNull();
});

test("a failed outcome names the version and says what happens next", () => {
  const said = outcomeSaid(outcome({ release: "failed" }));
  expect(said.title).toBe("Couldn't finish updating");
  expect(said.body).toContain("1.0.4");
  expect(said.body).toContain("Your data is kept");
  expect(said.body).toContain("tries again");
  expect(said.body).not.toContain("still on");
  expect(outcomeSaid(outcome())).toEqual({
    title: "Updated to OpenBot 1.0.4",
    body: "",
  });
});

test("the updating screen says what is happening", () => {
  expect(updatingTitle(null)).toBe("Updating OpenBot");
  expect(updatingTitle("1.0.4")).toBe("Updating OpenBot to 1.0.4");
  expect(UPDATING_LEDE).toContain("opens by itself");
});

test("install progress reads as a person would say it", () => {
  expect(installProgressSaid(null)).toBe("Downloading…");
  expect(
    installProgressSaid({ downloaded: 0, total: null, restarting: false }),
  ).toBe("Downloading…");
  expect(
    installProgressSaid({ downloaded: 50, total: 200, restarting: false }),
  ).toBe("Downloading… 25%");
  expect(
    installProgressSaid({ downloaded: 199, total: 200, restarting: false }),
  ).toBe("Downloading… 100%");
  expect(
    installProgressSaid({ downloaded: 200, total: 200, restarting: true }),
  ).toBe("Restarting…");
});
