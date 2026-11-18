import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Two things the schedules operations promise by their shape, read from the bundled spec.
 *
 * A trigger's secret is answered by exactly the operations that make, replace or read one, and no
 * other answer in the area has a place to put it. And what a run said is kept for a goal's run and
 * not for a routine's, whose reply is in its conversation: a client generated from the spec must
 * not find a field that is never filled.
 */

type Schema = {
  $ref?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
};
type Operation = {
  operationId: string;
  tags?: string[];
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

const TAGS = ["Routines", "Check-ins", "Goals", "Follow-ups"];
const operations = Object.values(spec.paths)
  .flatMap((item) => Object.values(item))
  .filter(
    (value): value is Operation =>
      typeof value === "object" &&
      value !== null &&
      "operationId" in value &&
      (value.tags ?? []).some((tag) => TAGS.includes(tag)),
  );

/** Every property name an answer can hold, through references, arrays and compositions. */
function names(schema: Schema | undefined, seen = new Set<string>()): string[] {
  if (!schema) return [];
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (seen.has(name)) return [];
    seen.add(name);
    return names(spec.components.schemas[name], seen);
  }
  return [
    ...Object.entries(schema.properties ?? {}).flatMap(([name, property]) => [
      name,
      ...names(property, seen),
    ]),
    ...names(schema.items, seen),
    ...[
      ...(schema.oneOf ?? []),
      ...(schema.anyOf ?? []),
      ...(schema.allOf ?? []),
    ].flatMap((part) => names(part, seen)),
  ];
}

function answered(operation: Operation): string[] {
  return Object.entries(operation.responses)
    .filter(([status]) => /^2/.test(status))
    .flatMap(([, response]) =>
      names(response.content?.["application/json"]?.schema),
    );
}

test("the area has its 38 operations", () => {
  expect(operations).toHaveLength(38);
});

test("only the operations that make, replace or read a trigger's secret answer one", () => {
  expect(
    operations
      .filter((operation) => answered(operation).includes("secret"))
      .map((operation) => operation.operationId)
      .sort(),
  ).toEqual([
    "createGoalTrigger",
    "getGoalTriggerSecret",
    "replaceGoalTriggerSecret",
  ]);
});

test("a goal's run says what the Bot said, and a routine's run has no place for it", () => {
  const run = (id: string) =>
    answered(
      operations.find((operation) => operation.operationId === id) as Operation,
    );
  expect(run("listGoalRuns")).toContain("replyText");
  expect(run("listRoutineRuns")).not.toContain("replyText");
});

test("answers speak in the product's nouns, never storage's", () => {
  for (const operation of operations)
    for (const stored of [
      "agentId",
      "channelId",
      "settingId",
      "responsibilityId",
      "ownerUserId",
    ])
      expect(answered(operation)).not.toContain(stored);
});
