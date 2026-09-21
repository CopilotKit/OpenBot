import { mkdir } from "node:fs/promises";
import { lockProviderCredentials } from "../../src/provider-oauth-lock";

const file = process.argv[2];
if (!file) throw new Error("A credential path is required.");
if (process.argv[3] === "legacy") {
  await mkdir(`${file}.lock`, { mode: 0o700 });
  console.log("locked");
  await Bun.stdin.text();
} else {
  const unlock = await lockProviderCredentials(file);
  try {
    console.log("locked");
    await Bun.stdin.text();
  } finally {
    await unlock();
  }
}
