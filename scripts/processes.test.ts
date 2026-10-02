import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `scripts/processes.sh` on a Windows host that has no `lsof`, `pgrep` or `pkill`, run anywhere.
 *
 * PATH holds only the fakes below and `tr`, so a Linux machine with the real tools installed still
 * takes the Windows path, and the fake `powershell.exe` records what it was asked. It answers with
 * CRLF line endings, as the real one does. The fakes are `#!/bin/sh` because a `#!` line cannot hold
 * the space in Windows' `C:\Program Files\Git\...\bash.exe`.
 */

const processesScript = resolve("scripts/processes.sh");
const bash = Bun.which("bash") as string;
const realTr = Bun.which("tr") as string;

let directory: string;
let bin: string;
let log: string;

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbot-processes-"));
  bin = join(directory, "bin");
  log = join(directory, "calls.log");
  await Bun.$`mkdir -p ${bin}`;
  await writeExecutable(join(bin, "tr"), `#!/bin/sh\nexec "${realTr}" "$@"\n`);
  await writeExecutable(
    join(bin, "powershell.exe"),
    `#!/bin/sh
printf 'argv=%s|port=%s|pattern=%s|stop=%s|pids=%s\\n' "$*" "\${OPENBOT_PORT:-}" "\${OPENBOT_PATTERN:-}" "\${OPENBOT_STOP:-}" "\${OPENBOT_PIDS:-}" >> "$CALLS"
case "$*" in
  *ProcessName*) printf 'bun (127.0.0.1:%s)\\r\\n' "$OPENBOT_PORT" ;;
  *-Unique*|*Win32_Process*) printf '4242\\r\\n' ;;
esac
`,
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

// `OS` is always passed: Git Bash restores `OS=Windows_NT` from Windows when it is merely left out.
async function run(expression: string, os = "Windows_NT") {
  const child = Bun.spawn({
    cmd: [bash, "-c", `. "${processesScript}"; ${expression}`],
    env: { PATH: bin, CALLS: log, OS: os },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  const calls = await Bun.file(log)
    .text()
    .catch(() => "");
  return { exitCode, stdout, calls };
}

describe("processes.sh on Windows without lsof, pgrep or pkill", () => {
  test("holder names the listener, with the port in the environment and no CR", async () => {
    const result = await run('printf "[%s]" "$(holder 3001)"');

    expect(result.stdout).toBe("[bun (127.0.0.1:3001)]");
    expect(result.calls).toContain("|port=3001|");
    expect(result.calls).not.toContain("argv=3001");
  });

  test("port_pids and kill_pids hand Windows ids to PowerShell", async () => {
    const result = await run('kill_pids -9 $(port_pids 3001); echo "exit=$?"');

    expect(result.stdout).toBe("exit=0\n");
    expect(result.calls).toContain("|pids=-9 4242");
  });

  test("running finds the worker without its pattern on PowerShell's command line", async () => {
    const result = await run(
      'running "bun worker/src/index.ts" && echo yes || echo no',
    );

    expect(result.stdout).toBe("yes\n");
    expect(result.calls).toContain("|pattern=bun worker/src/index.ts|stop=|");
    expect(result.calls.split("|port=")[0]).not.toContain(
      "worker/src/index.ts",
    );
  });

  test("stop_matching asks PowerShell to stop what matches", async () => {
    const result = await run(
      'stop_matching "bun --env-file=../.env src/production-entry.ts"; echo "exit=$?"',
    );

    expect(result.stdout).toBe("exit=0\n");
    expect(result.calls).toContain(
      "|pattern=bun --env-file=../.env src/production-entry.ts|stop=stop|",
    );
  });
});

describe("processes.sh where the POSIX tools are the answer", () => {
  test("a Windows host that has lsof, pgrep and pkill uses them, not PowerShell", async () => {
    for (const tool of ["lsof", "pgrep", "pkill"]) {
      await writeExecutable(
        join(bin, tool),
        `#!/bin/sh\nprintf '%s %s\\n' "${tool}" "$*" >> "$CALLS"\n`,
      );
    }

    const result = await run(
      'holder 3001; running "bun worker/src/index.ts"; stop_matching "bun worker/src/index.ts"',
    );

    expect(result.calls).not.toContain("argv=");
    expect(result.calls).toContain("lsof -nP -iTCP:3001 -sTCP:LISTEN -Fcn");
    expect(result.calls).toContain("pgrep -f bun worker/src/index.ts");
    expect(result.calls).toContain("pkill -f bun worker/src/index.ts");
  });

  test("off Windows, a missing lsof is still an empty answer, as before", async () => {
    const result = await run('printf "[%s]" "$(holder 3001)"', "");

    expect(result.stdout).toBe("[]");
    expect(result.calls).toBe("");
  });
});
