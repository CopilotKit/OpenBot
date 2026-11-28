import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { pickAggregators } from "./handlers";

const GENERATED = join(import.meta.dir, "../../src/lib/api/generated");

describe("pickAggregators", () => {
  test("calls each aggregator and leaves out answer bodies and single handlers", () => {
    const one = http.get("*/api/one", () => HttpResponse.json({}));
    const two = http.get("*/api/two", () => HttpResponse.json({}));
    let called = 0;
    const handlers = pickAggregators({
      "./a/a.msw.ts": {
        getThingsMock: () => [one, two],
        getListThingsResponseMock: () => {
          called++;
          return [one];
        },
        getListThingsMockHandler: () => {
          called++;
          return [one];
        },
        getNotAFunctionMock: [one],
        helper: () => [one],
      },
    });
    expect(handlers).toEqual([one, two]);
    expect(called).toBe(0);
  });

  test("gives at least one handler for each generated tag", async () => {
    const tags = readdirSync(GENERATED, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name !== "model",
    );
    let files = 0;
    for (const tag of tags) {
      const names = readdirSync(join(GENERATED, tag.name)).filter((name) =>
        name.endsWith(".msw.ts"),
      );
      for (const name of names) {
        files++;
        const path = join(GENERATED, tag.name, name);
        const module = (await import(path)) as Record<string, unknown>;
        const handlers = pickAggregators({ [path]: module });
        // The path is in the object, so a failure names the file.
        expect({ path, some: handlers.length > 0 }).toEqual({
          path,
          some: true,
        });
      }
    }
    expect(files).toBeGreaterThan(40);
  });
});
