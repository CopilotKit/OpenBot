import { describe, expect, test } from "bun:test";
import { parse, subtract } from "./typecheck-tests";

describe("typecheck-tests script", () => {
  test("strips checkout prefix using POSIX forward slashes", () => {
    const root = "/home/runner/work/OpenBot/OpenBot";
    const output = [
      "server/tests/headless-components.test.ts(8,1): error TS6142: Module '../../app/src/components/gallery/charts' was resolved to '/home/runner/work/OpenBot/OpenBot/app/src/components/gallery/charts.tsx', but '--jsx' is not set.",
    ].join("\n");

    const diagnostics = parse(output, root);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.key).toBe(
      "server/tests/headless-components.test.ts: error TS6142: Module '../../app/src/components/gallery/charts' was resolved to 'app/src/components/gallery/charts.tsx', but '--jsx' is not set.",
    );
  });

  test("strips checkout prefix on Windows when tsc emits forward slashes in TS6142 message", () => {
    const root = "D:\\openbot";
    const output = [
      "server/tests/headless-components.test.ts(8,1): error TS6142: Module '../../app/src/components/gallery/charts' was resolved to 'D:/openbot/app/src/components/gallery/charts.tsx', but '--jsx' is not set.",
    ].join("\n");

    const diagnostics = parse(output, root);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.key).toBe(
      "server/tests/headless-components.test.ts: error TS6142: Module '../../app/src/components/gallery/charts' was resolved to 'app/src/components/gallery/charts.tsx', but '--jsx' is not set.",
    );
  });

  test("strips checkout prefix on Windows when tsc emits backslashes", () => {
    const root = "D:\\openbot";
    const output = [
      "server/tests/headless-components.test.ts(8,1): error TS6142: Module '../../app/src/components/gallery/charts' was resolved to 'D:\\openbot\\app\\src\\components\\gallery\\charts.tsx', but '--jsx' is not set.",
    ].join("\n");

    const diagnostics = parse(output, root);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.key).toBe(
      "server/tests/headless-components.test.ts: error TS6142: Module '../../app/src/components/gallery/charts' was resolved to 'app\\src\\components\\gallery\\charts.tsx', but '--jsx' is not set.",
    );
  });

  test("subtract treats errors as a multiset", () => {
    const from = ["errA", "errB", "errB", "errC"];
    const remove = ["errB", "errC"];
    expect(subtract(from, remove)).toEqual(["errA", "errB"]);
  });
});
