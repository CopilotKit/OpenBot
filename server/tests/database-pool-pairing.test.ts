/**
 * Pairing rule for server/tests: a file that opens a database pool must close it.
 *
 * Every file that calls createDatabase holds a pool for the rest of the process.
 * PostgreSQL's default max_connections is 100; with TEST_POOL max: 2, a file costs
 * two connections from its first query. Leaving pools open exhausts the server
 * during a full `bun test server/tests` run (see #785).
 *
 * The close must be the last work in that file's teardown (Bun runs afterAll FIFO),
 * so deletes still have a live client. This guard only checks that a close exists;
 * hook order stays a human review concern.
 */
import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const testsRoot = join(import.meta.dir);

async function listTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTestFiles(path)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

test("a file that opens a database closes it", async () => {
  const files = await listTestFiles(testsRoot);
  const offenders: string[] = [];

  for (const path of files) {
    const source = await Bun.file(path).text();
    if (!source.includes("createDatabase(")) continue;
    if (source.includes("$client.close(") || source.includes("$client.end(")) {
      continue;
    }
    offenders.push(path.slice(testsRoot.length + 1));
  }

  expect(offenders).toEqual([]);
});
