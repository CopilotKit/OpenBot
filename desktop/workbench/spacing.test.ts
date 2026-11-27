import { expect, test } from "bun:test";
import {
  BUTTONS_LABEL,
  boxGap,
  buttonsColumn,
  CLEARANCE_PX,
  clearanceIssues,
  columnIssues,
  rowIssues,
  type SpacingElement,
  spacingIssues,
} from "./spacing";
import {
  MAC_BUTTONS,
  macButtonCircles,
  macButtonsBox,
  windowButtonsBox,
} from "./titleBar";

const VIEWPORT = { width: 1142, height: 800 };

/*
 * Dusty's capture of Settings → Connections, dark, in window pixels (scale 1.0, the window's outer
 * edge at x 55, y 37 of the 1252 px capture): the circles' centres at 27, 48, 68 and 33, so the
 * three run from 21 to 74; the strip is 73 px wide; the inset panel starts 5 px past the green
 * light, 8 px down, with a rounded corner; the orb is the strip's first item.
 */
const DUSTY_BUTTONS = { x: 21, y: 27, width: 53, height: 12 };
const STRIP: SpacingElement = {
  label: 'panel <div data-slot="strip">',
  box: { x: 0, y: 0, width: 73, height: 800 },
  content: false,
  panel: false,
};
const PANEL: SpacingElement = {
  label: 'panel <main data-slot="sidebar-inset">',
  box: { x: 79, y: 8, width: 1055, height: 784 },
  content: false,
  panel: true,
};
const ORB: SpacingElement = {
  label: 'img "OpenBot"',
  box: { x: 22, y: 54, width: 28, height: 28 },
  content: true,
  panel: false,
};
const BACKGROUND: SpacingElement = {
  label: "panel <body>",
  box: { x: 0, y: 0, width: 1142, height: 800 },
  content: false,
  panel: true,
};
const DUSTY = [BACKGROUND, STRIP, ORB, PANEL];

test("the Mac buttons are where TRAFFIC_LIGHTS and AppKit put them", () => {
  expect(MAC_BUTTONS.position).toEqual({ x: 20, y: 31 });
  expect(macButtonCircles().map((c) => c.x + c.width / 2)).toEqual([
    27, 47, 67,
  ]);
  expect(macButtonsBox()).toEqual({ x: 21, y: 26.5, width: 52, height: 12 });
  // Within the capture's 1 px rounding of Dusty's centres (27, 48, 68; 33).
  for (const [i, centre] of [27, 48, 68].entries()) {
    const circle = macButtonCircles()[i];
    expect(Math.abs((circle?.x ?? 0) + 6 - centre)).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(MAC_BUTTONS.middleY - 33)).toBeLessThanOrEqual(1);
});

test("only a Mac desktop window has buttons over the page", () => {
  expect(windowButtonsBox("mac", "desktop")).toEqual(macButtonsBox());
  expect(windowButtonsBox("mac", "browser")).toBeNull();
  expect(windowButtonsBox("windows", "desktop")).toBeNull();
});

test("boxGap is 0 for touching boxes and the corner distance diagonally", () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  expect(boxGap(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(0);
  expect(boxGap(a, { x: 13, y: 14, width: 5, height: 5 })).toBe(5);
});

test("Dusty's capture: the panel's edge is 5 px from the buttons", () => {
  const issues = clearanceIssues(DUSTY_BUTTONS, DUSTY, VIEWPORT);
  expect(issues).toEqual([
    {
      rule: "clearance",
      label: PANEL.label,
      box: PANEL.box,
      size: CLEARANCE_PX - 5,
      text: `${PANEL.label} is 5 px from the window buttons`,
    },
  ]);
});

test("Dusty's capture: the buttons are not in the middle of the strip's gutter, over the orb", () => {
  const column = buttonsColumn(DUSTY_BUTTONS, DUSTY, VIEWPORT);
  // The strip, and its gutter on to the panel's edge 5 px past the green light: 79 px.
  expect(column?.label).toBe(`${STRIP.label} up to ${PANEL.label}`);
  expect(column?.box).toEqual({ x: 0, y: 0, width: 79, height: 800 });
  const issues = columnIssues(DUSTY_BUTTONS, column, DUSTY);
  expect(issues).toHaveLength(1);
  expect(issues[0]?.rule).toBe("column");
  expect(issues[0]?.label).toBe(BUTTONS_LABEL);
  expect(issues[0]?.size).toBe(8);
  expect(issues[0]?.text).toBe(
    `${BUTTONS_LABEL} sit 8 px right of the middle of their column (${STRIP.label} up to ${PANEL.label}, 79 px wide) and of img "OpenBot" under them: 21 px from its left edge, 5 px from its right`,
  );
});

test("Dusty's capture: the panel starts beside the buttons, above their middle", () => {
  const issues = rowIssues(DUSTY_BUTTONS, DUSTY);
  expect(issues).toHaveLength(1);
  expect(issues[0]?.rule).toBe("row");
  expect(issues[0]?.label).toBe(PANEL.label);
  expect(issues[0]?.size).toBe(25);
});

test("Dusty's capture gives all three rules at once", () => {
  expect(
    spacingIssues(DUSTY_BUTTONS, DUSTY, VIEWPORT).map((i) => i.rule),
  ).toEqual(["clearance", "column", "row"]);
});

test("a column narrower than the buttons and their room says by how much", () => {
  const narrow = { ...STRIP, box: { ...STRIP.box, width: 60 } };
  const buttons = { x: 4, y: 27, width: 52, height: 12 };
  const issues = columnIssues(buttons, narrow, []);
  expect(issues[0]).toMatchObject({
    rule: "fit",
    size: 8,
    text: `${BUTTONS_LABEL} do not fit their column: 60 px for 68 px`,
  });
  // 4 px from the left, 4 px from the right: in the middle.
  expect(issues).toHaveLength(1);
});

test("a page that leaves room around centred buttons has no issues", () => {
  const buttons = macButtonsBox();
  const strip = { ...STRIP, box: { x: 0, y: 0, width: 94, height: 800 } };
  const panel = { ...PANEL, box: { x: 94, y: 0, width: 1048, height: 800 } };
  const orb = { ...ORB, box: { x: 33, y: 54, width: 28, height: 28 } };
  // The panel's top is on the window's edge, so its edge there is not seen.
  expect(
    spacingIssues(buttons, [BACKGROUND, strip, orb, panel], VIEWPORT),
  ).toEqual([]);
});

test("content under the buttons is under them; content that holds them is not", () => {
  const buttons = macButtonsBox();
  const title = {
    label: 'heading "Connections"',
    box: { x: 40, y: 20, width: 200, height: 24 },
    content: true,
    panel: false,
  };
  const wrapper = {
    label: 'div "Everything"',
    box: { x: 0, y: 0, width: 300, height: 300 },
    content: true,
    panel: false,
  };
  const issues = clearanceIssues(buttons, [title, wrapper], VIEWPORT);
  expect(issues.map((i) => i.text)).toEqual([
    'heading "Connections" is under the window buttons',
  ]);
});

test("a panel that holds the buttons counts its inner edges, not the window's", () => {
  const buttons = macButtonsBox();
  const card = {
    label: "panel <aside>",
    box: { x: 16, y: 0, width: 200, height: 800 },
    content: false,
    panel: true,
  };
  const [issue] = clearanceIssues(buttons, [card], VIEWPORT);
  expect(issue?.text).toBe("panel <aside> is 5 px from the window buttons");
});

test("the row: an item beside the buttons with another middle", () => {
  const buttons = macButtonsBox();
  const back = {
    label: 'link "Back to app"',
    box: { x: 88, y: 18.5, width: 100, height: 20 },
    content: true,
    panel: false,
  };
  expect(rowIssues(buttons, [back])[0]?.text).toBe(
    `${BUTTONS_LABEL}' middle is 4 px below the middle of link "Back to app" beside them`,
  );
  const level = { ...back, box: { ...back.box, y: 22.5 } };
  expect(rowIssues(buttons, [level])).toEqual([]);
});

test("in a wide sidebar the buttons sit at its top left: no column issue", () => {
  const buttons = macButtonsBox();
  const sidebar: SpacingElement = {
    label: '<div data-slot="sidebar-inner">',
    box: { x: 8, y: 8, width: 324, height: 784 },
    content: false,
    panel: false,
  };
  expect(buttonsColumn(buttons, [sidebar], VIEWPORT)).toBe(sidebar);
  expect(columnIssues(buttons, sidebar, [])).toEqual([]);
});
