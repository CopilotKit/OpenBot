import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Box } from "./geometry";
import {
  clippedAndOutside,
  compare,
  elementKey,
  isVisuallyHidden,
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
    {
      kind: "moved",
      at: 5,
      label: "a",
      dx: 3,
      dy: 1,
      cause: "click",
      from: box(0, 0),
      to: box(3, 1),
    },
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
      // The first element of the group stands for all of it.
      from: box(0, 0),
      to: box(0, 100),
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
        from: { x: 0, y: 400, width: 10, height: 10 },
        to: { x: 0, y: 557, width: 10, height: 10 },
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
    {
      kind: "moved",
      at: 1,
      label: WHOLE_PAGE,
      dx: 0,
      dy: 150,
      cause: "x",
      from: box(0, 50),
      to: box(0, 200),
    },
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
      from: box(0, 50),
      to: box(0, 63),
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

// happy-dom has no layout: each element gets the box in its data-box ("x y width height"), or
// 10 x 10 at 0, 0.
function withBoxes(run: () => void) {
  const proto = Element.prototype;
  const real = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element) {
    const [x = 0, y = 0, width = 10, height = 10] = (
      this.getAttribute("data-box") ?? ""
    )
      .split(" ")
      .filter(Boolean)
      .map(Number);
    return { x, y, width, height } as DOMRect;
  };
  try {
    run();
  } finally {
    proto.getBoundingClientRect = real;
  }
}

const SR_ONLY =
  "position: absolute; overflow: hidden; white-space: nowrap; clip: rect(0px, 0px, 0px, 0px); clip-path: inset(50%);";

test("text for screen readers only is visually hidden", () => {
  withBoxes(() => {
    const body = mount(`
      <span id="sr" data-box="-1 -1 1 1" style="${SR_ONLY}">Conversations</span>
      <span id="clip" data-box="0 0 80 20" style="position: absolute; clip: rect(0px, 0px, 0px, 0px)">Bots</span>
      <span id="path" data-box="0 0 80 20" style="clip-path: inset(50%)">Sam Rivera, Acme</span>
      <span id="line" data-box="0 0 80 1">Thin</span>
      <span style="${SR_ONLY}" data-box="0 0 1 1"><b id="inner" data-box="0 0 80 20">Inside</b></span>
      <div data-box="0 0 200 0"><b id="wrapped" data-box="0 0 80 20">Shown</b></div>
      <span id="shown" style="clip-path: inset(10%)">Shown</span>
    `);
    const hidden = (id: string) =>
      isVisuallyHidden(body.querySelector(`#${id}`) as Element);
    expect(hidden("sr")).toBe(true);
    expect(hidden("clip")).toBe(true);
    expect(hidden("path")).toBe(true);
    expect(hidden("line")).toBe(true);
    expect(hidden("inner")).toBe(true);
    // A box of 0 height without hidden overflow does not hide what is in it.
    expect(hidden("wrapped")).toBe(false);
    expect(hidden("shown")).toBe(false);
  });
});

test("text for screen readers only has no key for moves and no cut-off or outside warning", () => {
  withBoxes(() => {
    mount(`
      <nav>
        <span data-box="-1 -1 1 1" style="${SR_ONLY}">Conversations</span>
        <span data-box="-20 0 80 20" style="clip-path: inset(50%)">Sam Rivera, Acme</span>
        <button data-box="-20 40 80 20">New conversation</button>
      </nav>
    `);
    expect([...snapshot(document).keys()]).toEqual(["button:New conversation"]);
    expect(clippedAndOutside(document, 3, { width: 800, height: 600 })).toEqual(
      [
        {
          kind: "outside",
          at: 3,
          label: 'button "New conversation"',
          overBy: 20,
          box: { x: -20, y: 40, width: 80, height: 20 },
        },
      ],
    );
  });
});

test("a cut-off warning has the box and the full size of the content", () => {
  withBoxes(() => {
    const body = mount(
      '<p data-box="10 20 100 16" style="white-space: nowrap; overflow: hidden">A long line</p>',
    );
    const p = body.querySelector("p") as HTMLElement;
    // happy-dom has no layout: give the paragraph a client and a scroll size.
    Object.defineProperty(p, "clientWidth", { value: 100 });
    Object.defineProperty(p, "clientHeight", { value: 16 });
    Object.defineProperty(p, "scrollWidth", { value: 160 });
    Object.defineProperty(p, "scrollHeight", { value: 16 });
    expect(clippedAndOutside(document, 9, { width: 800, height: 600 })).toEqual(
      [
        {
          kind: "clipped",
          at: 9,
          label: 'p "A long line"',
          box: { x: 10, y: 20, width: 100, height: 16 },
          scrollWidth: 160,
          scrollHeight: 16,
        },
      ],
    );
  });
});
