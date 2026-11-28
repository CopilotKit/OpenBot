import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/*
 * Setup handing the window to OpenBot: it fades out to the window's ground, and only then asks the
 * shell to show OpenBot (`show_openbot`). A failed ask brings setup back at once; reduced motion
 * fades nothing. OpenBot's page fades up from the same ground (app/tests/from-setup.test.ts).
 */

const { handover, leaveFor } = await import("./handover");
const DEFAULTS = { ...handover };

let reduced = false;
beforeAll(() => {
  GlobalRegistrator.register();
  const realMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query: string) =>
    query === "(prefers-reduced-motion: reduce)"
      ? ({ matches: reduced, media: query } as MediaQueryList)
      : realMatchMedia(query);
});
afterAll(() => GlobalRegistrator.unregister());

afterEach(() => {
  Object.assign(handover, DEFAULTS);
  reduced = false;
  delete document.documentElement.dataset.handover;
  document.documentElement.style.removeProperty("--handover-fade");
});

const mark = () => document.documentElement.dataset.handover;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("setup fades out first, and only then asks the shell to show OpenBot", async () => {
  handover.fadeMs = 80;
  const began = performance.now();
  let asked: { after: number; mark: string | undefined } | null = null;
  const leaving = leaveFor(async () => {
    asked = { after: performance.now() - began, mark: mark() };
    return "shown";
  });
  // The fade has started and nothing was asked yet.
  expect(mark()).toBe("leaving");
  expect(
    document.documentElement.style.getPropertyValue("--handover-fade"),
  ).toBe("80ms");
  expect(asked).toBeNull();
  await wait(20);
  expect(asked).toBeNull();
  expect(await leaving).toBe("shown");
  expect(asked).not.toBeNull();
  const seen = asked as unknown as { after: number; mark: string | undefined };
  expect(seen.after).toBeGreaterThanOrEqual(75);
  // Asked with setup faded out, and it stays faded for OpenBot's page to replace it.
  expect(seen.mark).toBe("leaving");
  expect(mark()).toBe("leaving");
});

test("a failed show brings setup back at once, and the failure is the caller's to say", async () => {
  handover.fadeMs = 40;
  const leaving = leaveFor(async () => {
    expect(mark()).toBe("leaving");
    throw new Error("OpenBot is not answering on port 3010 yet");
  });
  await expect(leaving).rejects.toThrow("not answering");
  expect(mark()).toBeUndefined();
  expect(
    document.documentElement.style.getPropertyValue("--handover-fade"),
  ).toBe("");
});

test("with reduced motion nothing fades and the shell is asked at once", async () => {
  reduced = true;
  let asked = false;
  const leaving = leaveFor(async () => {
    asked = true;
    expect(mark()).toBeUndefined();
  });
  // Asked in the same turn: no wait for a fade.
  await Promise.resolve();
  expect(asked).toBe(true);
  await leaving;
  expect(mark()).toBeUndefined();
});

test("a page OpenBot has not replaced fades back in, then lets go of the mark", async () => {
  handover.fadeMs = 100;
  handover.backMs = 50;
  await leaveFor(async () => null);
  expect(mark()).toBe("leaving");
  // Back at 50 ms, as long as the fade out; let go of at 150 ms.
  await wait(100);
  expect(mark()).toBe("back");
  await wait(100);
  expect(mark()).toBeUndefined();
});

test("a second handover while the first is waiting to come back starts over", async () => {
  handover.fadeMs = 20;
  handover.backMs = 60;
  await leaveFor(async () => null);
  await wait(30);
  await leaveFor(async () => null);
  // The first one's return was cancelled: 30 + 20 ms in, still faded for the second.
  await wait(40);
  expect(mark()).toBe("leaving");
});

test("the fade dims everything on the ground, the ground itself stays, and reduced motion has no transition", () => {
  const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
  const leaving = css.slice(
    css.indexOf('html[data-handover="leaving"] #root > :not(.backdrop) {'),
  );
  const rule = leaving.slice(0, leaving.indexOf("}"));
  expect(rule).toContain("opacity: 0;");
  expect(rule).toContain("pointer-events: none;");
  expect(rule).toContain("var(--handover-fade");
  // Only opacity moves.
  expect(rule).not.toContain("transform");
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\) \{\s*html\[data-handover\] #root > :not\(\.backdrop\) \{\s*transition: none;/,
  );
});
