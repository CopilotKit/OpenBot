import { describe, expect, test } from "bun:test";
import {
  buildPrompt,
  type CommentContext,
  type PickedElement,
  verticalGaps,
} from "./commentPrompt";

const context: CommentContext = {
  comment: "This should be centered",
  scene: { id: "setup-welcome", title: "Setup welcome" },

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
      "cd desktop && bun run desktop-workbench:shot --url 'http://localhost:5173/#abc'",
    );
    expect(prompt).not.toContain("--at");
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

describe("verticalGaps", () => {
  const box = (x: number, y: number, width: number, height: number) => ({
    x,
    y,
    width,
    height,
  });

  test("measures a stack", () => {
    expect(
      verticalGaps([
        box(0, 0, 100, 20),
        box(0, 28, 100, 20),
        box(0, 60, 100, 20),
      ]),
    ).toEqual([8, 12]);
  });

  test("ignores elements side by side on one row", () => {
    // Two cards on one row and a footer under both.
    expect(
      verticalGaps([
        box(0, 0, 100, 50),
        box(120, 10, 100, 40),
        box(0, 70, 220, 20),
      ]),
    ).toEqual([20]);
  });

  test("ignores nested elements", () => {
    // A card with a title and a line of text in it.
    expect(
      verticalGaps([
        box(0, 0, 200, 100),
        box(16, 16, 100, 20),
        box(16, 44, 100, 20),
      ]),
    ).toEqual([8]);
  });

  test("drops negative values", () => {
    expect(verticalGaps([box(0, 0, 100, 30), box(50, 20, 100, 30)])).toEqual(
      [],
    );
  });

  test("takes the nearest element above", () => {
    expect(
      verticalGaps([
        box(0, 0, 100, 10),
        box(0, 20, 100, 10),
        box(0, 44, 100, 10),
      ]),
    ).toEqual([10, 14]);
  });
});

test("an area of nested and side by side elements reports only the real gaps", () => {
  const card = (label: string, x: number) =>
    el(label, 0, { box: { x, y: 0, width: 100, height: 80 } });
  const title = (label: string, x: number) =>
    el(label, 0, { box: { x: x + 8, y: 8, width: 80, height: 20 } });
  const body = (label: string, x: number) =>
    el(label, 0, { box: { x: x + 8, y: 40, width: 80, height: 20 } });
  const prompt = buildPrompt(
    {
      kind: "area",
      area: { x: 0, y: 0, width: 240, height: 100 },
      elements: [
        card("a", 0),
        title("a1", 0),
        body("a2", 0),
        card("b", 120),
        title("b1", 120),
        body("b2", 120),
      ],
    },
    context,
  );
  expect(prompt).toContain(
    "Vertical gaps between neighbouring elements (2): min 12, median 12, max 12",
  );
});

test("leaves out empty styles", () => {
  const prompt = buildPrompt(
    {
      kind: "element",
      element: el("p", 0, { styles: { "font-size": "14px", gap: "" } }),
    },
    context,
  );
  expect(prompt).toContain("- Styles: font-size: 14px\n");
});

describe("buildPrompt, app scenes", () => {
  const element = el("button.save", 40, {
    gaps: { top: 8, right: null, bottom: null, left: null },
    styles: { "font-size": "14px" },
    text: "Save",
  });

  const appContext = (host: "desktop" | "browser"): CommentContext => ({
    ...context,
    scene: { id: "app-home-bots", title: "Home with Bots" },
    app: { route: "/settings/computer", host },
  });

  test("names the route and the host", () => {
    const desktop = buildPrompt(
      { kind: "element", element },
      appContext("desktop"),
    );
    expect(desktop).toContain(
      "- Route: /settings/computer\n- Host: OpenBot Desktop\n",
    );
    const browser = buildPrompt(
      { kind: "element", element },
      appContext("browser"),
    );
    expect(browser).toContain("- Route: /settings/computer\n- Host: Browser\n");
  });

  test("the shot command uses the complete configuration link", () => {
    const prompt = buildPrompt(
      { kind: "element", element },
      appContext("browser"),
    );
    expect(prompt).toContain(`desktop-workbench:shot --url '${context.link}'`);
    expect(prompt).not.toContain("--at");
  });

  test("the to-do list names app/src and the data access rules", () => {
    const prompt = buildPrompt(
      { kind: "element", element },
      appContext("desktop"),
    );
    expect(prompt).toContain(
      "5. The app's files are under `app/src`. If the change loads or changes server data, follow the repo's `openbot-data-access` rules.\n6. Shoot the same frame again with",
    );
  });
});
