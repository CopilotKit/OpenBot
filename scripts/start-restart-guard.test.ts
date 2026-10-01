import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

/**
 * How this run differs from the ordinary one, which is the whole vocabulary these tests need.
 *
 * `shell` IS A PARAMETER BECAUSE THE INVOCATION IS PART OF WHAT IS UNDER TEST. `bash` is the
 * supported one and the one the docs name; `sh` is the one somebody reaches for out of habit, and
 * what it produced was exit 1 with no output at all.
 *
 * `omitFromEnv` IS THE OTHER HALF. Every key below has a default in the script, so a `.env` without
 * one is an ordinary `.env` rather than a broken one — `.env.example` does not list `APP_PORT` at
 * all.
 */
type Run = {
  shell?: "bash" | "sh";
  omitFromEnv?: readonly string[];
  settings?: Record<string, string>;
  processEnvironment?: Record<string, string>;
  unavailableHealthPorts?: readonly number[];
};

async function runStartWithStaleServerProbe(
  status: 401 | 404,
  {
    shell = "bash",
    omitFromEnv = [],
    settings = {},
    processEnvironment = {},
    unavailableHealthPorts = [],
  }: Run = {},
) {
  const root =
    await Bun.$`mktemp -d ${tmpdir()}/openbot-start-guard-XXXXXX`.text();
  const directory = root.trim();
  const fakeBin = join(directory, "bin");
  const scripts = join(directory, "scripts");
  const logPath = join(directory, "pkill.log");
  const dockerLogPath = join(directory, "docker.log");
  const curlLogPath = join(directory, "curl.log");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(scripts, { recursive: true });
  const environment = [
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
  ].filter(
    (line) =>
      ![...omitFromEnv, ...Object.keys(settings)].some((key) =>
        line.startsWith(`${key}=`),
      ),
  );
  environment.push(
    ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
  );
  await writeFile(join(directory, ".env"), `${environment.join("\n")}\n`);
  await writeFile(
    join(scripts, "start.sh"),
    await readFile("scripts/start.sh"),
  );
  await chmod(join(scripts, "start.sh"), 0o755);
  // Copied beside it because `start.sh` sources it by its own directory, so a temp root without it
  // would fail on a missing file rather than on whatever the test is about.
  await writeFile(
    join(scripts, "require-bash.sh"),
    await readFile("scripts/require-bash.sh"),
  );

  await writeExecutable(
    join(fakeBin, "lsof"),
    '#!/usr/bin/env bash\necho "p123"\necho "cbun"\necho "n*:3001"\n',
  );
  await writeExecutable(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "$args" >> "$CURL_LOG"
for port in ${unavailableHealthPorts.join(" ")}; do
  if [[ "$args" == *"http://localhost:$port/health"* ]]; then exit 7; fi
done
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
printf '%s\\n' "$args" >> "$DOCKER_LOG"
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
  // The runtime health check is a script piped into `bun run -`, so that one invocation is the real
  // Bun: it is what decides whether the run carries on. Everything else Bun would start is faked.
  await writeExecutable(
    join(fakeBin, "bun"),
    '#!/usr/bin/env bash\nif [ "$1" = run ] && [ "$2" = - ]; then exec "$REAL_BUN" "$@"; fi\nexit 0\n',
  );
  // What `python3` is on a stock Windows machine: the Microsoft Store alias, which runs nothing. A
  // script that still needed it would stop at the health check in every test in this file.
  await writeExecutable(
    join(fakeBin, "python3"),
    '#!/usr/bin/env bash\necho "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases." >&2\nexit 49\n',
  );

  try {
    const child = Bun.spawn({
      cmd: [shell, "scripts/start.sh"],
      cwd: directory,
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        REAL_BUN: process.execPath,
        PKILL_LOG: logPath,
        DOCKER_LOG: dockerLogPath,
        CURL_LOG: curlLogPath,
        ...processEnvironment,
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
    const dockerLog = await Bun.file(dockerLogPath)
      .text()
      .catch(() => "");
    const curlLog = await Bun.file(curlLogPath)
      .text()
      .catch(() => "");
    return { exitCode, stdout, stderr, pkillLog, dockerLog, curlLog };
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

describe("start.sh runtime health", () => {
  /**
   * THE LICENCE IS CHECKED WITHOUT PYTHON.
   *
   * The check used to be a `python3` heredoc. On Windows `python3` is usually the Microsoft Store
   * alias, which exits 49, so `set -e` ended the run at "3/4 Runtime health" with the server and
   * worker already up and the app never started. The fake `python3` beside this file's other fakes
   * is that alias; the line below is only printed if the check ran, in Bun, and passed.
   */
  test("checks the licence and names the Bots without python3", async () => {
    const result = await runStartWithStaleServerProbe(401);

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain(
      "licence valid · mode test · Bots: analyst",
    );
  });
});

describe("start.sh under the wrong shell", () => {
  /**
   * THE WRONG INVOCATION SAYS SO, AND SAYING NOTHING IS THE DEFECT.
   *
   * CRITERION. `sh scripts/start.sh` exits non-zero having named bash and the command to run
   * instead, on stderr.
   *
   * REASON. The shebang says bash and `sh` overrides it. On macOS `sh` IS bash, in POSIX mode,
   * where a failed assignment inside a function is fatal instead of survivable — so the script died
   * at the first setting it read out of `.env` and printed NOTHING: no line number, no failing
   * command, no exit message. The whole of what somebody had to go on was `1`, which reads as "this
   * script is broken" rather than "run it the other way", and it cost an afternoon.
   *
   * THE SENTENCE NAMES THE FIX AND NOT ONLY THE FAULT, because "wrong shell" is not actionable to
   * somebody who typed the only invocation they knew.
   */
  test("sh refuses with a sentence naming bash, rather than exiting in silence", async () => {
    const result = await runStartWithStaleServerProbe(401, { shell: "sh" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/bash/);
    expect(result.stderr).toMatch(/bash scripts\/start\.sh/);
    // On stderr rather than stdout, so it survives a caller that is reading the progress output.
    expect(result.stdout).toBe("");
  });
});

describe("start.sh settings with no line in .env", () => {
  /**
   * A KEY THIS SCRIPT HAS A DEFAULT FOR IS ALLOWED TO BE ABSENT, WHICH IS WHAT THE DEFAULT IS FOR.
   *
   * CRITERION. With no `APP_PORT` line in `.env` at all, the run completes exactly as it does with
   * one — the app is probed on 3010, the port the script falls back to.
   *
   * THIS ONE PASSED BEFORE THE CHANGE IT GUARDS, AND THAT IS SAID PLAINLY RATHER THAN DRESSED UP.
   * `setting` reads the key with a `grep` pipeline, `grep` finding nothing is an exit status of 1,
   * and `pipefail` makes it the pipeline's — but under bash that status does not escape the command
   * substitution, so the fallback won and this run was already green. It was fatal only under `sh`,
   * where the sibling test now keeps anybody from arriving at all. So there is no invocation left
   * that can watch this fail, and what it does instead is pin the CONTRACT: the second argument to
   * `setting` is the value an absent key takes, and nothing about which shell is reading the script
   * may decide otherwise.
   *
   * THE `|| true` IN THE SCRIPT IS WHAT MAKES THAT TRUE BY CONSTRUCTION rather than by a subtlety
   * of where `set -e` applies. Both halves are worth having: the refusal stops the invocation that
   * was silently fatal, and this stops the fallback depending on a detail nobody should have to
   * know to add a setting.
   *
   * `APP_PORT` IS THE ONE OMITTED BECAUSE IT IS THE REAL CASE. `.env.example` lists `PORT` and
   * `SERVER_PORT` and not this one, so every `.env` copied from it is missing exactly this key, and
   * it is the first setting the script reads — which is why the silent exit under `sh` happened
   * before any output at all.
   *
   * THE ASSERTION IS THE WHOLE RUN rather than a printed port: the faked `curl` answers the app
   * probe for `http://localhost:3010/` and nothing else, so a fallback that produced any other port
   * fails the run instead of quietly reporting a different number.
   */
  test("a .env with no APP_PORT still starts, on the default port", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      omitFromEnv: ["APP_PORT"],
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("http://localhost:3010");
  });
});

describe("start.sh one computer each", () => {
  /**
   * `OPENBOT_ONE_COMPUTER_EACH=false` IN `.env` TURNS THE SUPERVISOR OFF, AS THE DOCS SAY.
   *
   * The key was read from the environment alone, so a `.env` line was ignored: the supervisor was
   * still started and the server still told to use it. docs/configuration.md says to set it "in
   * `.env` or in the environment", and every other setting in this script is read that way.
   *
   * THE SUPERVISOR IS WHAT GIVES EACH BOT ITS OWN COMPUTER, so its absence from the services handed
   * to `docker compose up` is the observable half; the shared computer stays.
   */
  test("false in .env starts no supervisor", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_ONE_COMPUTER_EACH: "false" },
    });

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.dockerLog).toContain(
      "compose up -d --build postgres agent-computer agent-bot agent-langgraph",
    );
    expect(result.dockerLog).not.toContain("supervisor");
  });

  test("false in the process environment starts no supervisor either", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: { OPENBOT_ONE_COMPUTER_EACH: "true" },
      processEnvironment: { OPENBOT_ONE_COMPUTER_EACH: "false" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).not.toContain("supervisor");
  });

  test("true, or absent, still starts it", async () => {
    for (const omitFromEnv of [[], ["OPENBOT_ONE_COMPUTER_EACH"]] as const) {
      const result = await runStartWithStaleServerProbe(401, { omitFromEnv });

      expect(result.exitCode).toBe(0);
      expect(result.dockerLog).toContain(
        "compose up -d --build postgres supervisor agent-computer agent-bot agent-langgraph",
      );
    }
  });
});

describe("start.sh selected provider services", () => {
  test.each([".env", "process environment"])(
    "an Anthropic-only %s selection starts the managed Bot without the OpenAI-only sample",
    async (source) => {
      const selected = {
        BOT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "synthetic-anthropic-key",
      };
      const result = await runStartWithStaleServerProbe(401, {
        settings: source === ".env" ? selected : { BOT_PROVIDER: "openai" },
        processEnvironment: source === "process environment" ? selected : {},
        unavailableHealthPorts: [4200],
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      expect(result.dockerLog).toContain(
        "compose up -d --build postgres supervisor agent-computer agent-langgraph",
      );
      expect(result.dockerLog).not.toContain("agent-bot");
      expect(result.dockerLog).toContain("compose run --rm --build migrate");
      expect(result.curlLog).toContain("http://localhost:4100/health");
      expect(result.curlLog).toContain("http://localhost:4201/health");
      expect(result.curlLog).not.toContain("http://localhost:4200/health");
      expect(result.stdout).toContain("agent-bot: skipped for Anthropic");
      expect(result.stdout).not.toContain("agent-bot ready");
      expect(result.stdout).toContain("agent-langgraph ready");
      expect(result.stdout).toContain(
        "managed coworker endpoint: http://localhost:4201/ag-ui",
      );
      expect(result.stdout).toContain("Ready. http://localhost:3010");
    },
  );

  test("the default OpenAI startup still starts and checks the legacy sample", async () => {
    const result = await runStartWithStaleServerProbe(401);
    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).toContain(
      "compose up -d --build postgres supervisor agent-computer agent-bot agent-langgraph",
    );
    expect(result.curlLog).toContain("http://localhost:4200/health");
    expect(result.stdout).toContain("agent-bot ready");
    expect(result.stdout).not.toContain("agent-bot: skipped");
  });

  test("Anthropic startup still fails if its managed LangGraph Bot is unavailable", async () => {
    const result = await runStartWithStaleServerProbe(401, {
      settings: {
        BOT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "synthetic-anthropic-key",
      },
      unavailableHealthPorts: [4200, 4201],
    });
    expect(result.exitCode).toBe(1);
    expect(result.curlLog).not.toContain("http://localhost:4200/health");
    expect(result.curlLog).toContain("http://localhost:4201/health");
    expect(result.stdout).toContain("agent-langgraph never became ready");
    expect(result.stdout).not.toContain("Ready. http://localhost:3010");
  });
});
