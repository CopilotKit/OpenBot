import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Box } from "./geometry";
import {
  clippedAndOutside,
  compare,
  elementKey,
  hiddenPx,
  isVisuallyHidden,
  type Snapshot,
  snapshot,
  spinnerWarnings,
  visibleSpinners,
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

/**
 * happy-dom has no layout. Each element gets its box from `data-box`, the lines of its own text
 * from `data-text` ("x y w h", one line), and a client and scroll size from `data-size`
 * ("clientW clientH scrollW scrollH").
 */
function withText(run: () => void) {
  const real = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function (this: Range) {
    const owner = this.startContainer.parentElement;
    const text = owner?.getAttribute("data-text");
    if (!text) return [] as unknown as DOMRectList;
    const [x = 0, y = 0, width = 0, height = 0] = text.split(" ").map(Number);
    return [{ x, y, width, height }] as unknown as DOMRectList;
  };
  try {
    withBoxes(() => {
      for (const element of Array.from(
        document.querySelectorAll("[data-size]"),
      )) {
        const [cw = 0, ch = 0, sw = 0, sh = 0] = (
          element.getAttribute("data-size") ?? ""
        )
          .split(" ")
          .map(Number);
        Object.defineProperty(element, "clientWidth", { value: cw });
        Object.defineProperty(element, "clientHeight", { value: ch });
        Object.defineProperty(element, "scrollWidth", { value: sw });
        Object.defineProperty(element, "scrollHeight", { value: sh });
      }
      run();
    });
  } finally {
    Range.prototype.getClientRects = real;
  }
}

const clippedIn = (html: string) => {
  mount(html);
  let kinds: string[] = [];
  withText(() => {
    kinds = clippedAndOutside(document, 9, { width: 800, height: 600 })
      .filter((w) => w.kind === "clipped")
      .map((w) => w.label);
  });
  return kinds;
};

test("a cut-off warning has the box and the full size of the content", () => {
  mount(
    '<p data-box="10 20 100 16" data-size="100 16 160 16" data-text="10 20 160 16" style="white-space: nowrap; overflow: hidden">A long line</p>',
  );
  withText(() => {
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

test("text with an ellipsis on purpose is not cut off", () => {
  expect(
    clippedIn(
      '<span data-box="0 0 100 16" data-size="100 16 234 16" data-text="0 0 234 16" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis">Help with everyday work using clear answers.</span>',
    ),
  ).toEqual([]);
});

test("an ellipsis on the box that cuts the text is on purpose too", () => {
  expect(
    clippedIn(`
      <div data-box="0 0 100 16" data-size="100 16 180 16" style="overflow: hidden; white-space: nowrap; text-overflow: ellipsis">
        <span data-box="0 0 180 16" data-size="180 16 180 17" data-text="0 0 180 17">What is on my plate today?</span>
      </div>`),
  ).toEqual([]);
});

test("text clamped to a number of lines is not cut off", () => {
  expect(
    clippedIn(
      '<p data-box="0 0 100 32" data-size="100 32 100 64" data-text="0 0 100 64" style="overflow: hidden; -webkit-line-clamp: 2; line-clamp: 2; display: -webkit-box">A long paragraph</p>',
    ),
  ).toEqual([]);
});

test("text that overflows where nothing cuts it is not cut off", () => {
  // The tab case: a 28 px text box in a 25 px trigger with overflow visible.
  expect(
    clippedIn(
      '<button role="tab" data-box="0 0 120 25" data-size="120 25 120 28" data-text="10 -1 100 28">Use an API key</button>',
    ),
  ).toEqual([]);
});

test("text that a box with hidden overflow cuts by more than 2 px is cut off", () => {
  expect(
    clippedIn(`
      <div data-box="0 0 100 20" data-size="100 20 100 20" style="overflow: hidden">
        <p data-box="0 0 100 20" data-size="100 20 140 20" data-text="0 0 140 20" style="white-space: nowrap">A long line of text</p>
      </div>`),
  ).toEqual(['p "A long line of text"']);
});

test("text cut by 2 px or less is not cut off", () => {
  expect(
    clippedIn(
      '<p data-box="0 0 100 20" data-size="100 20 102 22" data-text="0 0 102 22" style="overflow: hidden">Nearly fits</p>',
    ),
  ).toEqual([]);
});

test("text whose lines are all inside the cutting box is not cut off", () => {
  // The scroll size is larger (padding, a child), but every line of the text shows.
  expect(
    clippedIn(
      '<p data-box="0 0 100 20" data-size="100 20 130 20" data-text="4 2 80 16" style="overflow: hidden">Short</p>',
    ),
  ).toEqual([]);
});

test("text in a box that scrolls is not cut off", () => {
  expect(
    clippedIn(`
      <div data-box="0 0 100 20" style="overflow: hidden">
        <div data-box="0 0 100 20" style="overflow-x: auto">
          <p data-box="0 0 100 20" data-size="100 20 300 20" data-text="0 0 300 20" style="white-space: nowrap">Scroll to read all</p>
        </div>
      </div>`),
  ).toEqual([]);
});

test("hiddenPx is how far the text goes past a side of the box", () => {
  const clip = { x: 0, y: 0, width: 100, height: 20 };
  expect(hiddenPx([{ x: 0, y: 0, width: 100, height: 20 }], clip)).toBe(0);
  expect(hiddenPx([{ x: 0, y: 0, width: 134, height: 20 }], clip)).toBe(34);
  expect(hiddenPx([{ x: -5, y: 0, width: 50, height: 20 }], clip)).toBe(5);
  expect(hiddenPx([{ x: 0, y: 18, width: 50, height: 10 }], clip)).toBe(8);
  expect(hiddenPx([], clip)).toBe(0);
});

test("an element below the window is not outside when the page scrolls to it", () => {
  mount(
    '<main data-box="0 0 800 1200"><p data-box="0 1100 400 20">Ask in plain words.</p><footer style="position: fixed" data-box="0 620 400 40"><button data-box="0 620 400 40">Get started</button></footer></main>',
  );
  const scroller = document.documentElement;
  Object.defineProperty(scroller, "scrollHeight", {
    value: 1200,
    configurable: true,
  });
  Object.defineProperty(scroller, "clientHeight", {
    value: 600,
    configurable: true,
  });
  try {
    withBoxes(() => {
      const labels = clippedAndOutside(document, 0, {
        width: 800,
        height: 600,
      }).map((w) => `${w.kind} ${w.label}`);
      // The fixed footer does not scroll with the page, so it is still outside.
      expect(labels).toEqual(['outside button "Get started"']);
    });
  } finally {
    delete (scroller as unknown as Record<string, unknown>).scrollHeight;
    delete (scroller as unknown as Record<string, unknown>).clientHeight;
  }
});

test("an element below the window is outside when the page does not scroll", () => {
  mount('<p data-box="0 1100 400 20">Ask in plain words.</p>');
  withBoxes(() => {
    expect(
      clippedAndOutside(document, 0, { width: 800, height: 600 }).map(
        (w) => `${w.kind} ${w.label}`,
      ),
    ).toEqual(['outside p "Ask in plain words."']);
  });
});

// --- One spinner at a time ----------------------------------------------------------------------

test("one spinner is no warning", () => {
  withBoxes(() => {
    mount(`
      <ol aria-label="Setup progress">
        <li aria-label="Installing OpenBot"><span aria-hidden="true"><span class="step-spinner"></span></span></li>
      </ol>
      <aside><li aria-label="Background install"><span aria-hidden="true"><span class="step-current"></span></span></li></aside>
    `);
    expect(spinnerWarnings(document, 4)).toEqual([]);
  });
});

test("two spinners at once are one warning that names where each is", () => {
  withBoxes(() => {
    mount(`
      <li aria-label="Installing OpenBot"><span aria-hidden="true"><span class="step-spinner" data-box="20 100 14 14"></span></span></li>
      <p class="status-line" role="status"><span class="step-spinner" aria-hidden="true" data-box="20 300 14 14"></span><span>Starting OpenBot</span></p>
    `);
    expect(spinnerWarnings(document, 7)).toEqual([
      {
        kind: "spinners",
        at: 7,
        label: '2 spinners: "Installing OpenBot", <p class="status-line">',
        count: 2,
        boxes: [
          { x: 20, y: 100, width: 14, height: 14 },
          { x: 20, y: 300, width: 14, height: 14 },
        ],
        box: { x: 20, y: 100, width: 14, height: 214 },
      },
    ]);
  });
});

test("the app's spinning icon counts as a spinner, an icon inside it does not count twice", () => {
  withBoxes(() => {
    mount(`
      <span class="step-spinner" aria-hidden="true"></span>
      <button>Saving<svg class="animate-spin" aria-hidden="true"><path class="animate-spin"></path></svg></button>
    `);
    expect(visibleSpinners(document)).toHaveLength(2);
    expect(spinnerWarnings(document, 1).map((w) => w.label)).toEqual([
      "2 spinners: <body>, <button>",
    ]);
  });
});

test("a spinner a person does not see is not counted", () => {
  withBoxes(() => {
    mount(`
      <span class="step-spinner"></span>
      <div hidden><span class="step-spinner"></span></div>
      <div style="display: none"><span class="step-spinner"></span></div>
      <div style="opacity: 0"><span class="step-spinner"></span></div>
      <span class="step-spinner" style="visibility: hidden"></span>
      <span class="step-spinner" data-box="0 0 0 0"></span>
      <span style="${SR_ONLY}" data-box="0 0 1 1"><span class="step-spinner"></span></span>
    `);
    expect(visibleSpinners(document)).toHaveLength(1);
    expect(spinnerWarnings(document, 1)).toEqual([]);
  });
});

test("a held-still mark (step-current, step-waiting) is not a spinner", () => {
  withBoxes(() => {
    mount(`
      <span class="step-spinner"></span>
      <span class="step-current"></span>
      <span class="step-waiting"></span>
    `);
    expect(spinnerWarnings(document, 1)).toEqual([]);
  });
});

test("text that fits its own box but a smaller box with hidden overflow cuts is cut off", () => {
  // A 200 px paragraph whose text fits it, in an 80 px box that hides overflow.
  expect(
    clippedIn(`
      <div data-box="0 0 80 20" data-size="80 20 200 20" style="overflow: hidden">
        <p data-box="0 0 200 20" data-size="200 20 200 20" data-text="0 0 190 20" style="white-space: nowrap">A paragraph wider than its box</p>
      </div>`),
  ).toEqual(['p "A paragraph wider than its box"']);
});

test("text that a box with hidden overflow hides entirely is hidden, not cut off", () => {
  // A collapsed panel: the box shows none of the text, which is hidden on purpose.
  expect(
    clippedIn(`
      <div data-box="0 0 200 20" data-size="200 20 200 60" style="overflow: hidden">
        <p data-box="0 30 200 20" data-size="200 20 200 20" data-text="0 30 190 20">In the closed part</p>
      </div>`),
  ).toEqual([]);
});
