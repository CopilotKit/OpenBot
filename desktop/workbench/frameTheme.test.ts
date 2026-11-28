import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { forceTheme, watchTheme } from "./frameTheme";

/*
 * happy-dom gives real CSSMediaRule objects for a <style> element, so these tests run on a real
 * happy-dom document rather than a hand-built stub.
 */
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.head.innerHTML = "";
  delete globalThis.__workbenchSetTheme;
});

const DARK = "@media (prefers-color-scheme: dark) { body { color: white } }";

function addStyle(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

function mediaOf(style: HTMLStyleElement, path: number[] = [0]): string {
  let rule: CSSRule = style.sheet?.cssRules[path[0]] as CSSRule;
  for (const index of path.slice(1))
    rule = (rule as CSSGroupingRule).cssRules[index];
  return (rule as CSSMediaRule).media.mediaText;
}

test("dark turns the dark rule on", () => {
  const style = addStyle(DARK);
  forceTheme(document, "dark");
  expect(mediaOf(style)).toBe("all");
});

test("light turns the dark rule off", () => {
  const style = addStyle(DARK);
  forceTheme(document, "light");
  expect(mediaOf(style)).toBe("not all");
});

test("dark, light, dark switches back each time", () => {
  const style = addStyle(DARK);
  forceTheme(document, "dark");
  expect(mediaOf(style)).toBe("all");
  forceTheme(document, "light");
  expect(mediaOf(style)).toBe("not all");
  forceTheme(document, "dark");
  expect(mediaOf(style)).toBe("all");
});

test("no theme changes nothing", () => {
  const style = addStyle(DARK);
  const before = mediaOf(style);
  forceTheme(document);
  expect(mediaOf(style)).toBe(before);
});

test("a rule nested in @supports is found", () => {
  const style = addStyle(`@supports (display: grid) { ${DARK} }`);
  forceTheme(document, "light");
  expect(mediaOf(style, [0, 0])).toBe("not all");
});

test("a media rule that is not about the theme is untouched", () => {
  const style = addStyle("@media (min-width: 600px) { body { color: red } }");
  forceTheme(document, "light");
  expect(mediaOf(style)).toBe("(min-width: 600px)");
});

test("watchTheme installs a global setter and stop removes it", () => {
  const style = addStyle(DARK);
  const stop = watchTheme(document);
  globalThis.__workbenchSetTheme?.("light");
  expect(mediaOf(style)).toBe("not all");
  stop();
  expect(globalThis.__workbenchSetTheme).toBeUndefined();
});

test("a style added later gets the last forced theme", async () => {
  const stop = watchTheme(document);
  globalThis.__workbenchSetTheme?.("light");
  const style = addStyle(DARK);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(mediaOf(style)).toBe("not all");
  stop();
});

test("a theme forced before any style and before watchTheme still applies to later styles", async () => {
  forceTheme(document, "light");
  const stop = watchTheme(document);
  const style = addStyle(DARK);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(mediaOf(style)).toBe("not all");
  stop();
});

test("a style whose text is replaced keeps the forced theme", async () => {
  const style = addStyle(DARK);
  const stop = watchTheme(document);
  forceTheme(document, "light");
  style.textContent =
    "@media (prefers-color-scheme: dark) { body { color: red } }";
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(mediaOf(style)).toBe("not all");
  stop();
});
