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
 * none. A Bot made with its own address names one (CreateBotRequest), and so does an agent added to
 * the organization's list (BotAgentHarness).
 */
const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as {
  components: {
    schemas: Record<
      string,
      { enum?: string[]; properties?: Record<string, { enum?: string[] }> }
    >;
  };
};
const accepted = HARNESSES.filter((entry) => declaredHarness(entry.id)).map(
  (entry) => entry.id,
);

test("the spec's harness enum is exactly the frameworks the server accepts", () => {
  const harness = spec.components.schemas.CreateBotRequest?.properties?.harness;
  expect(accepted.length).toBeGreaterThan(0);
  expect([...(harness?.enum ?? [])].sort()).toEqual(["", ...accepted].sort());
});

test("an agent's harness enum is the same list", () => {
  const harness = spec.components.schemas.BotAgentHarness;
  expect([...(harness?.enum ?? [])].sort()).toEqual(["", ...accepted].sort());
});
