import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { followPageTheme } from "./pageTheme";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
});
afterAll(() => GlobalRegistrator.unregister());

type Listener = (event: { matches: boolean }) => void;

/** A media query for the dark scheme that a test can change. */
function fakeMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  return {
    matches,
    addEventListener: (_: string, listener: Listener) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) =>
      listeners.delete(listener),
    change(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

test("dark media puts .dark and color-scheme dark on html", () => {
  followPageTheme(document, fakeMedia(true) as never);
  const html = document.documentElement;
  expect(html.classList.contains("dark")).toBe(true);
  expect(html.style.colorScheme).toBe("dark");
});

test("a change of the media changes the page, and stop ends it", () => {
  const media = fakeMedia(true);
  const stop = followPageTheme(document, media as never);
  const html = document.documentElement;
  media.change(false);
  expect(html.classList.contains("dark")).toBe(false);
  expect(html.style.colorScheme).toBe("light");
  stop();
  media.change(true);
  expect(html.classList.contains("dark")).toBe(false);
});
