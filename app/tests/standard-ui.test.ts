import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  STANDARD_UI_CATALOG_ID,
  STANDARD_UI_FAMILIES,
} from "@openbot/shared/standard-ui";
import { OPENBOT_UI } from "@/lib/copilot/a2ui";
import {
  STANDARD_UI_CATALOG_PATH,
  standardUiCatalogFile,
} from "../scripts/export-standard-ui-catalog";

test("the server's copy of the catalog is the one the SDK sends", async () => {
  // After an SDK upgrade: bun run --cwd app export:standard-ui
  // Compared as data, so the formatter may lay the file out its own way.
  expect(JSON.parse(await readFile(STANDARD_UI_CATALOG_PATH, "utf8"))).toEqual(
    JSON.parse(standardUiCatalogFile()),
  );
  expect(OPENBOT_UI.id).toBe(STANDARD_UI_CATALOG_ID);
});

test("every component the browser can draw belongs to exactly one family", () => {
  const members = STANDARD_UI_FAMILIES.flatMap((family) => family.members);
  expect(new Set(members).size).toBe(members.length);
  expect([...members].sort()).toEqual(
    Object.keys(OPENBOT_UI.manifestComponents).sort(),
  );
});
