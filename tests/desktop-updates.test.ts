import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellUpdateManifest } from "../desktop/scripts/shell-update-manifest";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
test("signed shell publication refuses insecure artifacts and retains distributor identity", async () => {
  const distribution = {
    id: "acme.openbot",
    repository: "acme/openbot",
    channel: "stable",
  };
  const artifact = {
    target: "darwin-aarch64",
    url: "https://updates.example/OpenBot.app.tar.gz",
    signature: "synthetic signature",
  };
  expect(
    shellUpdateManifest("0.3.0", [artifact], distribution).distribution,
  ).toEqual(distribution);
  expect(() =>
    shellUpdateManifest(
      "0.3.0",
      [{ ...artifact, url: "http://updates.example/unsigned" }],
      distribution,
    ),
  ).toThrow();
  expect(() =>
    shellUpdateManifest(
      "0.3.0",
      [{ ...artifact, signature: "" }],
      distribution,
    ),
  ).toThrow();
});

test("shell publication CLI writes reviewable metadata and refuses to replace it", () => {
  const root = mkdtempSync(join(tmpdir(), "openbot-shell-manifest-"));
  temporary.push(root);
  const signature = join(root, "artifact.sig"),
    output = join(root, "latest.json");
  writeFileSync(signature, "synthetic signature");
  const command = [
    process.execPath,
    join(import.meta.dir, "../desktop/scripts/shell-update-manifest.ts"),
    "--version",
    "0.3.0",
    "--target",
    "darwin-aarch64",
    "--url",
    "https://updates.example/OpenBot.app.tar.gz",
    "--signature",
    signature,
    "--output",
    output,
  ];
  const env = {
    ...process.env,
    OPENBOT_DISTRIBUTION_ID: "acme.openbot",
    OPENBOT_RELEASE_REPOSITORY: "acme/openbot",
    OPENBOT_RELEASE_CHANNEL: "stable",
  };
  const first = Bun.spawnSync(command, { env, stdout: "pipe", stderr: "pipe" });
  expect(first.exitCode).toBe(0);
  const accepted = readFileSync(output, "utf8");
  expect(JSON.parse(accepted).distribution.repository).toBe("acme/openbot");
  const repeated = Bun.spawnSync(command, {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(repeated.exitCode).not.toBe(0);
  expect(readFileSync(output, "utf8")).toBe(accepted);
});
test("shell build entrypoint refuses absent trust before native work without exposing signing material", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../desktop/scripts/build-shell-update.ts"),
    ],
    {
      env: {
        ...process.env,
        OPENBOT_SHELL_UPDATE_PUBLIC_KEY: "",
        OPENBOT_SHELL_UPDATE_ENDPOINT: "",
        TAURI_SIGNING_PRIVATE_KEY: "synthetic-private-test-material",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "Missing required shell release configuration",
  );
  expect(result.stderr.toString()).not.toContain(
    "synthetic-private-test-material",
  );
});
