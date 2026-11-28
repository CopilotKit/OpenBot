import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Box } from "./geometry";
import { PICKED_STYLES, pickArea, pickElement } from "./pickElement";

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
afterEach(() => {
  document.body.innerHTML = "";
});
afterAll(() => GlobalRegistrator.unregister());

/** happy-dom does no layout: each element gets the box the test gives it. */
function place(element: Element, box: Box) {
  element.getBoundingClientRect = () =>
    ({
      ...box,
      top: box.y,
      left: box.x,
      right: box.x + box.width,
      bottom: box.y + box.height,
      toJSON: () => box,
    }) as DOMRect;
}

function build() {
  document.body.innerHTML = `
    <main>
      <h2>Setup</h2>
      <span class="pill" style="padding: 4px 8px; font-size: 12px">Step 1 of 4</span>
      <button><span>Continue</span></button>
      <div class="cards">
        <section><p>Engine</p></section>
        <section><p>Account</p></section>
      </div>
    </main>`;
  const q = (selector: string) => document.querySelector(selector) as Element;
  const all = document.querySelectorAll("section");
  const texts = document.querySelectorAll("section p");
  place(document.body, { x: 0, y: 0, width: 400, height: 400 });
  place(q("main"), { x: 0, y: 0, width: 400, height: 400 });
  place(q("h2"), { x: 16, y: 16, width: 200, height: 24 });
  place(q(".pill"), { x: 16, y: 50, width: 80, height: 20 });
  place(q("button"), { x: 16, y: 82, width: 100, height: 32 });
  place(q("button span"), { x: 16, y: 82, width: 100, height: 32 });
  place(q(".cards"), { x: 16, y: 130, width: 300, height: 60 });
  place(all[0] as Element, { x: 16, y: 130, width: 140, height: 60 });
  place(all[1] as Element, { x: 176, y: 130, width: 140, height: 60 });
  place(texts[0] as Element, { x: 16, y: 130, width: 140, height: 60 });
  place(texts[1] as Element, { x: 176, y: 130, width: 140, height: 60 });
  return q;
}

test("pickElement reads the label, box, gaps, grid, styles and text", () => {
  const q = build();
  const picked = pickElement(q(".pill"), document);
  expect(picked.label).toBe('span "Step 1 of 4"');
  expect(picked.box).toEqual({ x: 16, y: 50, width: 80, height: 20 });
  expect(picked.gaps.top).toBe(10);
  expect(picked.gaps.bottom).toBe(12);
  expect(picked.offGrid).toEqual({ x: 0, y: 2 });
  expect(Object.keys(picked.styles)).toEqual([...PICKED_STYLES]);
  expect(picked.styles["font-size"]).toBe("12px");
  expect(picked.styles.padding).toBe("4px 8px");
  expect(picked.text).toBe("Step 1 of 4");
  expect(picked.chain).toEqual([]);
});

test("pickElement names an element without a key by its tag and class", () => {
  const q = build();
  expect(pickElement(q(".cards"), document).label).toBe("div.cards");
});

test("pickArea keeps the elements fully in the area", () => {
  build();
  const picked = pickArea({ x: 10, y: 120, width: 320, height: 80 }, document);
  expect(picked.map((p) => p.label)).toEqual(['p "Engine"', 'p "Account"']);
  expect(picked[0]?.gaps.right).toBe(20);
});

test("pickArea keeps only the outer one of an element and its text with one box", () => {
  build();
  const picked = pickArea({ x: 10, y: 40, width: 110, height: 80 }, document);
  expect(picked.map((p) => p.label)).toEqual([
    'span "Step 1 of 4"',
    'button "Continue"',
  ]);
});

test("pickArea leaves out an element that is only partly in the area", () => {
  build();
  const picked = pickArea({ x: 10, y: 40, width: 100, height: 60 }, document);
  expect(picked.map((p) => p.label)).toEqual(['span "Step 1 of 4"']);
});
