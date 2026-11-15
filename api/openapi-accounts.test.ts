import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_USER_PREFERENCES, SKIN_IDS } from "../shared/user-preferences";

/**
 * The parts of the accounts API that are copies of a list kept somewhere else, so the copy can't drift
 * from what the server stores and the apps draw.
 */

type Schema = {
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  maxLength?: number;
  oneOf?: Schema[];
  $ref?: string;
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as { components: { schemas: Record<string, Schema> } };
const schemas = spec.components.schemas;

const resolve = (schema: Schema | undefined): Schema | undefined =>
  schema?.$ref
    ? schemas[schema.$ref.replace("#/components/schemas/", "")]
    : schema;

test("a skin is one OpenBot ships, and nothing else", () => {
  expect(schemas.SkinId?.enum).toEqual([...SKIN_IDS]);
});

test("the preferences are the ones a person has, each with a default", () => {
  const preferences = schemas.Preferences;
  // Every preference the server answers with a default for, and the one it sets itself.
  expect(Object.keys(preferences?.properties ?? {}).sort()).toEqual(
    [...Object.keys(DEFAULT_USER_PREFERENCES), "starterTourChannelId"].sort(),
  );
  expect([...(preferences?.required ?? [])].sort()).toEqual(
    Object.keys(DEFAULT_USER_PREFERENCES).sort(),
  );
  // A change names any of them but the one the server sets.
  expect(
    Object.keys(schemas.UpdatePreferencesRequest?.properties ?? {}).sort(),
  ).toEqual(Object.keys(DEFAULT_USER_PREFERENCES).sort());
});

test("narration is on or off once chosen, and null until then", () => {
  const narration = schemas.Preferences?.properties?.narration;
  expect(resolve(narration?.oneOf?.[0])?.enum).toEqual(["on", "off"]);
  expect(narration?.oneOf?.[1]).toEqual({ type: "null" } as Schema);
  expect(
    resolve(schemas.UpdatePreferencesRequest?.properties?.narration)?.enum,
  ).toEqual(["on", "off"]);
});

test("standing instructions are held to the limit the settings page counts down from", async () => {
  const { INSTRUCTIONS_LIMIT } = await import(
    "../app/src/lib/settings/queries"
  );
  expect(
    schemas.StandingInstructions?.properties?.instructions?.maxLength,
  ).toBe(INSTRUCTIONS_LIMIT);
});
