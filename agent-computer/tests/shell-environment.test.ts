import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShell } from "../src/shell";

/**
 * What a Bot's command can read out of the process that runs it.
 *
 * This process is started with the container's whole environment, deliberately: it needs
 * `COMPUTER_TOKEN` to authenticate its own callers. In the one-container image that environment also
 * carries `DATABASE_URL`, `KEY_ENCRYPTION_KEY` and the licence, because there is one environment and
 * every service reads it.
 *
 * A command a Bot wrote must not see any of that. `COMPUTER_TOKEN` is the sharpest case: it is the
 * only thing standing in front of the control surface on port 4100, and this shell runs inside the
 * process that serves it. A Bot holding that token could drive the browser over loopback, which skips
 * the policy decision and the audit row that are the entire point of the gateway.
 *
 * The assertion is a whole-set one rather than a list of names to exclude, because the dangerous name
 * is the one nobody thought of. A variable added to a deployment next year is covered by this without
 * anybody remembering to add it here.
 *
 * Against a real shell, not a mock: the question is what a process actually inherits, and a mock
 * would only answer what we believed it inherits. The marker below uses a name nothing else reads,
 * because a test that sets `DATABASE_URL` on the real environment breaks every other test that
 * reads one.
 */

const ALLOWED = new Set([
  "HOME",
  "PATH",
  "DEBIAN_FRONTEND",
  "TERM",
  "LANG",
  "LC_ALL",
  "TZ",
  // bash sets these itself for any shell it starts; they are not inherited from this process.
  "PWD",
  "SHLVL",
  "_",
  "OLDPWD",
  "SHELL",
]);

const MARKER = "OPENBOT_SHELL_ENV_TEST_MARKER";
const MARKER_VALUE = "this-must-not-reach-a-bot-command";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "openbot-shell-env-"));
  process.env[MARKER] = MARKER_VALUE;
});

afterEach(async () => {
  delete process.env[MARKER];
  await rm(workspace, { recursive: true, force: true });
});

describe("a command a Bot wrote", () => {
  test("sees only the variables it was explicitly given", async () => {
    const result = await createShell(workspace).run({
      // One name per line, values dropped: the question is which variables exist at all.
      command: "env | cut -d= -f1 | sort -u",
    });

    expect(result.exitCode).toBe(0);
    const leaked = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.length > 0 && !ALLOWED.has(name));

    expect(leaked).toEqual([]);
  });

  test("cannot read a secret held by the process that runs it", async () => {
    const result = await createShell(workspace).run({
      command: `echo "[$${MARKER}]"`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("[]");
    expect(result.stdout).not.toContain(MARKER_VALUE);
  });

  test("still has the environment a command needs to work", async () => {
    // The point is an allow-list, not an empty environment. Without PATH nothing resolves, and the
    // tool description tells the model to install packages, which needs one.
    const result = await createShell(workspace).run({
      command: 'echo "$HOME"; command -v sh >/dev/null && echo "path works"',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(workspace);
    expect(result.stdout).toContain("path works");
  });
});
