import { describe, expect, test } from "bun:test";
import type { PickedElement } from "./commentPrompt";
import { originalPosition, resolveLines, resolveTarget } from "./sourceLines";

const URL = "http://localhost:3021/src/StepRow.tsx";

// Served line 1 → source line 1, line 2 → 2, line 3 → 4, and on line 4 the code from column 11 → 6.
const MAP = {
  version: 3,
  sources: ["/repo/desktop/src/StepRow.tsx"],
  mappings: "AAAA;AACA;AAEA;AAAA,UAEA",
};

function served(map: object): string {
  const base64 = btoa(JSON.stringify(map));
  return `export const x = 1;\n//# sourceMappingURL=data:application/json;base64,${base64}\n`;
}

describe("originalPosition", () => {
  test("reads the source line for a served line and column", () => {
    expect(originalPosition(MAP, 3, 1)).toEqual({
      source: "/repo/desktop/src/StepRow.tsx",
      line: 4,
    });
    expect(originalPosition(MAP, 4, 5)?.line).toBe(4);
    expect(originalPosition(MAP, 4, 12)?.line).toBe(6);
  });

  test("gives null for a line the map does not have", () => {
    expect(originalPosition(MAP, 9, 1)).toBeNull();
  });
});

describe("resolveLines", () => {
  test("sets the source line and drops the served position", async () => {
    const loads: string[] = [];
    const load = async (url: string) => {
      loads.push(url);
      return served(MAP);
    };
    const chain = await resolveLines(
      [
        {
          name: "StepRow",
          file: "desktop/src/StepRow.tsx",
          at: { url: URL, line: 3, column: 1 },
        },
        {
          name: "Other",
          file: "desktop/src/StepRow.tsx",
          at: { url: URL, line: 4, column: 20 },
        },
      ],
      load,
    );
    expect(chain).toEqual([
      { name: "StepRow", file: "desktop/src/StepRow.tsx", line: 4 },
      { name: "Other", file: "desktop/src/StepRow.tsx", line: 6 },
    ]);
    expect(loads).toEqual([URL]);
  });

  test("keeps the file without a line when the module cannot load or has no map", async () => {
    const info = {
      name: "StepRow",
      file: "desktop/src/StepRow.tsx",
      at: { url: URL, line: 3, column: 1 },
    };
    const failed = await resolveLines([info], async () => {
      throw new Error("404");
    });
    expect(failed).toEqual([
      { name: "StepRow", file: "desktop/src/StepRow.tsx" },
    ]);
    const plain = await resolveLines([info], async () => "export {};");
    expect(plain).toEqual([
      { name: "StepRow", file: "desktop/src/StepRow.tsx" },
    ]);
  });

  test("does not use a map of some other file", async () => {
    const other = { ...MAP, sources: ["/repo/desktop/src/Other.tsx"] };
    const chain = await resolveLines(
      [
        {
          name: "StepRow",
          file: "desktop/src/StepRow.tsx",
          at: { url: URL, line: 3, column: 1 },
        },
      ],
      async () => served(other),
    );
    expect(chain[0]?.line).toBeUndefined();
  });
});

test("resolveTarget resolves every element of an area", async () => {
  const el = (name: string): PickedElement => ({
    label: name,
    box: { x: 0, y: 0, width: 1, height: 1 },
    gaps: { top: null, right: null, bottom: null, left: null },
    offGrid: { x: 0, y: 0 },
    styles: {},
    chain: [
      {
        name,
        file: "desktop/src/StepRow.tsx",
        at: { url: URL, line: 3, column: 1 },
      },
    ],
    text: "",
  });
  const target = await resolveTarget(
    {
      kind: "area",
      area: { x: 0, y: 0, width: 10, height: 10 },
      elements: [el("A"), el("B")],
    },
    async () => served(MAP),
  );
  expect(
    target.kind === "area" && target.elements.map((e) => e.chain[0]?.line),
  ).toEqual([4, 4]);
});
