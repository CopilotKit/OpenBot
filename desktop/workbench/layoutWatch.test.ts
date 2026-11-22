import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Box } from "./geometry";
import {
  compare,
  elementKey,
  type Snapshot,
  snapshot,
  WHOLE_PAGE,
} from "./layoutWatch";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const box = (x: number, y: number): Box => ({ x, y, width: 10, height: 10 });
const snap = (entries: Record<string, Box>): Snapshot =>
  new Map(Object.entries(entries).map(([k, b]) => [k, { box: b, label: k }]));

test("a 2px shift is not a move", () => {
  expect(
    compare(snap({ a: box(0, 0) }), snap({ a: box(2, -2) }), 1, "click"),
  ).toEqual([]);
});

test("a 3px shift is a move with its cause", () => {
  expect(
    compare(snap({ a: box(0, 0) }), snap({ a: box(3, 1) }), 5, "click"),
  ).toEqual([
    { kind: "moved", at: 5, label: "a", dx: 3, dy: 1, cause: "click" },
  ]);
});

test("a key in only one snapshot is ignored", () => {
  expect(
    compare(snap({ a: box(0, 0) }), snap({ b: box(50, 50) }), 1, "x"),
  ).toEqual([]);
});

test("a group that moved by the same amount is one warning for the whole page", () => {
  const before = snap({
    a: box(0, 0),
    b: box(0, 20),
    c: box(0, 40),
    d: box(50, 0),
  });
  const after = snap({
    a: box(0, 100),
    b: box(0.5, 120.5),
    c: box(0, 140),
    d: box(50, 0),
  });
  expect(compare(before, after, 7, "clock")).toEqual([
    {
      kind: "moved",
      at: 7,
      label: WHOLE_PAGE,
      dx: 0,
      dy: 100,
      cause: "clock",
    },
  ]);
});

test("a group that is less than half of the page keeps one warning each", () => {
  const before = snap({
    a: box(0, 0),
    b: box(0, 20),
    c: box(50, 0),
    d: box(50, 20),
    e: box(50, 40),
  });
  const after = snap({
    a: box(0, 30),
    b: box(0, 50),
    c: box(50, 0),
    d: box(50, 20),
    e: box(50, 40),
  });
  expect(compare(before, after, 1, "x").map((w) => w.label)).toEqual([
    "a",
    "b",
  ]);
});

test("a new main heading still reports what stayed on the screen and moved", () => {
  // The step changes from the license to the AI step. The old step's text goes away (no key in
  // the new snapshot); the step list and the background row stay, and the row jumps 157px.
  const proto = Element.prototype;
  const real = proto.getBoundingClientRect;
  // happy-dom has no layout: each element takes its y from data-y.
  proto.getBoundingClientRect = function (this: Element) {
    const y = Number(this.closest("[data-y]")?.getAttribute("data-y") ?? 0);
    return { x: 0, y, width: 10, height: 10 } as DOMRect;
  };
  const screen = (heading: string, body: string, rowY: number) =>
    mount(
      `<main><h1 data-y="0">${heading}</h1>${body}` +
        '<ol><li data-y="300">Account</li></ol>' +
        `<span data-y="${rowY}">Installing OpenBot in the background</span></main>`,
    );
  try {
    screen("Accept the license agreement", '<p data-y="40">Read it</p>', 400);
    const before = snapshot(document);
    screen("Connect your AI", '<p data-y="40">Pick a provider</p>', 557);
    expect(compare(before, snapshot(document), 37, "clock")).toEqual([
      {
        kind: "moved",
        at: 37,
        label: 'span "Installing OpenBot in the background"',
        dx: 0,
        dy: 157,
        cause: "clock",
      },
    ]);
  } finally {
    proto.getBoundingClientRect = real;
  }
});

test("a new main heading with most of the page moved is one warning for the whole page", () => {
  const before = snap({
    "heading:Install": box(0, 0),
    a: box(0, 50),
    b: box(0, 70),
    c: box(0, 90),
  });
  const after = snap({
    "heading:Connect your AI": box(0, 0),
    a: box(0, 200),
    b: box(0, 220),
    c: box(0, 240),
  });
  expect(compare(before, after, 1, "x")).toEqual([
    { kind: "moved", at: 1, label: WHOLE_PAGE, dx: 0, dy: 150, cause: "x" },
  ]);
});

test("one element that moved 13px alone stays a warning", () => {
  const before: Snapshot = new Map([
    ["heading:Install", { box: box(0, 0), label: "h" }],
    ["step", { box: box(0, 50), label: "Step 2 of 4" }],
    ["c", { box: box(0, 90), label: "c" }],
  ]);
  const after: Snapshot = new Map([
    ["heading:Install", { box: box(0, 0), label: "h" }],
    ["step", { box: box(0, 63), label: "Step 2 of 4" }],
    ["c", { box: box(0, 90), label: "c" }],
  ]);
  expect(compare(before, after, 3, "clock")).toEqual([
    {
      kind: "moved",
      at: 3,
      label: "Step 2 of 4",
      dx: 0,
      dy: 13,
      cause: "clock",
    },
  ]);
});

test("snapshot numbers a key that is on the page more than once", () => {
  mount("<h2>Main</h2><button>Next</button><button>Next</button>");
  // happy-dom has no layout: give every element a box.
  const proto = Element.prototype;
  const real = proto.getBoundingClientRect;
  proto.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 10, height: 10 }) as DOMRect;
  try {
    expect([...snapshot(document).keys()]).toEqual([
      "heading:Main",
      "button:Next",
      "button:Next#2",
    ]);
  } finally {
    proto.getBoundingClientRect = real;
  }
});

function mount(html: string) {
  document.body.innerHTML = html;
  return document.body;
}

test("a button is keyed by role and text", () => {
  const body = mount("<button>Install</button>");
  expect(elementKey(body.querySelector("button") as Element)).toBe(
    "button:Install",
  );
});

test("an input is keyed by its label", () => {
  const body = mount('<label for="a">Base URL</label><input id="a">');
  expect(elementKey(body.querySelector("input") as Element)).toBe(
    "textbox:Base URL",
  );
});

test("an aria-hidden ancestor hides the element", () => {
  const body = mount('<div aria-hidden="true"><button>Install</button></div>');
  expect(elementKey(body.querySelector("button") as Element)).toBeNull();
});
