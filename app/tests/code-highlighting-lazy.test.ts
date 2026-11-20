import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Shiki is fetched with the first code block, not with the conversation. See the probe for how.
 *
 * IN A PROCESS OF ITS OWN. `bun test` walks every file in one module graph, so by the time this file
 * runs another may already have highlighted code and loaded Shiki, and "not loaded yet" can no longer
 * be asked. The probe runs in a fresh `bun test` with nothing loaded. Its output goes to a file
 * rather than a pipe, which a long suite can leave empty.
 */
test("a conversation loads Shiki only once it has code to highlight", async () => {
  const dir = await mkdtemp(join(tmpdir(), "code-highlighting-lazy-"));
  const log = join(dir, "probe.log");
  try {
    const probe = Bun.spawn({
      cmd: [
        process.execPath,
        "test",
        "./tests/code-highlighting-lazy.probe.tsx",
      ],
      cwd: join(import.meta.dir, ".."),
      stdout: "ignore",
      // Bun writes a test run's results to stderr.
      stderr: Bun.file(log),
    });
    const exitCode = await probe.exited;
    const output = await readFile(log, "utf8");
    expect(output).toContain("1 pass");
    expect(exitCode).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
