import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "./src/generate";

// `bun run tokens:generate`: writes tokens/src/scheme.ts into every copy listed in tokens/src/targets.ts.

const root = join(import.meta.dir, "..");
for (const [file, text] of generate(root)) {
  const path = join(root, file);
  let before = "";
  try {
    before = readFileSync(path, "utf8");
  } catch {}
  if (before === text) continue;
  writeFileSync(path, text);
  console.log(`wrote ${file}`);
}
