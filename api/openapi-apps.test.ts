import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The apps' operations name the app directory three ways: what listAppDirectory answers, what
 * createApp takes back, and the app it becomes. These hold the spec to that, so an entry a person
 * picks can always be added as it was listed, and a screen can always open the directory page for
 * the service app-setup names.
 */

type Schema = {
  enum?: (string | null)[];
  const?: string;
  pattern?: string;
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  $ref?: string;
  discriminator?: { propertyName: string; mapping: Record<string, string> };
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as { components: { schemas: Record<string, Schema> } };
const schemas = spec.components.schemas;

const resolve = (schema: Schema | undefined): Schema | undefined =>
  schema?.$ref
    ? schemas[schema.$ref.replace("#/components/schemas/", "")]
    : schema;

const directorySources = schemas.AppDirectorySource?.enum ?? [];

test("each kind of directory entry is one the list can be narrowed to", () => {
  const entry = schemas.AppDirectoryEntry;
  expect(entry?.discriminator?.propertyName).toBe("source");
  expect(Object.keys(entry?.discriminator?.mapping ?? {}).sort()).toEqual(
    [...directorySources].sort() as string[],
  );
  for (const [source, ref] of Object.entries(
    entry?.discriminator?.mapping ?? {},
  )) {
    expect(resolve({ $ref: ref })?.properties?.source?.const).toBe(source);
  }
});

test("an entry added becomes an app of the same source", () => {
  const appSources = schemas.AppSource?.enum ?? [];
  for (const source of directorySources) expect(appSources).toContain(source);
});

test("createApp takes back the id of every kind of directory entry", () => {
  const pattern =
    schemas.AddAppFromDirectory?.properties?.directoryEntryId?.pattern;
  expect(pattern).toBeDefined();
  for (const source of directorySources)
    expect(new RegExp(pattern as string).test(`${source}:linear`)).toBe(true);
  expect(new RegExp(pattern as string).test("linear")).toBe(false);
});

test("every directory service app-setup can name has its page in both editions", () => {
  const providers = (
    schemas.AppSetup?.properties?.directoryProvider?.enum ?? []
  ).filter((provider): provider is string => provider !== null);
  expect(providers.length).toBeGreaterThan(0);
  const routes = join(import.meta.dir, "../app/src/routes/_authed");
  for (const provider of providers) {
    // The team edition's page under Admin, and the personal edition's under Connections.
    expect(existsSync(join(routes, `admin/plugins/${provider}.tsx`))).toBe(
      true,
    );
    expect(
      existsSync(join(routes, `_app/connections.browse.${provider}.tsx`)),
    ).toBe(true);
  }
});
