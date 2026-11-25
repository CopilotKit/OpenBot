import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

/*
 * Found on OpenBot Cloud (1.2.0-rc.5): every page load got a 404, from /favicon.ico. The page named no
 * icon, so the browser asked for the one it guesses at, and no icon file ships with the app. The page
 * names an icon that is already in it, so the browser asks for nothing.
 */
test("the page names its icon inline, so no page load asks for /favicon.ico", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const window = new Window();
  const document = new window.DOMParser().parseFromString(html, "text/html");
  const icons = [...document.querySelectorAll("head link[rel~='icon']")];
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons)
    expect(icon.getAttribute("href") ?? "").toStartWith("data:");
  window.close();
});
