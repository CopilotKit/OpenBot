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

function rootManifest() {
  return JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  ) as { workspaces: string[]; scripts: Record<string, string> };
}

function packagesStartedBy(script: string, workspaces: string[]): string[] {
  const filters = [
    ...script.matchAll(/--filter\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
  return workspaces.filter((workspace) =>
    filters.some((filter) => filter === "*" || filter === workspace),
  );
}

describe("OpenBot workspace", () => {
  test("defines the app, server, and worker packages", () => {
    const manifest = rootManifest();

    expect(manifest.workspaces).toEqual(["app", "server", "worker"]);

    for (const packageName of manifest.workspaces) {
      expect(existsSync(join(repositoryRoot, packageName))).toBe(true);
      expect(packageManifest(packageName).name).toBe(packageName);
    }
  });

  test("dev starts the app and the server, and not the routines worker", () => {
    const manifest = rootManifest();

    expect(
      packagesStartedBy(manifest.scripts.dev, manifest.workspaces),
    ).toEqual(["app", "server"]);
  });

  test("build still covers every workspace, including the worker", () => {
    const manifest = rootManifest();

    expect(
      packagesStartedBy(manifest.scripts.build, manifest.workspaces),
    ).toEqual(manifest.workspaces);
  });

  test("scripts/start.sh is what starts the routines worker", () => {
    const startScript = readFileSync(
      join(repositoryRoot, "scripts", "start.sh"),
      "utf8",
    );

    expect(startScript).toContain("bun worker/src/index.ts");
    expect(startScript).toContain("WORKER_SHARED_SECRET=");
  });
});
