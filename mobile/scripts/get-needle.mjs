// Downloads Needle's Android engine and model into modules/needle, once, before building the app.
// Needle: https://github.com/cactus-compute/needle (Apache-2.0). Files from Hugging Face.
//   npm run get-needle
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://huggingface.co/Cactus-Compute/needle3";
const MODULE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "modules",
  "needle",
);
const FILES = [
  [
    "android-arm64/libneedle.a",
    join(MODULE, "android", "libs", "arm64-v8a", "libneedle.a"),
  ],
  [
    "android-arm64/needle.h",
    join(MODULE, "android", "libs", "arm64-v8a", "needle.h"),
  ],
  ["needle3.cact", join(MODULE, "assets", "needle3.cact")],
];

for (const [from, to] of FILES) {
  process.stdout.write(`Getting ${from}… `);
  const response = await fetch(`${REPO}/resolve/main/${from}`);
  if (!response.ok) {
    console.error(
      `failed (${response.status}). Check ${REPO}/tree/main and try again.`,
    );
    process.exit(1);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, bytes);
  console.log(`${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
}
console.log(
  "Done. Build the phone app as usual and the Phone Bot will work offline.",
);
