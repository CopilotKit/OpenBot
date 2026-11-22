import { describe, expect, test } from "bun:test";
import { componentChain, formatChain } from "./componentChain";

type FakeFiber = {
  type: unknown;
  return: FakeFiber | null;
  _debugOwner?: FakeFiber;
  _debugStack?: Error;
  _debugSource?: unknown;
};

function named(name: string): () => null {
  const fn = () => null;
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}

function stackError(stack: string): Error {
  const error = new Error("x");
  error.stack = stack;
  return error;
}

function dom(fiber: FakeFiber | null, parent?: Element): Element {
  const el: Record<string, unknown> = { parentElement: parent ?? null };
  if (fiber) el["__reactFiber$abc"] = fiber;
  return el as unknown as Element;
}

function chainOf(...types: unknown[]): FakeFiber {
  // types are listed innermost first.
  let outer: FakeFiber | null = null;
  for (const type of [...types].reverse()) outer = { type, return: outer };
  return outer as FakeFiber;
}

describe("componentChain", () => {
  test("returns [] without a fiber", () => {
    expect(componentChain(dom(null))).toEqual([]);
  });

  test("lists names innermost first and skips host nodes, internals and anonymous", () => {
    const fiber = chainOf(
      "div",
      named("StepRow"),
      named("Fragment"),
      named("_Hidden"),
      () => null,
      named("SetupProgress"),
      { $$typeof: 1, type: named("App") },
    );
    expect(componentChain(dom(fiber)).map((c) => c.name)).toEqual([
      "StepRow",
      "SetupProgress",
      "App",
    ]);
  });

  test("reads memo and forwardRef wrappers", () => {
    const fiber = chainOf(
      { type: named("Memoed") },
      { render: named("Forwarded") },
    );
    expect(componentChain(dom(fiber)).map((c) => c.name)).toEqual([
      "Memoed",
      "Forwarded",
    ]);
  });

  test("prefers displayName", () => {
    const fn = named("inner");
    (fn as unknown as { displayName: string }).displayName = "Shown";
    expect(componentChain(dom(chainOf(fn))).map((c) => c.name)).toEqual([
      "Shown",
    ]);
  });

  test("uses the nearest ancestor that has a fiber", () => {
    const parent = dom(chainOf(named("Outer")));
    const child = dom(null, parent);
    expect(componentChain(child).map((c) => c.name)).toEqual(["Outer"]);
  });

  test("drops consecutive duplicates and respects max", () => {
    const fiber = chainOf(
      named("A"),
      named("A"),
      named("B"),
      named("C"),
      named("D"),
    );
    expect(componentChain(dom(fiber)).map((c) => c.name)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(componentChain(dom(fiber), 2).map((c) => c.name)).toEqual([
      "A",
      "B",
    ]);
  });

  test("parses a Vite URL from _debugStack", () => {
    const fiber = chainOf(named("StepRow"));
    fiber._debugStack = stackError(
      "Error: react-stack-top-frame\n    at jsxDEV (http://localhost:3021/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:200:5)\n    at SetupProgress (http://localhost:3021/src/SetupProgress.tsx?t=123:45:12)",
    );
    // The line is in the served module, so it stays a served position until a source map reads it.
    expect(componentChain(dom(fiber))).toEqual([
      {
        name: "StepRow",
        file: "desktop/src/SetupProgress.tsx",
        at: {
          url: "http://localhost:3021/src/SetupProgress.tsx?t=123",
          line: 45,
          column: 12,
        },
      },
    ]);
  });

  test("names where each component draws the path, from the owners", () => {
    // span (made by StepRow) › StepRow (made by SetupProgress) › SetupProgress
    const setup: FakeFiber = { type: named("SetupProgress"), return: null };
    const row: FakeFiber = {
      type: named("StepRow"),
      return: setup,
      _debugOwner: setup,
      _debugStack: stackError(
        "Error\n    at SetupProgress (http://localhost:3021/src/SetupProgress.tsx:20:5)",
      ),
    };
    const span: FakeFiber = {
      type: "span",
      return: row,
      _debugOwner: row,
      _debugStack: stackError(
        "Error\n    at StepRow (http://localhost:3021/src/StepRow.tsx:9:7)",
      ),
    };
    const chain = componentChain(dom(span));
    expect(chain.map((c) => [c.name, c.file, c.at?.line])).toEqual([
      ["StepRow", "desktop/src/StepRow.tsx", 9],
      ["SetupProgress", "desktop/src/SetupProgress.tsx", 20],
    ]);
  });

  test("names app files served under /__app/src/", () => {
    const fiber = chainOf(named("UsageData"));
    fiber._debugStack = stackError(
      "Error\n    at UsageData (http://localhost:3021/__app/src/components/settings/usage-data.tsx?t=1:40:7)",
    );
    const [info] = componentChain(dom(fiber));
    expect(info?.file).toBe("app/src/components/settings/usage-data.tsx");
    expect(info?.at?.line).toBe(40);
  });

  test("skips other files served under /__app/", () => {
    const fiber = chainOf(named("Boot"));
    fiber._debugStack = stackError(
      "Error\n    at boot (/__app/workbench/frameBoot.ts:3:1)",
    );
    expect(componentChain(dom(fiber))).toEqual([{ name: "Boot" }]);
  });

  test("still names desktop files under /src/", () => {
    const fiber = chainOf(named("App"));
    fiber._debugStack = stackError("Error\n    at App (/src/App.tsx:9:2)");
    const [info] = componentChain(dom(fiber));
    expect(info?.file).toBe("desktop/src/App.tsx");
    expect(info?.at?.line).toBe(9);
  });

  test("accepts _debugSource", () => {
    const fiber = chainOf(named("StepRow"));
    fiber._debugSource = {
      fileName: "/Users/x/repo/desktop/src/StepRow.tsx",
      lineNumber: 7,
    };
    expect(componentChain(dom(fiber))).toEqual([
      { name: "StepRow", file: "desktop/src/StepRow.tsx", line: 7 },
    ]);
  });

  test("leaves file undefined when nothing matches", () => {
    const fiber = chainOf(named("StepRow"));
    fiber._debugStack = stackError(
      "Error\n    at x (http://localhost:3021/node_modules/foo.js:1:1)",
    );
    expect(componentChain(dom(fiber))).toEqual([{ name: "StepRow" }]);
  });

  test("never throws", () => {
    const bad = {
      get type(): unknown {
        throw new Error("boom");
      },
      return: null,
    };
    expect(componentChain(dom(bad as unknown as FakeFiber))).toEqual([]);
  });
});

describe("formatChain", () => {
  test("joins names and adds the first file", () => {
    expect(
      formatChain([
        { name: "StepRow" },
        {
          name: "SetupProgress",
          file: "desktop/src/SetupProgress.tsx",
          line: 12,
        },
        { name: "App", file: "desktop/src/App.tsx", line: 3 },
      ]),
    ).toBe("StepRow › SetupProgress › App · desktop/src/SetupProgress.tsx:12");
  });

  test("omits the file part without a file", () => {
    expect(formatChain([{ name: "A" }, { name: "B" }])).toBe("A › B");
  });
});
