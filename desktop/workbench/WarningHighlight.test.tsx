import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import type { Warning } from "./layoutWatch";
import {
  highlightLabel,
  highlightShapes,
  movementLabel,
  outsideParts,
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

test("a Spacing warning boxes the element, shades the window buttons and labels them", () => {
  const buttons = { x: 21, y: 26.5, width: 52, height: 12 };
  const warning: Warning = {
    kind: "spacing",
    at: 0,
    label: 'panel <main data-slot="sidebar-inset">',
    rule: "clearance",
    box: { x: 73, y: 8, width: 700, height: 500 },
    buttons,
    size: 8,
    text: 'panel <main data-slot="sidebar-inset"> is 0 px from the window buttons',
  };
  const shapes = highlightShapes(
    warning,
    { x: 100, y: 50, scale: 2 },
    VIEWPORT,
  );
  expect(shapes.box).toEqual({ x: 246, y: 66, width: 1400, height: 1000 });
  expect(shapes.shaded).toEqual([{ x: 142, y: 103, width: 104, height: 24 }]);
  expect(shapes.labelAt).toEqual({ x: 142, y: 103, width: 104, height: 24 });
  expect(highlightLabel(warning)).toBe("0 px from the window buttons");
  expect(highlightLabel({ ...warning, rule: "column", size: 11 })).toBe(
    "window buttons 11 px off the column's middle",
  );
});

test("a Spinners highlight boxes all the spinners and shades each one", () => {
  const warning: Warning = {
    kind: "spinners",
    at: 0,
    label: '2 spinners: "Installing OpenBot", <p class="status-line">',
    count: 2,
    boxes: [
      { x: 20, y: 100, width: 14, height: 14 },
      { x: 20, y: 300, width: 14, height: 14 },
    ],
    box: { x: 20, y: 100, width: 14, height: 214 },
  };
  const shapes = highlightShapes(warning, { x: 0, y: 0, scale: 1 }, VIEWPORT);
  expect(shapes.box).toEqual(warning.box);
  expect(shapes.shaded).toEqual(warning.boxes);
  expect(highlightLabel(warning)).toBe("2 spinners at once");
});

test("the highlight takes its colors from the app's tokens: a problem is destructive, a move the ring", () => {
  const box = (warning: Warning) => {
    const view = render(
      <WarningHighlight
        warning={warning}
        origin={{ x: 0, y: 0, scale: 1 }}
        viewport={VIEWPORT}
      />,
    );
    const el = view.container.querySelector(
      "[data-highlight-box='box'], [data-highlight-box='to']",
    );
    const classes = el?.className ?? "";
    cleanup();
    return classes;
  };
  const cut = box(clipped);
  expect(cut).toContain("border-destructive");
  expect(cut).toContain("bg-destructive/10");
  expect(box(outside)).toContain("border-destructive");
  expect(box(moved)).toContain("border-ring");
});
