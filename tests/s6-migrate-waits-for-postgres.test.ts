/**
 * The all-in-one image's migrations wait for the embedded database to accept connections.
 *
 * s6 counts `postgres` as up when its process starts, so `migrate` could connect while Postgres was
 * still starting, get "the database system is starting up", and exit 1. s6 does not retry a
 * oneshot, so the container never served: main's `image` job failed on exactly that (run
 * 41749508939, 2026-11-04). These run the real script against a stand-in for `pg_isready` that
 * answers with its real exit codes: 2 while nothing listens, 1 while the server starts, 0 when ready.
 */
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPTS = join(ROOT, "docker/s6/scripts");
const WAIT = join(SCRIPTS, "wait-for-postgres.sh");

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A `pg_isready` that answers each call with the next code, then repeats the last one. */
function pgIsready(answers: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "pg-isready-"));
  scratch.push(dir);
  const calls = join(dir, "calls");
  writeFileSync(calls, "0");
  writeFileSync(join(dir, "answers"), `${answers.join("\n")}\n`);
  const path = join(dir, "pg_isready");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `n=$(cat "${calls}")`,
      `echo $((n + 1)) > "${calls}"`,
      `code=$(sed -n "$((n + 1))p" "${join(dir, "answers")}")`,
      `exit "\${code:-${answers.at(-1)}}"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { path, calls: () => Number(readFileSync(calls, "utf8")) };
}

function waitWith(pgIsreadyPath: string, seconds?: number) {
  return Bun.spawnSync(["sh", WAIT], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PG_ISREADY: pgIsreadyPath,
      ...(seconds === undefined
        ? {}
        : { POSTGRES_WAIT_SECONDS: String(seconds) }),
    },
  });
}

test("waits while Postgres is not listening and then still starting, and goes on once it accepts", () => {
  const ready = pgIsready([2, 1, 1, 0]);
  const run = waitWith(ready.path);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  expect(ready.calls()).toBe(4);
});

test("gives up with a reason when Postgres never accepts connections", () => {
  const ready = pgIsready([1]);
  const run = waitWith(ready.path, 1);
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain(
    "Postgres did not accept connections on 127.0.0.1:5432 within 1s.",
  );
  expect(ready.calls()).toBeGreaterThan(1);
});

test("migrate.sh waits for the embedded database before it migrates", () => {
  const migrate = readFileSync(join(SCRIPTS, "migrate.sh"), "utf8");
  const embeddedOnly = migrate.indexOf('= "on" ] || exit 0');
  const waits = migrate.indexOf('"$(dirname "$0")/wait-for-postgres.sh"');
  const migrates = migrate.indexOf("scripts/migrate.ts");
  expect(embeddedOnly).toBeGreaterThan(-1);
  expect(waits).toBeGreaterThan(embeddedOnly);
  expect(migrates).toBeGreaterThan(waits);
  // s6 runs it by path, so it has to be executable in the image the same way migrate.sh is.
  expect(statSync(WAIT).mode & 0o111).toBe(0o111);
});
