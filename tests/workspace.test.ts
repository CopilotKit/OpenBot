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
  test("defines the app, server, worker, shared, toolkit and extension packages", () => {
    const manifest = rootManifest();
    const names: Record<string, string> = {
      app: "app",
      server: "server",
      worker: "worker",
      shared: "@openbot/shared",
      toolkit: "@openbot/toolkit",
      extension: "@openbot/recorder-extension",
    };

    expect(manifest.workspaces).toEqual(Object.keys(names));

    for (const workspace of manifest.workspaces) {
      expect(existsSync(join(repositoryRoot, workspace))).toBe(true);
      expect(packageManifest(workspace).name).toBe(names[workspace] ?? "");
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
});
