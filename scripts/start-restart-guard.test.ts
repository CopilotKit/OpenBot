import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function runStartWithStaleServerProbe(status: 401 | 404) {
  const root =
    await Bun.$`mktemp -d ${tmpdir()}/openbot-start-guard-XXXXXX`.text();
  const directory = root.trim();
  const fakeBin = join(directory, "bin");
  const scripts = join(directory, "scripts");
  const logPath = join(directory, "pkill.log");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(scripts, { recursive: true });
  await writeFile(
    join(directory, ".env"),
    [
      "APP_PORT=3010",
      "SERVER_PORT=3001",
      "COMPUTER_PORT=4100",
      "BOT_PORT=4200",
      "LANGGRAPH_PORT=4201",
      "SUPERVISOR_PORT=4500",
      "SUPERVISOR_TOKEN=supervisor-token",
      "COMPUTER_TOKEN=computer-token",
      "WORKER_SHARED_SECRET=worker-secret",
      "MANAGED_AGENT_TOKEN=managed-token",
      "AGENT_TOOL_TOKEN=agent-tool-token",
      "MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui",
      "OPENBOT_ONE_COMPUTER_EACH=true",
      "DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(scripts, "start.sh"),
    await readFile("scripts/start.sh"),
  );
  await chmod(join(scripts, "start.sh"), 0o755);

  await writeExecutable(
    join(fakeBin, "lsof"),
    '#!/usr/bin/env bash\necho "p123"\necho "cbun"\necho "n*:3001"\n',
  );
  await writeExecutable(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"/internal/routines/run"* ]]; then
  printf '${status}'
  exit 0
fi
if [[ "$args" == *"/api/copilotkit/info"* ]]; then
  printf '{"licenseStatus":"valid","mode":"test","agents":{"analyst":{}}}'
  exit 0
fi
if [[ "$args" == *"http://localhost:3010/"* ]]; then
  printf '<title>OpenBot</title>'
  exit 0
fi
exit 0
`,
  );
  await writeExecutable(
    join(fakeBin, "docker"),
    `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"to_regclass('public.agent_profiles')"* ]]; then echo agent_profiles; fi
if [[ "$args" == *"to_regclass('public.agent_preferences')"* ]]; then echo agent_preferences; fi
exit 0
`,
  );
  await writeExecutable(
    join(fakeBin, "pgrep"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  await writeExecutable(
    join(fakeBin, "pkill"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PKILL_LOG"\nexit 0\n',
  );
  await writeExecutable(
    join(fakeBin, "sleep"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  await writeExecutable(join(fakeBin, "bun"), "#!/usr/bin/env bash\nexit 0\n");

  try {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/start.sh"],
      cwd: directory,
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PKILL_LOG: logPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const pkillLog = await Bun.file(logPath)
      .text()
      .catch(() => "");
    return { exitCode, stdout, stderr, pkillLog };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("start.sh server restart guard", () => {
  test.each([401, 404] as const)(
    "stops both current and legacy server launch patterns after handoff probe %s",
    async (status) => {
      const result = await runStartWithStaleServerProbe(status);

      expect({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        pkillLog: result.pkillLog,
      }).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.pkillLog).toContain(
        "bun --env-file=../.env src/production-entry.ts",
      );
      expect(result.pkillLog).toContain("bun --env-file=../.env src/index.ts");
    },
  );
});
