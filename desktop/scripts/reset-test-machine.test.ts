/**
 * reset-test-machine.sh and reset-test-machine.ps1, each run end to end in a home folder of its own,
 * against stand-ins for `podman`, `docker` and the CLI (`npx copilotkit`) that record every call.
 *
 * Found on a Mac: Quit stops OpenBot's Podman machine with Intelligence, so the reset's
 * `local delete` was refused (`docker_unavailable`), and the machine was then removed. That left the
 * CLI's record of the stack behind. Now a refused delete starts the machine and tries again before
 * the machine is removed, and a delete that still can't run says what it leaves behind.
 *
 * The PowerShell script runs under pwsh, which CI's Linux runners have. Its Windows-only steps
 * (processes, the registry) find nothing there; the stack's delete, which this checks, is the same.
 */
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STACK = "local-e4ed9c0727ed2b153d71ebbe";
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const blocked = JSON.stringify({
  version: 1,
  command: "local delete",
  status: "blocked",
  nextAction: {
    reason: "docker_unavailable",
    summary:
      "Podman could not be queried. Start the Podman machine (podman machine start), then retry. Saved data was not changed.",
  },
});
const completed = JSON.stringify({
  version: 1,
  command: "local delete",
  status: "completed",
});

type Script = "bash" | "pwsh";

/**
 * How long one reset may take. pwsh's own start takes seconds, and more on a busy CI runner: under
 * bun's default 5 seconds a pwsh case failed on main with nothing printed yet, though it passed on
 * its own pull request. The script itself does little; these limits are for a slow machine.
 */
const limits: Record<Script, number> = { bash: 30_000, pwsh: 120_000 };

/**
 * Runs the reset unattended. The machine OpenBot made is there and stopped, as Quit leaves it.
 *
 * @param script - The Mac script under bash, or the Windows one under pwsh.
 * @param machineStarts - Whether `podman machine start` brings it up, after which the CLI's delete
 *   goes through.
 * @param engineAnswers - Whether the delete goes through at once, with no machine to start.
 */
function reset(script: Script, machineStarts: boolean, engineAnswers = false) {
  const dir = mkdtempSync(join(tmpdir(), "reset-test-machine-"));
  temps.push(dir);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const root = join(home, "OpenBot");
  mkdirSync(bin, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, ".openbot-local-eval.json"),
    JSON.stringify({ ownership: "created", stack: STACK }),
  );
  const calls = join(dir, "calls");
  const started = join(dir, "started");
  const removed = join(dir, "removed");
  const stub = (name: string, body: string) => {
    writeFileSync(
      join(bin, name),
      `#!/bin/bash\necho "${name} $*" >> '${calls}'\n${body}\n`,
    );
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    "podman",
    `case "$*" in
  info) exit 1 ;;
  "machine inspect openbot") [ -e '${removed}' ] && exit 125; exit 0 ;;
  "machine start openbot") ${machineStarts ? `touch '${started}'; exit 0` : "echo 'Error: could not start' >&2; exit 125"} ;;
  "machine rm -f openbot") touch '${removed}'; exit 0 ;;
esac
exit 0`,
  );
  stub("docker", "exit 1");
  stub(
    "npx",
    `case "$*" in
  "--yes copilotkit local delete"*)
    if ${engineAnswers ? "true" : "false"} || [ -e '${started}' ]; then echo '${completed}'; exit 0; fi
    echo '${blocked}'; exit 2 ;;
esac
exit 0`,
  );
  const command =
    script === "bash"
      ? ["bash", join(import.meta.dir, "reset-test-machine.sh"), "--yes"]
      : [
          "pwsh",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(import.meta.dir, "reset-test-machine.ps1"),
          "-Yes",
        ];
  // Synchronous: this returns only once the script, and every stand-in it ran, has exited. Each
  // stand-in appends its line to the call log before it does anything else, so the log is whole
  // when it is read below. A script that hangs is killed short of the test's own limit, so the test
  // fails with what it printed rather than being cut off.
  const run = Bun.spawnSync(command, {
    timeout: limits[script] - 10_000,
    env: {
      ...process.env,
      HOME: home,
      OPENBOT_ROOT: root,
      // An app that is not there, under a name no running OpenBot has: the CLI is `npx copilotkit`.
      OPENBOT_APP: join(dir, "OpenBotUnderTest.app"),
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  return {
    code: run.exitCode,
    out: run.stdout.toString(),
    calls: existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n")
      : [],
  };
}

const deleteCall = `npx --yes copilotkit local delete --stack ${STACK} --confirm-delete ${STACK} --json`;

// CI's Linux runners have pwsh, so there it must run; a computer without pwsh skips it.
const scripts: Script[] =
  Bun.which("pwsh") || process.env.CI ? ["bash", "pwsh"] : ["bash"];

for (const script of scripts) {
  /** The script ran to its end: bash says so with its exit code, pwsh by its last line. */
  const finished = (code: number | null, out: string) => {
    if (script === "bash") expect(code).toBe(0);
    expect(out).toContain("Done.");
  };

  test.skipIf(process.platform === "win32")(
    `${script}: a delete the stopped machine refused starts the machine and deletes the stack before the machine is removed`,
    () => {
      const { code, out, calls } = reset(script, true);
      finished(code, out);
      const order = calls.filter((call) =>
        [
          deleteCall,
          "podman machine start openbot",
          "podman machine rm -f openbot",
        ].includes(call),
      );
      expect(order).toEqual([
        deleteCall,
        "podman machine start openbot",
        deleteCall,
        "podman machine rm -f openbot",
      ]);
      expect(out).toContain(`deleted ${STACK}`);
      expect(out).not.toContain("left behind");
    },
    limits[script],
  );

  test.skipIf(process.platform === "win32")(
    `${script}: a delete that still can't run says what it leaves behind and how to delete it`,
    () => {
      const { code, out, calls } = reset(script, false);
      finished(code, out);
      expect(calls).toContain("podman machine start openbot");
      expect(calls.filter((call) => call === deleteCall)).toHaveLength(2);
      expect(out).toContain(`could not delete ${STACK}`);
      expect(out).toContain(`left behind: the CLI's record of ${STACK}`);
      expect(out).toContain(
        `copilotkit local delete --stack ${STACK} --confirm-delete ${STACK}`,
      );
      // The reset still goes on to remove the machine.
      expect(calls).toContain("podman machine rm -f openbot");
    },
    limits[script],
  );

  test.skipIf(process.platform === "win32")(
    `${script}: a delete that goes through at once starts no machine`,
    () => {
      const { code, out, calls } = reset(script, false, true);
      finished(code, out);
      expect(calls).not.toContain("podman machine start openbot");
      expect(calls.filter((call) => call === deleteCall)).toHaveLength(1);
      expect(out).toContain(`deleted ${STACK}`);
    },
    limits[script],
  );
}
