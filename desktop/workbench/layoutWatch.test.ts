import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Box } from "./geometry";
import { compare, elementKey, type Snapshot } from "./layoutWatch";

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
