import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function packageManifest(path: string) {
  return JSON.parse(
    readFileSync(join(repositoryRoot, path, "package.json"), "utf8"),
  ) as {
    name: string;
  };
}

describe("OpenBot workspace", () => {
  test("defines every package installed by the root workspace", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { workspaces: string[] };

    expect(rootManifest.workspaces).toEqual([
      "app",
      "agent-codex",
      "server",
      "worker",
    ]);

    for (const packageName of rootManifest.workspaces) {
      expect(existsSync(join(repositoryRoot, packageName))).toBe(true);
      expect(packageManifest(packageName).name).toBe(
        packageName === "agent-codex" ? "@openbot/agent-codex" : packageName,
      );
    }
  });
});
