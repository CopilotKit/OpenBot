import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCacheManifestPath,
  isReusableBuild,
  readBuildCacheManifest,
  writeBuildCacheManifest,
} from "../scripts/build-cache";

const serveOrBuildScript = new URL(
  "../scripts/serve-or-build.ts",
  import.meta.url,
);
const serveOrBuildScriptPath = fileURLToPath(serveOrBuildScript);

async function withProject(
  callback: (paths: { rootDir: string; appDir: string }) => Promise<void>,
) {
  const rootDir = await mkdtemp(join(tmpdir(), "openbot-build-cache-"));
  const appDir = join(rootDir, "app");
  try {
    await mkdir(join(appDir, "src/lib/generated"), { recursive: true });
    await mkdir(join(appDir, "dist"), { recursive: true });
    await mkdir(join(rootDir, "examples/brand"), { recursive: true });
    await mkdir(join(rootDir, "shared"), { recursive: true });
    await writeFile(join(rootDir, "package.json"), '{"version":"1.2.3"}\n');
    await writeFile(join(rootDir, "bun.lock"), "lock-a\n");
    await writeFile(join(appDir, "package.json"), '{"version":"0.0.0"}\n');
    await writeFile(join(appDir, "vite.config.ts"), "export default {}\n");
    await writeFile(join(appDir, "index.html"), '<div id="root"></div>\n');
    await writeFile(join(appDir, "src/main.tsx"), "console.log('a')\n");
    await writeFile(
      join(appDir, "src/lib/generated/application-config.ts"),
      "export const appConfig = { brand: { tenantId: 'a' } };\n",
    );
    await writeFile(join(rootDir, "examples/brand/brand.yaml"), "name: A\n");
    await writeFile(
      join(rootDir, "shared/attachments.ts"),
      "export const MAX_ATTACHMENTS_PER_MESSAGE = 8;\n",
    );
    await writeFile(join(appDir, "dist/index.html"), "<html></html>\n");
    await callback({ rootDir, appDir });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe("production build cache", () => {
  test("the package serve script validates the build before starting the native Bun server", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(packageJson.scripts.serve).toBe(
      "bun scripts/serve-or-build.ts && bun serve.ts",
    );
  });

  test("accepts a build only when the manifest and index match the current inputs", async () => {
    await withProject(async (paths) => {
      await writeBuildCacheManifest(paths, {
        TENANT_PACKAGE_DIR: "../examples/brand",
        VITE_PUBLIC_NAME: "OpenBot",
      });

      expect(
        await isReusableBuild(paths, {
          TENANT_PACKAGE_DIR: "../examples/brand",
          VITE_PUBLIC_NAME: "OpenBot",
        }),
      ).toBe(true);
    });
  });

  test.each([
    ["source", "app/src/main.tsx", "console.log('b')\n"],
    ["lockfile", "bun.lock", "lock-b\n"],
    ["root package version", "package.json", '{"version":"1.2.4"}\n'],
    ["app package manifest", "app/package.json", '{"version":"0.0.1"}\n'],
    ["tenant branding", "examples/brand/brand.yaml", "name: B\n"],
    [
      "a shared module the app imports",
      "shared/attachments.ts",
      "export const MAX_ATTACHMENTS_PER_MESSAGE = 10;\n",
    ],
  ] as const)(
    "rejects a build when %s changes",
    async (_name, path, contents) => {
      await withProject(async (paths) => {
        const env = { TENANT_PACKAGE_DIR: "../examples/brand" };
        await writeBuildCacheManifest(paths, env);

        await writeFile(join(paths.rootDir, path), contents);

        expect(await isReusableBuild(paths, env)).toBe(false);
      });
    },
  );

  test("rejects a build when Vite-exposed environment changes", async () => {
    await withProject(async (paths) => {
      await writeBuildCacheManifest(paths, { VITE_PUBLIC_NAME: "OpenBot" });

      expect(
        await isReusableBuild(paths, { VITE_PUBLIC_NAME: "Changed" }),
      ).toBe(false);
    });
  });

  test("rejects missing, corrupt, and stale manifests", async () => {
    await withProject(async (paths) => {
      expect(await isReusableBuild(paths, {})).toBe(false);

      await writeFile(buildCacheManifestPath(paths), "{ nope");
      expect(await isReusableBuild(paths, {})).toBe(false);

      await writeBuildCacheManifest(paths, {});
      const manifest = await readBuildCacheManifest(paths);
      await writeFile(
        buildCacheManifestPath(paths),
        JSON.stringify({ ...manifest, version: -1 }),
      );
      expect(await isReusableBuild(paths, {})).toBe(false);
    });
  });

  test("rejects a manifest when dist/index.html is missing", async () => {
    await withProject(async (paths) => {
      await writeBuildCacheManifest(paths, {});
      await rm(join(paths.appDir, "dist/index.html"));

      expect(await isReusableBuild(paths, {})).toBe(false);
    });
  });

  test("the startup script regenerates config but skips Vite for a valid build", async () => {
    await withProject(async (paths) => {
      await mkdir(join(paths.rootDir, "scripts"), { recursive: true });
      await mkdir(join(paths.appDir, "node_modules/vite/bin"), {
        recursive: true,
      });
      await writeFile(
        join(paths.rootDir, "package.json"),
        JSON.stringify({
          version: "1.2.3",
          scripts: { "generate:app-config": "bun scripts/generate.ts" },
        }),
      );
      await writeFile(
        join(paths.rootDir, "scripts/generate.ts"),
        [
          'import { appendFile } from "node:fs/promises";',
          `await appendFile(${JSON.stringify(join(paths.rootDir, "startup.log"))}, "generate\\n");`,
        ].join("\n"),
      );
      await writeFile(
        join(paths.appDir, "node_modules/vite/bin/vite.js"),
        [
          'import { appendFile } from "node:fs/promises";',
          `await appendFile(${JSON.stringify(join(paths.rootDir, "startup.log"))}, "build\\n");`,
        ].join("\n"),
      );
      const env = {
        ...process.env,
        OPENBOT_BUILD_CACHE_ROOT_DIR: paths.rootDir,
        OPENBOT_BUILD_CACHE_APP_DIR: paths.appDir,
      };
      await writeBuildCacheManifest(paths, env);

      const child = Bun.spawn({
        cmd: [process.execPath, serveOrBuildScriptPath],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(await readFile(join(paths.rootDir, "startup.log"), "utf8")).toBe(
        "generate\n",
      );
    });
  });

  test("the startup script invokes Vite and refreshes the manifest for a stale build", async () => {
    await withProject(async (paths) => {
      await mkdir(join(paths.rootDir, "scripts"), { recursive: true });
      await mkdir(join(paths.appDir, "node_modules/vite/bin"), {
        recursive: true,
      });
      await writeFile(
        join(paths.rootDir, "package.json"),
        JSON.stringify({
          version: "1.2.3",
          scripts: { "generate:app-config": "bun scripts/generate.ts" },
        }),
      );
      await writeFile(
        join(paths.rootDir, "scripts/generate.ts"),
        [
          'import { appendFile } from "node:fs/promises";',
          `await appendFile(${JSON.stringify(join(paths.rootDir, "startup.log"))}, "generate\\n");`,
        ].join("\n"),
      );
      await writeFile(
        join(paths.appDir, "node_modules/vite/bin/vite.js"),
        [
          'import { appendFile } from "node:fs/promises";',
          `await appendFile(${JSON.stringify(join(paths.rootDir, "startup.log"))}, "build\\n");`,
          `await Bun.write(${JSON.stringify(join(paths.appDir, "dist/index.html"))}, "<html>rebuilt</html>\\n");`,
        ].join("\n"),
      );
      const env = {
        ...process.env,
        OPENBOT_BUILD_CACHE_ROOT_DIR: paths.rootDir,
        OPENBOT_BUILD_CACHE_APP_DIR: paths.appDir,
      };
      await writeBuildCacheManifest(paths, env);
      await writeFile(join(paths.appDir, "src/main.tsx"), "console.log('b')\n");

      const child = Bun.spawn({
        cmd: [process.execPath, serveOrBuildScriptPath],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(await readFile(join(paths.rootDir, "startup.log"), "utf8")).toBe(
        "generate\nbuild\n",
      );
      expect(await isReusableBuild(paths, env)).toBe(true);

      const second = Bun.spawn({
        cmd: [process.execPath, serveOrBuildScriptPath],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [secondExitCode] = await Promise.all([
        second.exited,
        new Response(second.stderr).text(),
      ]);

      expect(secondExitCode).toBe(0);
      expect(await readFile(join(paths.rootDir, "startup.log"), "utf8")).toBe(
        "generate\nbuild\ngenerate\n",
      );
    });
  });
});
