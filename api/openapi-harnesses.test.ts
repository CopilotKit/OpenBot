import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { declaredHarness, HARNESSES } from "../shared/harnesses";

/**
 * The API names the frameworks a person may declare for an agent they run themselves, and the server
 * checks every create against the harness catalogue. The two are one list: a framework added to the
 * catalogue without the spec is refused by every generated client before it is sent, and one left in
 * the spec after the catalogue drops it is refused by the server. Empty is how a create says it named
 * none.
 */
test("the spec's harness enum is exactly the frameworks the server accepts", () => {
  const spec = parse(
    readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
  ) as {
    components: {
      schemas: Record<
        string,
        { allOf?: { properties?: Record<string, { enum?: string[] }> }[] }
      >;
    };
  };
  const harness = spec.components.schemas.CreateBotRequest?.allOf
    ?.map((part) => part.properties?.harness)
    .find(Boolean);
  const accepted = HARNESSES.filter((entry) => declaredHarness(entry.id)).map(
    (entry) => entry.id,
  );

  expect(accepted.length).toBeGreaterThan(0);
  expect([...(harness?.enum ?? [])].sort()).toEqual(["", ...accepted].sort());
});
