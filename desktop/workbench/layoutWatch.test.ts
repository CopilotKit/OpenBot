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

test("a new main heading is a new screen: no moves", () => {
  const before: Snapshot = new Map([
    ["heading:Install", { box: box(0, 0), label: "h", main: true }],
    ["a", { box: box(0, 50), label: "a" }],
  ]);
  const after: Snapshot = new Map([
    ["heading:Connect your AI", { box: box(0, 0), label: "h", main: true }],
    ["a", { box: box(0, 200), label: "a" }],
  ]);
  expect(compare(before, after, 1, "x")).toEqual([]);
});

test("one element that moved 13px alone stays a warning", () => {
  const before: Snapshot = new Map([
    ["heading:Install", { box: box(0, 0), label: "h", main: true }],
    ["step", { box: box(0, 50), label: "Step 2 of 4" }],
    ["c", { box: box(0, 90), label: "c" }],
  ]);
  const after: Snapshot = new Map([
    ["heading:Install", { box: box(0, 0), label: "h", main: true }],
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

test("snapshot marks the first h1 or h2 as the main heading", () => {
  mount("<h3>Small</h3><h2>Main</h2><h1>Later</h1>");
  // happy-dom has no layout: give every element a box.
  const proto = Element.prototype;
  const real = proto.getBoundingClientRect;
  proto.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 10, height: 10 }) as DOMRect;
  try {
    const marked = [...snapshot(document)].filter(([, e]) => e.main);
    expect(marked.map(([key]) => key)).toEqual(["heading:Main"]);
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
