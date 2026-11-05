import { fileURLToPath } from "node:url";

/** Build signed native updater artifacts. Publisher secrets travel only in the inherited env. */
const required = [
  "OPENBOT_SHELL_UPDATE_PUBLIC_KEY",
  "OPENBOT_SHELL_UPDATE_ENDPOINT",
  "TAURI_SIGNING_PRIVATE_KEY",
];
for (const key of required) {
  if (!process.env[key]?.trim())
    throw new Error(`Missing required shell release configuration: ${key}`);
}
const endpoint = new URL(process.env.OPENBOT_SHELL_UPDATE_ENDPOINT ?? "");
if (
  endpoint.protocol !== "https:" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.hash
) {
  throw new Error(
    "The native shell update endpoint must use HTTPS without credentials or fragment",
  );
}
const result = Bun.spawnSync(
  [
    "bun",
    "run",
    "tauri",
    "build",
    "--features",
    "shell-updater",
    "--config",
    "src-tauri/tauri.updater.conf.json",
    ...process.argv.slice(2),
    // The bundler reads this before Rust's runtime plugin setup can supply it.
    "--config",
    JSON.stringify({
      plugins: {
        updater: {
          pubkey: process.env.OPENBOT_SHELL_UPDATE_PUBLIC_KEY?.trim(),
          endpoints: [endpoint.href],
        },
      },
    }),
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  },
);
if (result.exitCode !== 0)
  throw new Error(`Signed native shell build failed (${result.exitCode})`);
