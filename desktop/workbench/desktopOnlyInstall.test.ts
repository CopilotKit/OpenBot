import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The desktop's release jobs install only desktop/.
 *
 * desktop-build.yml, desktop-signing.yml and desktop-macos-signing.yml run `bun install` in desktop/
 * and nowhere else, then `bun run typecheck` and a few `bun test` files from there. The workbench
 * draws with the app's components, whose packages only app/ installs, so neither of those may reach
 * the app: desktop/tsconfig.json leaves the workbench out (workbench/tsconfig.json checks it, with
 * the app's `@/` paths, in CI's static job, where app/ is installed), and desktop/bunfig.toml loads
 * the app's test preload only where the app's packages are installed.
 *
 * CI's other jobs install the whole repository, so without these tests a change that breaks a
 * desktop-only install shows up first in a release build.
 */

const desktopDir = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopDir, "..");

describe("a desktop-only install", () => {
  test("desktop's typecheck reaches nothing in app/", () => {
    const tsc = join(desktopDir, "node_modules", "typescript", "bin", "tsc");
    const listed = Bun.spawnSync(
      [process.execPath, tsc, "--listFilesOnly", "-p", "tsconfig.json"],
      { cwd: desktopDir, stdout: "pipe", stderr: "pipe" },
    );
    const files = listed.stdout.toString().trim().split("\n");
    expect(files.some((file) => file.includes("/desktop/src/"))).toBe(true);
    const inApp = files.filter((file) =>
      relative(repositoryRoot, file).startsWith("app/"),
    );
    expect(inApp).toEqual([]);
  });

  test("desktop's test preloads load with nothing of the app installed", () => {
    const parsed = Bun.TOML.parse(
      readFileSync(join(desktopDir, "bunfig.toml"), "utf8"),
    ) as { test?: { preload?: string[] } };
    const preloads = parsed.test?.preload ?? [];
    expect(preloads.length).toBeGreaterThan(0);

    // A copy of the files a preload is, with no packages at all. The empty node_modules stops Bun
    // installing a missing package on its own.
    const scratch = mkdtempSync(join(tmpdir(), "desktop-only-"));
    try {
      const copy = (path: string) => {
        const from = join(repositoryRoot, path);
        const to = join(scratch, path);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
      };
      copy("desktop/bunfig.toml");
      copy("desktop/package.json");
      copy("app/package.json");
      copy("tests/support");
      for (const preload of preloads) {
        copy(relative(repositoryRoot, resolve(desktopDir, preload)));
      }
      mkdirSync(join(scratch, "node_modules"));
      writeFileSync(
        join(scratch, "desktop", "probe.test.ts"),
        'import { test } from "bun:test";\ntest("runs", () => {});\n',
      );

      const run = Bun.spawnSync([process.execPath, "test", "probe.test.ts"], {
        cwd: join(scratch, "desktop"),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const output = run.stdout.toString() + run.stderr.toString();
      expect(output).toContain(" 1 pass");
      expect(run.exitCode).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
