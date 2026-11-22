import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { forceTheme } from "./frameTheme";
import type { Warning } from "./layoutWatch";
import {
  highlightLabel,
  highlightShapes,
  movementLabel,
  outsideParts,
  stillHtml,
  WarningHighlight,
} from "./WarningHighlight";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const VIEWPORT = { width: 800, height: 600 };

test("a move names its larger axis", () => {
  expect(movementLabel(0, 157)).toBe("moved 157 px down");
  expect(movementLabel(-12, 0)).toBe("moved 12 px left");
  expect(movementLabel(0, -40.4)).toBe("moved 40 px up");
  expect(movementLabel(30, 1)).toBe("moved 30 px right");
  // A small part of a large move is not named.
  expect(movementLabel(-5, 40)).toBe("moved 40 px down");
});

test("a diagonal move names both axes, the larger first", () => {
  expect(movementLabel(30, -20)).toBe("moved 30 px right and 20 px up");
  expect(movementLabel(-10, 40)).toBe("moved 40 px down and 10 px left");
  expect(movementLabel(5, 5)).toBe("moved 5 px right and 5 px down");
});

test("no move says 0 px", () => {
  expect(movementLabel(0.2, -0.3)).toBe("moved 0 px");
});

const moved: Warning = {
  kind: "moved",
  at: 1000,
  label: "row",
  dx: 0,
  dy: 157,
  cause: "clock",
  from: { x: 100, y: 400, width: 200, height: 20 },
  to: { x: 100, y: 557, width: 200, height: 20 },
};

const clipped: Warning = {
  kind: "clipped",
  at: 1000,
  label: "title",
  box: { x: 10, y: 50, width: 100, height: 16 },
  scrollWidth: 160,
  scrollHeight: 16,
};

const outside: Warning = {
  kind: "outside",
  at: 1000,
  label: "menu",
  overBy: 30,
  box: { x: 750, y: 100, width: 80, height: 20 },
};

test("each kind of warning has its label", () => {
  expect(highlightLabel(moved)).toBe("moved 157 px down");
  expect(highlightLabel(clipped)).toBe("cut off by 60 px");
  expect(highlightLabel({ ...clipped, scrollWidth: 100 })).toBe("cut off");
  expect(highlightLabel(outside)).toBe("30 px outside the window");
});

test("a move is a ghost where it was, a box where it is, and an arrow between", () => {
  const shapes = highlightShapes(moved, { x: 16, y: 44, scale: 2 }, VIEWPORT);
  expect(shapes.ghost).toEqual({ x: 216, y: 844, width: 400, height: 40 });
  expect(shapes.box).toEqual({ x: 216, y: 1158, width: 400, height: 40 });
  expect(shapes.arrow).toEqual({ x1: 416, y1: 864, x2: 416, y2: 1178 });
  expect(shapes.shaded).toEqual([]);
  expect(shapes.labelBelow).toBe(false);
});

test("cut-off text shades the hidden part past the box edge", () => {
  const shapes = highlightShapes(clipped, { x: 0, y: 0, scale: 1 }, VIEWPORT);
  expect(shapes.ghost).toBeNull();
  expect(shapes.box).toEqual(clipped.box);
  expect(shapes.shaded).toEqual([{ x: 110, y: 50, width: 60, height: 16 }]);
});

test("an element outside the window shades the part past the edge", () => {
  expect(outsideParts(outside.box, VIEWPORT)).toEqual([
    { x: 800, y: 100, width: 30, height: 20 },
  ]);
  expect(
    outsideParts({ x: -10, y: 590, width: 40, height: 20 }, VIEWPORT),
  ).toEqual([
    { x: -10, y: 590, width: 10, height: 20 },
    { x: -10, y: 600, width: 40, height: 10 },
  ]);
});

test("a box at the top of the window has its label below", () => {
  const top: Warning = { ...outside, box: { ...outside.box, y: 2 } };
  expect(
    highlightShapes(top, { x: 0, y: 30, scale: 1 }, VIEWPORT).labelBelow,
  ).toBe(true);
});

test("the highlight of a move draws two boxes, an arrow and its label", () => {
  const { container } = render(
    <WarningHighlight
      warning={moved}
      origin={{ x: 0, y: 0, scale: 1 }}
      viewport={VIEWPORT}
    />,
  );
  const root = container.querySelector("[data-workbench-highlight]");
  expect(root?.getAttribute("data-workbench-highlight")).toBe("moved");
  expect(
    [...container.querySelectorAll("[data-highlight-box]")].map((el) =>
      el.getAttribute("data-highlight-box"),
    ),
  ).toEqual(["from", "to"]);
  expect(container.querySelector("svg line")).not.toBeNull();
  expect(container.textContent).toBe("moved 157 px down");
});

test("the still of the window keeps its styles, content and typed values, and runs no script", () => {
  document.head.innerHTML =
    "<style>.card { color: red; }</style><script>window.ran = true;</script>";
  document.body.innerHTML =
    '<div class="card">Set up</div><input id="key" value=""><textarea id="note"></textarea><input type="checkbox" id="agree">';
  (document.getElementById("key") as HTMLInputElement).value = "sk-typed";
  (document.getElementById("note") as HTMLTextAreaElement).value = "a note";
  (document.getElementById("agree") as HTMLInputElement).checked = true;

  const html = stillHtml(document);
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).toContain(".card { color: red; }");
  expect(html).toContain('<div class="card">Set up</div>');
  expect(html).toContain('value="sk-typed"');
  expect(html).toContain(">a note</textarea>");
  expect(html).toMatch(/id="agree"[^>]*checked|checked[^>]*id="agree"/);
  expect(html).not.toContain("<script");
  expect(html).toContain("<base href=");
  // The live document is not changed.
  expect(document.querySelector("script")).not.toBeNull();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

test("the still of a window in a forced theme keeps that theme, not the system's", () => {
  // The workbench forces a dark window by rewriting its dark media rules at run time; the source
  // text still says prefers-color-scheme, so a copied <style> drew a dark window's still light.
  document.head.innerHTML =
    "<style>.card { color: black; } @media (prefers-color-scheme: dark) { .card { color: white; } }</style>";
  document.body.innerHTML = '<div class="card">Set up</div>';
  forceTheme(document, "dark");

  const html = stillHtml(document, "dark");
  expect(html).not.toContain("prefers-color-scheme");
  expect(html).toContain("@media all { .card { color: white; } }");
  expect(html).toContain(".card { color: black; }");
  // In a light window the dark rules never apply.
  expect(stillHtml(document, "light")).toContain(
    "@media not all { .card { color: white; } }",
  );
  // A shorthand with var() and a longhand after it stay as written (the CSSOM loses them).
  document.head.innerHTML =
    "<style>.spin { border: 2px solid var(--border); border-top-color: var(--ring); }</style>";
  expect(stillHtml(document, "dark")).toContain(
    ".spin { border: 2px solid var(--border); border-top-color: var(--ring); }",
  );
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});
