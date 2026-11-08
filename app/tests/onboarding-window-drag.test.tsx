import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";

/**
 * In OpenBot Desktop on macOS the window can be dragged by onboarding's top strip.
 *
 * The Mac window's title bar is an overlay, so the page has to say where a press moves the window.
 * The desktop runs `OVERLAY_TITLE_BAR_PAGE` (desktop/src-tauri/src/main.rs) in OpenBot's page on
 * macOS only, and it marks those places `data-tauri-drag-region`. Onboarding has no sidebar, so
 * until its header was marked nothing on the page moved the window.
 *
 * The mark is bare, as the sidebar's is. Tauri's drag script (tauri 2.12, window/scripts/drag.js)
 * drags on a bare mark only when the press lands on the marked element itself, and never on a
 * button without a mark of its own. So the header's own strip drags, and Back and the steps inside
 * it stay buttons. The script is the shell's own, read from its source and run on the real frame.
 */

const script = (() => {
  const source = readFileSync(
    new URL("../../desktop/src-tauri/src/main.rs", import.meta.url),
    "utf8",
  );
  const found = source.match(
    /const OVERLAY_TITLE_BAR_PAGE: &str = r#"([\s\S]*?)"#;/,
  );
  if (!found?.[1]) throw new Error("OVERLAY_TITLE_BAR_PAGE is not in main.rs");
  return found[1];
})();

const DRAG = "data-tauri-drag-region";

beforeAll(() => GlobalRegistrator.register({ width: 1000, height: 800 }));
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.desktopTitlebar;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

function frame(index: number) {
  return (
    <OnboardingFrame
      demo={<p>The step's picture.</p>}
      index={index}
      intro={<h1>Connect your apps</h1>}
      onBack={() => {}}
      onPick={() => {}}
      primary={{ label: "Continue", onClick: () => {} }}
      reached={index}
      titles={["Welcome", "Connect your apps", "Talk to us"]}
    />
  );
}

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

test("without the desktop's macOS script, as on Windows or in a browser, nothing drags", () => {
  const view = render(frame(1));
  expect(view.container.querySelectorAll(`[${DRAG}]`)).toHaveLength(0);
});

test("the desktop's macOS script makes onboarding's header the drag handle, and nothing inside it", async () => {
  // Onboarding draws after the page loads, as it does after the shell runs the script.
  // The shell evaluates this same text in the page.
  new Function(script)();
  const view = render(frame(1));
  await nextFrame();
  await nextFrame();

  expect(document.documentElement.dataset.desktopTitlebar).toBe("overlay");
  const header = view.container.querySelector(
    "[data-onboarding-frame] > header",
  ) as HTMLElement;
  // Bare: only a press on the header itself, its strip below the window's buttons, drags.
  expect(header.getAttribute(DRAG)).toBe("");
  expect(header.querySelectorAll(`[${DRAG}]`)).toHaveLength(0);
  // Back stays a button with no mark of its own, which Tauri never drags from.
  const back = header.querySelector(
    '[data-onboarding-back="phone"]',
  ) as HTMLElement;
  expect(back.tagName).toBe("BUTTON");
  expect(back.hasAttribute(DRAG)).toBe(false);
  // Nothing else on the page moves the window.
  expect(document.querySelectorAll(`[${DRAG}]`)).toHaveLength(1);

  // The next step draws a new frame, and its header is marked too.
  view.rerender(<div key="next">{frame(2)}</div>);
  await nextFrame();
  await nextFrame();
  const next = view.container.querySelector(
    "[data-onboarding-frame] > header",
  ) as HTMLElement;
  expect(next).not.toBe(header);
  expect(next.getAttribute(DRAG)).toBe("");
});
