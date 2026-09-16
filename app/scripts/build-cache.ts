import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = ".openbot-build-cache.json";

export type BuildCachePaths = {
  rootDir: string;
  appDir: string;
};

type BuildCacheEnv = Record<string, string | undefined>;

type BuildCacheManifest = {
  version: number;
  key: string;
};

type InputFile = {
  path: string;
  absolutePath: string;
};

const sourceExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

export function buildCacheManifestPath({ appDir }: BuildCachePaths): string {
  return join(appDir, "dist", MANIFEST_NAME);
}

function slashPath(path: string): string {
  return path.split(sep).join("/");
}

function hasSourceExtension(path: string): boolean {
  const name = basename(path);
  if (name === "bun.lock") return true;
  const dot = name.lastIndexOf(".");
  return dot >= 0 && sourceExtensions.has(name.slice(dot));
}

async function existingFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function versionFromPackageJson(json: unknown): string {
  if (
    json &&
    typeof json === "object" &&
    "version" in json &&
    typeof json.version === "string"
  ) {
    return json.version;
  }
  return "";
}

async function collectFiles(
  base: string,
  options: {
    prefix: string;
    include: (path: string, info: Stats) => boolean;
    skipDirectory?: (path: string) => boolean;
  },
): Promise<InputFile[]> {
  const files: InputFile[] = [];

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!options.skipDirectory?.(absolutePath)) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolutePath);
      if (!options.include(absolutePath, info)) continue;
      files.push({
        path: `${options.prefix}/${slashPath(relative(base, absolutePath))}`,
        absolutePath,
      });
    }
  }

  try {
    await visit(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files;
}

function tenantPackageDir(rootDir: string, env: BuildCacheEnv): string {
  const configured = env.TENANT_PACKAGE_DIR;
  if (!configured) return join(rootDir, "examples", "fintech");
  return resolve(rootDir, "server", configured);
}

function viteEnvironment(env: BuildCacheEnv): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      (key === "BUN_ENV" ||
        key === "MODE" ||
        key === "NODE_ENV" ||
        key === "TENANT_PACKAGE_DIR" ||
        key.startsWith("VITE_"))
    ) {
      values[key] = value;
    }
  }
  return values;
}

async function collectBuildInputs(
  { rootDir, appDir }: BuildCachePaths,
  env: BuildCacheEnv,
): Promise<InputFile[]> {
  const resolvedRoot = resolve(rootDir);
  const resolvedApp = resolve(appDir);
  const tenantDir = tenantPackageDir(resolvedRoot, env);

  const explicit = [
    join(resolvedRoot, "bun.lock"),
    join(resolvedRoot, "package.json"),
    join(resolvedApp, "package.json"),
    join(resolvedApp, "vite.config.ts"),
    join(resolvedApp, "index.html"),
  ];
  const explicitFiles = (
    await Promise.all(
      explicit.map(async (absolutePath) =>
        (await existingFile(absolutePath))
          ? {
              path: slashPath(relative(resolvedRoot, absolutePath)),
              absolutePath,
            }
          : null,
      ),
    )
  ).filter((file): file is InputFile => file !== null);

  const sourceFiles = await collectFiles(join(resolvedApp, "src"), {
    prefix: "app/src",
    include: (path) => hasSourceExtension(path),
    skipDirectory: (path) => basename(path) === "node_modules",
  });
  const tenantFiles = await collectFiles(tenantDir, {
    prefix: `tenant/${slashPath(relative(resolvedRoot, tenantDir))}`,
    include: (path) => hasSourceExtension(path),
    skipDirectory: (path) => basename(path) === "node_modules",
  });

  return [...explicitFiles, ...sourceFiles, ...tenantFiles].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
}

export async function buildCacheKey(
  paths: BuildCachePaths,
  env: BuildCacheEnv,
): Promise<string> {
  const hash = createHash("sha256");
  const rootPackage = await readJson(join(paths.rootDir, "package.json")).catch(
    () => null,
  );
  const appPackage = await readJson(join(paths.appDir, "package.json")).catch(
    () => null,
  );

  hash.update(
    JSON.stringify({
      manifestVersion: MANIFEST_VERSION,
      rootVersion: versionFromPackageJson(rootPackage),
      appVersion: versionFromPackageJson(appPackage),
      env: viteEnvironment(env),
    }),
  );

  for (const input of await collectBuildInputs(paths, env)) {
    hash.update("\0");
    hash.update(input.path);
    hash.update("\0");
    hash.update(await readFile(input.absolutePath));
  }

  return hash.digest("hex");
}

export async function readBuildCacheManifest(
  paths: BuildCachePaths,
): Promise<BuildCacheManifest | null> {
  try {
    const raw = JSON.parse(
      await readFile(buildCacheManifestPath(paths), "utf8"),
    );
    if (
      raw &&
      typeof raw === "object" &&
      raw.version === MANIFEST_VERSION &&
      typeof raw.key === "string"
    ) {
      return raw;
    }
    return null;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    ) {
      return null;
    }
    throw error;
  }
}

export async function writeBuildCacheManifest(
  paths: BuildCachePaths,
  env: BuildCacheEnv,
): Promise<void> {
  await writeFile(
    buildCacheManifestPath(paths),
    `${JSON.stringify({
      version: MANIFEST_VERSION,
      key: await buildCacheKey(paths, env),
    })}\n`,
  );
}

export async function isReusableBuild(
  paths: BuildCachePaths,
  env: BuildCacheEnv,
): Promise<boolean> {
  if (!(await existingFile(join(paths.appDir, "dist", "index.html")))) {
    return false;
  }
  const manifest = await readBuildCacheManifest(paths);
  return manifest?.key === (await buildCacheKey(paths, env));
}
