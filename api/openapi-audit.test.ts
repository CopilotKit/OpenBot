import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  AUDIT_EFFECTS,
  AUDIT_FILTER_KEYS,
  AUDIT_INTENTS,
} from "../shared/audit-filters";

/**
 * The audit trail's operations share one set of filters three ways: listing the trail, exporting it
 * as a file, and the filters a question becomes. These hold the spec to that, so the file never
 * holds different events from the list a person exported it from, and a question's filters can
 * always be sent to the list as they are.
 */

type Parameter = { $ref?: string; name?: string; in?: string };
type Operation = { parameters?: Parameter[] };
type Schema = {
  properties?: Record<string, unknown>;
  enum?: string[];
};
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    parameters: Record<string, Parameter>;
    schemas: Record<string, Schema>;
  };
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as Spec;
const AUDIT = "/api/v2/organizations/{organizationId}/audit-events";

/** An operation's query parameters, by name. */
function queryOf(path: string, method: string): string[] {
  const operation = spec.paths[path]?.[method];
  expect(operation).toBeDefined();
  return (operation?.parameters ?? [])
    .map((parameter) =>
      parameter.$ref
        ? spec.components.parameters[parameter.$ref.split("/").at(-1) ?? ""]
        : parameter,
    )
    .filter((parameter) => parameter?.in === "query")
    .map((parameter) => String(parameter?.name));
}

test("the export takes exactly the list's filters, without its paging", () => {
  const list = queryOf(AUDIT, "get");
  const exported = queryOf(`${AUDIT}/export`, "get");

  expect(list).toContain("cursor");
  expect(list).toContain("limit");
  expect([...exported].sort()).toEqual(
    list.filter((name) => name !== "cursor" && name !== "limit").sort(),
  );
});

test("a question's filters are the shared filters, each one a parameter of the list", () => {
  const filters = spec.components.schemas.AuditFilters?.properties ?? {};
  const list = queryOf(AUDIT, "get");

  expect(Object.keys(filters).sort()).toEqual([...AUDIT_FILTER_KEYS].sort());
  for (const key of AUDIT_FILTER_KEYS) expect(list).toContain(key);
});

test("the effects and intents a filter names are the shared ones", () => {
  expect(spec.components.schemas.AuditEffect?.enum).toEqual([...AUDIT_EFFECTS]);
  expect(spec.components.schemas.AuditIntent?.enum).toEqual([...AUDIT_INTENTS]);
});
