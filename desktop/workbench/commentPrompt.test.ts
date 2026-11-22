import { describe, expect, test } from "bun:test";
import {
  buildPrompt,
  type CommentContext,
  type PickedElement,
} from "./commentPrompt";

const context: CommentContext = {
  comment: "This should be centered",
  scene: { id: "setup-welcome", title: "Setup welcome" },
  atSeconds: 75,
  window: {
    width: 1000,
    height: 800,
    os: "mac",
    active: true,
    theme: "dark",
    zoom: 1,
    grid: false,
  },
  link: "http://localhost:5173/#abc",
};

const none = { top: null, right: null, bottom: null, left: null };

function el(
  label: string,
  y: number,
  over: Partial<PickedElement> = {},
): PickedElement {
  return {
    label,
    box: { x: 0, y, width: 100, height: 20 },
    gaps: none,
    offGrid: { x: 0, y: 0 },
    styles: { "font-size": "14px", "line-height": "20px", padding: "8px" },
    chain: [{ name: "Row", file: "desktop/src/Row.tsx", line: 12 }],
    text: "",
    ...over,
  };
}

describe("buildPrompt, element", () => {
  const prompt = buildPrompt(
    { kind: "element", element: el("button.save", 40) },
    context,
  );

  test("has the comment, chain, file and shot command", () => {
    expect(prompt).toContain("> This should be centered");
    expect(prompt).toContain("Row · desktop/src/Row.tsx:12");
    expect(prompt).toContain(
      "cd desktop && bun run workbench:shot setup-welcome --at 75 --size 1000x800 --os mac --theme dark --grid",
    );
    expect(prompt).toContain("1:15");
  });

  test("says none for missing gaps", () => {
    expect(prompt).toContain("Gaps to the nearest neighbour: none");
  });

  test("cuts long text", () => {
    const long = buildPrompt(
      { kind: "element", element: el("p", 0, { text: "a".repeat(300) }) },
      context,
    );
    expect(long).toContain(`"${"a".repeat(200)}…"`);
    expect(long).not.toContain("a".repeat(201));
  });
});

describe("buildPrompt, area", () => {
  const elements = [
    el("c", 100, {
      styles: { "font-size": "12px", "line-height": "16px", padding: "4px" },
    }),
    el("a", 0),
    el("b", 28),
    el("d", 160),
  ];
  const prompt = buildPrompt(
    { kind: "area", area: { x: 0, y: 0, width: 200, height: 200 }, elements },
    context,
  );

  test("has the count and rows top to bottom", () => {
    expect(prompt).toContain("Elements in the area: 4");
    const order = ["| a |", "| b |", "| c |", "| d |"].map((s) =>
      prompt.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  test("computes min, median and max vertical gaps", () => {
    // ys 0, 28, 100, 160 with height 20: gaps 8, 52, 40
    expect(prompt).toContain("min 8, median 40, max 52");
  });

  test("lists font size pairs and padding", () => {
    expect(prompt).toContain("14px / 20px (3)");
    expect(prompt).toContain("12px / 16px (1)");
    expect(prompt).toContain("8px (3)");
  });
});
