/**
 * reset-test-machine.sh, run end to end in a home folder of its own, against stand-ins for `podman`,
 * `docker` and the CLI (`npx copilotkit`) that record every call.
 *
 * Found on a Mac: Quit stops OpenBot's Podman machine with Intelligence, so the reset's
 * `local delete` was refused (`docker_unavailable`), and the machine was then removed. That left the
 * CLI's record of the stack behind. Now a refused delete starts the machine and tries again before
 * the machine is removed, and a delete that still can't run says what it leaves behind.
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

const script = join(import.meta.dir, "reset-test-machine.sh");
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

/**
 * Runs the reset with `--yes`. The machine OpenBot made is there and stopped, as Quit leaves it.
 *
 * @param machineStarts - Whether `podman machine start` brings it up, after which the CLI's delete
 *   goes through.
 * @param engineAnswers - Whether the delete goes through at once, with no machine to start.
 */
function reset(machineStarts: boolean, engineAnswers = false) {
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
  "machine inspect openbot") exit 0 ;;
  "machine start openbot") ${machineStarts ? `touch '${started}'; exit 0` : "echo 'Error: could not start' >&2; exit 125"} ;;
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
  const run = Bun.spawnSync(["bash", script, "--yes"], {
    env: {
      ...process.env,
      HOME: home,
      OPENBOT_ROOT: root,
      // An app that is not there, under a name no running OpenBot has: the CLI is `npx copilotkit`.
      OPENBOT_APP: join(dir, "OpenBotUnderTest.app"),
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

test.skipIf(process.platform === "win32")(
  "a delete the stopped machine refused starts the machine and deletes the stack before the machine is removed",
  () => {
    const { code, out, calls } = reset(true);
    expect(code).toBe(0);
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
);

test.skipIf(process.platform === "win32")(
  "a delete that still can't run says what it leaves behind and how to delete it",
  () => {
    const { code, out, calls } = reset(false);
    expect(code).toBe(0);
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
);

test.skipIf(process.platform === "win32")(
  "a delete that goes through at once starts no machine",
  () => {
    const { code, out, calls } = reset(false, true);
    expect(code).toBe(0);
    expect(calls).not.toContain("podman machine start openbot");
    expect(calls.filter((call) => call === deleteCall)).toHaveLength(1);
    expect(out).toContain(`deleted ${STACK}`);
  },
);
