/**
 * Write the server's copy of the standard catalog: what the model is told about each component, as
 * the browser would send it. The server builds every run's catalog from this file, so a Bot is told
 * only what its administrator allowed, in the administrator's words.
 *
 * Run it after an SDK upgrade: `bun run --cwd app export:standard-ui`. app/tests/standard-ui.test.ts
 * fails until the committed file matches the SDK again.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OPENBOT_UI } from "../src/lib/copilot/a2ui";

export const STANDARD_UI_CATALOG_PATH = join(
  import.meta.dir,
  "../../shared/standard-ui-catalog.json",
);

export function standardUiCatalogFile() {
  return `${JSON.stringify({ catalogId: OPENBOT_UI.id, components: OPENBOT_UI.manifestComponents }, null, 2)}\n`;
}

if (import.meta.main) {
  await writeFile(STANDARD_UI_CATALOG_PATH, standardUiCatalogFile());
  console.log(`Wrote ${STANDARD_UI_CATALOG_PATH}`);
}
