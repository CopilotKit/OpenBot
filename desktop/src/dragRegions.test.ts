import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { markDragRegions, watchDragRegions } from "./dragRegions";

// The user agents the workbench dresses its frames in (workbench/frameConfig.ts).
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

const DRAG = "data-tauri-drag-region";

// A setup step as `SetupRail` and a step's page draw it (desktop/src/Sections.tsx).
const STEP = `
  <main>
    <aside class="rail" aria-label="Setup">
      <div class="lockup" aria-hidden="true"><div class="orb"></div><span>OpenBot</span></div>
      <h1 class="rail-title">Set up OpenBot</h1>
      <ol class="sections"><li>Start</li></ol>
      <fieldset class="picker hosting">
        <label class="tile"><input type="radio" name="hosting" /><span class="tile-name">Cloud</span></label>
      </fieldset>
      <div class="rail-foot"><p>Downloading <button type="button">Details</button></p></div>
    </aside>
    <div class="sheet"><h2>Connect your AI</h2><button type="button">Continue</button></div>
  </main>`;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:1420/" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  document.body.innerHTML = "";
});

const marks = () =>
  Array.from(document.querySelectorAll(`[${DRAG}]`)).map((element) => [
    element.className || element.tagName.toLowerCase(),
    element.getAttribute(DRAG),
  ]);

/**
 * On macOS setup runs under an overlay title bar (`match_title_bar`), so the page names what drags
 * the window: the ground around the page, the sidebar's empty room, and the words at its top.
 * Nothing that is a control, and nothing on the page itself, is a handle.
 */
test("on macOS the ground, the sidebar's empty room and its name drag the window", () => {
  document.body.innerHTML = STEP;
  const stop = watchDragRegions(document, MAC);
  expect(marks()).toEqual([
    ["main", ""],
    ["rail", ""],
    ["lockup", "deep"],
    ["rail-title", ""],
  ]);
  // Bare: a press on the inset page or anything in it is the page's, not the window's.
  expect(document.querySelector(".sheet")?.hasAttribute(DRAG)).toBe(false);
  for (const control of document.querySelectorAll("button, input, label")) {
    expect(control.hasAttribute(DRAG)).toBe(false);
  }
  stop();
});

/** Screens change under the observer: the next screen's handles are marked as it appears. */
test("a screen that comes later has its handles too", async () => {
  const stop = watchDragRegions(document, MAC);
  document.body.innerHTML = STEP;
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(marks().length).toBe(4);
  // A card screen with no sidebar: its ground.
  document.body.innerHTML = `<main><div class="sheet"><h1>Starting OpenBot</h1></div></main>`;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(marks()).toEqual([["main", ""]]);
  stop();
});

/** Windows keeps its own title bar to drag; the page marks nothing. */
test("on Windows nothing on the page drags the window", () => {
  document.body.innerHTML = STEP;
  watchDragRegions(document, WINDOWS)();
  expect(marks()).toEqual([]);
  // Marking by hand is the same set, whatever the platform: the gate is the watch's.
  markDragRegions(document);
  expect(marks().length).toBe(4);
});

/** Tauri reads the attribute only from a page the window's capability lets drag it. */
test("the setup window's capability lets its page drag the window", () => {
  const capability = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../src-tauri/capabilities/default.json"),
      "utf8",
    ),
  ) as { windows: string[]; permissions: unknown[] };
  expect(capability.windows).toContain("main");
  expect(capability.permissions).toContain("core:window:allow-start-dragging");
  expect(capability.permissions).toContain(
    "core:window:allow-internal-toggle-maximize",
  );
});
