import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

const app = resolve(import.meta.dir, "..");

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? filesIn(join(dir, entry.name))
        : Promise.resolve([join(dir, entry.name)]),
    ),
  );
  return nested.flat();
}

const SOURCE_WORDS = ["__workbench", "fakeNative", "/__app/", "app/workbench"];
const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

/** The import specifiers in `text` that reach the workbench folder. */
function workbenchImports(text: string): string[] {
  return [...text.matchAll(IMPORT)]
    .map((match) => match[1] ?? "")
    .filter(
      (specifier) =>
        specifier.includes("workbench/") ||
        specifier.endsWith("../workbench") ||
        specifier === "workbench",
    );
}

// The workbench serves the app with its own Vite config. The app's own config, its HTML and its
// sources must not know about it.
test("the app's sources do not name the workbench", async () => {
  for (const name of ["vite.config.ts", "index.html"]) {
    const text = await readFile(join(app, name), "utf8");
    for (const word of ["workbench", "__app", "fakeNative"]) {
      expect(text.includes(word), `${name} names "${word}"`).toBe(false);
    }
  }
  const sources = (await filesIn(join(app, "src"))).filter((file) =>
    /\.(ts|tsx|css)$/.test(file),
  );
  expect(sources.length).toBeGreaterThan(0);
  for (const file of sources) {
    const text = await readFile(file, "utf8");
    for (const word of SOURCE_WORDS) {
      expect(text.includes(word), `${file} names "${word}"`).toBe(false);
    }
    expect(workbenchImports(text), file).toEqual([]);
  }
});

// The full build is slow, so it runs only when OPENBOT_APP_BUILD_GUARD=1 (CI sets it). It needs
// `bun run generate:app-config` first.
const guard = process.env.OPENBOT_APP_BUILD_GUARD === "1";

(guard ? test : test.skip)(
  "the shipped build holds nothing of the workbench",
  async () => {
    const outDir = await mkdtemp(join(tmpdir(), "app-shipped-build-"));
    try {
      await build({
        configFile: join(app, "vite.config.ts"),
        root: app,
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });
      const files = await filesIn(outDir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const text = (await readFile(file)).toString("latin1");
        for (const word of [
          "__workbench",
          "fakeNative",
          "/__app/",
          "workbenchPreboot",
        ]) {
          expect(text.includes(word), `${file} holds "${word}"`).toBe(false);
        }
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
  300_000,
);
