import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

const desktop = resolve(import.meta.dir, "..");

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

// The workbench and its fake native side must never reach the shipped window.
test("the shipped build holds nothing of the workbench", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "shipped-build-"));
  try {
    await build({
      configFile: join(desktop, "vite.config.ts"),
      root: desktop,
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
    const files = await filesIn(outDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = (await readFile(file)).toString("latin1");
      expect(text.includes("__workbench"), file).toBe(false);
      expect(text.includes("fakeNative"), file).toBe(false);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}, 180_000);
