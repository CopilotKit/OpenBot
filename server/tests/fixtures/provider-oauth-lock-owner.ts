import { mkdir } from "node:fs/promises";
import { lockProviderCredentials } from "../../src/provider-oauth-lock";

console.error("diag bun-start", Date.now());
const file = process.argv[2];
if (!file) throw new Error("A credential path is required.");
if (process.argv[3] === "legacy") {
  await mkdir(`${file}.lock`, { mode: 0o700 });
  console.log("locked");
  await Bun.stdin.text();
} else {
  const unlock = await lockProviderCredentials(file);
  try {
    console.error("diag bun-locked", Date.now());
    console.log("locked");
    await Bun.stdin.text();
  } finally {
    await unlock();
  }
}
