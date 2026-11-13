import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** One setting from the file the server's container was handed, as Compose reads it. */
function serverSetting(file: string, name: string): string | undefined {
  for (const line of file.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(['"])(.*)\2$/.exec(line);
    if (match?.[1] === name) return match[3];
  }
  return undefined;
}

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
  otherWorker?: boolean;
  shell?: "bash" | "sh";
  omitFromEnv?: readonly string[];
  settings?: Record<string, string>;
  processEnvironment?: Record<string, string>;
  unavailableHealthPorts?: readonly number[];
  composioSetup?: "configured" | "failed" | "real-helper" | "real-cli";
  /** What `npx` does when the real helper runs the CopilotKit CLI. */
  cli?: "missing-provision" | "provisions";
  /** The tag `backend-images.env` names in the copied checkout. */
  pinnedTag?: string;
};

async function runStart({
  otherWorker = false,
  shell = "bash",
  omitFromEnv = [],
  settings = {},
  processEnvironment = {},
  unavailableHealthPorts = [],
  composioSetup,
  cli,
  pinnedTag = "sha-pinned-for-the-test",
}: Run = {}) {
  const root =
    await Bun.$`mktemp -d ${tmpdir()}/openbot-start-guard-XXXXXX`.text();
  const directory = root.trim();
  const fakeBin = join(directory, "bin");
  const scripts = join(directory, "scripts");
  const logPath = join(directory, "pkill.log");
  const dockerLogPath = join(directory, "docker.log");
  const curlLogPath = join(directory, "curl.log");
  const serverEnvironmentPath = join(directory, "server-environment.log");
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
  await writeFile(
    join(scripts, "processes.sh"),
    await readFile("scripts/processes.sh"),
  );
  // What the server's container is handed, written by the real script.
  await writeFile(
    join(scripts, "server-env.ts"),
    await readFile("scripts/server-env.ts"),
  );
  // The templates that say which settings the server reads.
  for (const template of [".env.example", ".env.personal.example"])
    await writeFile(join(directory, template), await readFile(template));
  await writeFile(
    join(directory, "backend-images.env"),
    `# The images the test runs.\nOPENBOT_BACKEND_TAG=${pinnedTag}\n`,
  );
  if (composioSetup === "real-cli") {
    // The real helper, unchanged. Bun resolves its imports from the checkout it links to.
    await symlink(
      resolve("scripts/setup-composio.ts"),
      join(scripts, "setup-composio.ts"),
    );
  } else
    await writeFile(
      join(scripts, "setup-composio.ts"),
      `
import { writeFile, readFile } from "node:fs/promises";
import { setupComposio } from ${JSON.stringify(resolve("scripts/setup-composio.ts"))};
const result = await setupComposio({ runCli: async (args) => {
  await writeFile(".env", (await readFile(".env", "utf8")) + "\\nCOMPOSIO_API_KEY=synthetic-project-key\\n");
  return { exitCode: 0, stdout: JSON.stringify({type: "completed", installation_id: args[4], project_id: "project-synthetic", environment_file_written: true, reused: false}) };
} });
console.log(result === "configured" ? "COMPOSIO-CONFIGURED" : "COMPOSIO-PRESERVED");
`,
    );

  // The CopilotKit CLI the real helper starts. One that predates `integrations composio provision`
  // fails the way an old CLI, a signed-out CLI or an Ops without provisioning does.
  await writeExecutable(
    join(fakeBin, "npx"),
    `#!/usr/bin/env bash
# Fixed when written: the helper hands the CLI only an allowlisted environment.
if [ "${cli ?? "missing-provision"}" = provisions ]; then
  while [ $# -gt 0 ]; do
    case "$1" in
      --installation-id) id="$2"; shift ;;
      --env-path) env_path="$2"; shift ;;
    esac
    shift
  done
  printf 'COMPOSIO_API_KEY=synthetic-cli-key\\n' >> "$env_path"
  printf '{"type":"completed","installation_id":"%s","project_id":"pr_synthetic","environment_file_written":true,"reused":false}' "$id"
  exit 0
fi
echo "error: unknown command 'integrations'" >&2
exit 1
`,
  );
  await writeExecutable(
    join(fakeBin, "lsof"),
    `#!/usr/bin/env bash\nif [[ "$*" == *"-d cwd"* ]]; then\n  printf 'p888\\nn/another/openbot\\n'\nelse\n  echo "p123"; echo "cbun"; echo "n*:3001"\nfi\n`,
  );
  await writeExecutable(
    join(fakeBin, "curl"),
    `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "$args" >> "$CURL_LOG"
for port in ${unavailableHealthPorts.join(" ")}; do
  if [[ "$args" == *"http://localhost:$port/health"* ]]; then exit 7; fi
done
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
# A pull says which policy it ran with, and fails when the test asks it to.
if [[ "$args" == *"compose pull"* ]]; then args="$args policy=\${IMAGE_PULL_POLICY:-}"; fi
printf '%s tool=%s network=%s tag=%s\\n' "$args" "$OPENBOT_TOOL_URL" "$COMPUTER_NETWORK" "$OPENBOT_BACKEND_TAG" >> "$DOCKER_LOG"
if [[ "$args" == *"compose pull"* ]] && [ -n "\${TEST_PULL_FAILS:-}" ]; then echo "registry unreachable" >&2; exit 1; fi
# The settings the server's container would be created with, kept for the test to read.
if [[ "$args" == *"up -d --no-deps"*"server worker"* ]]; then cp "$OPENBOT_SERVER_ENV_FILE" "$SERVER_ENVIRONMENT"; fi
if [[ "$args" == *"to_regclass('public.agent_profiles')"* ]]; then echo agent_profiles; fi
if [[ "$args" == *"to_regclass('public.agent_preferences')"* ]]; then echo agent_preferences; fi
exit 0
`,
  );
  await writeExecutable(
    join(fakeBin, "pgrep"),
    `#!/usr/bin/env bash\n${otherWorker ? "echo 888" : ""}\nexit 0\n`,
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
  // The Learning container check answers with one line, which start.sh relays.
  await writeExecutable(
    join(fakeBin, "bun"),
    '#!/usr/bin/env bash\nif [ "$1" = run ] && [ "$2" = - ]; then\n  exec "$REAL_BUN" "$@"\nfi\nif [ "$2" = scripts/server-env.ts ]; then exec "$REAL_BUN" "$@"; fi\nif [ "$1" = scripts/setup-learning.ts ]; then echo "noise"; echo "LEARNING-CHECK $*"; fi\nif [ "$1" = scripts/setup-composio.ts ]; then\n  if [ "$TEST_COMPOSIO_SETUP" = real-helper ] || [ "$TEST_COMPOSIO_SETUP" = real-cli ]; then exec "$REAL_BUN" "$@"; fi\n  if [ "$TEST_COMPOSIO_SETUP" = failed ]; then echo "Composio setup failed. Sign in and retry." >&2; exit 1; fi\n  if [ "$TEST_COMPOSIO_SETUP" = configured ]; then printf "COMPOSIO_API_KEY=synthetic-project-key\\n" >> .env; echo "COMPOSIO-CONFIGURED"; fi\nfi\nexit 0\n',
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
        TEST_COMPOSIO_SETUP: composioSetup ?? "preserved",
        SERVER_ENVIRONMENT: serverEnvironmentPath,
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
    const serverEnvironment = await Bun.file(serverEnvironmentPath)
      .text()
      .catch(() => "");
    const envFile = await Bun.file(join(directory, ".env")).text();
    return {
      exitCode,
      stdout,
      stderr,
      pkillLog,
      dockerLog,
      curlLog,
      serverEnvironment,
      envFile,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("start.sh and a server an earlier start ran on the host", () => {
  /**
   * The faked `lsof` says a `bun` holds the server's port and the faked `curl` answers there as
   * OpenBot: a server and its routine worker left running on the host by a start from before the
   * server ran in a container. They are stopped by the commands they were started with, so the
   * container can have the port, and then the container is started.
   */
  test("stops it and its worker, then starts the server's container", async () => {
    const result = await runStart();

    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.pkillLog).toContain(
      "bun --env-file=../.env src/production-entry.ts",
    );
    expect(result.pkillLog).toContain("bun --env-file=../.env src/index.ts");
    expect(result.pkillLog).toContain("bun worker/src/index.ts");
    expect(result.dockerLog).toContain("compose up -d --no-deps server worker");
  });
});

describe("start.sh automatic Composio setup", () => {
  test.each(["", " \t "])(
    "a blank exported Composio key (%j) leaves the server the provisioned key",
    async (value) => {
      const result = await runStart({
        composioSetup: "real-helper",
        processEnvironment: { COMPOSIO_API_KEY: value },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("COMPOSIO-CONFIGURED");
      expect(serverSetting(result.serverEnvironment, "COMPOSIO_API_KEY")).toBe(
        "synthetic-project-key",
      );
      expect(result.stdout + result.stderr).not.toContain(
        "synthetic-project-key",
      );
    },
  );

  test.each([
    [
      "supplied Composio",
      { COMPOSIO_API_KEY: "existing-composio" },
      {},
      { COMPOSIO_API_KEY: "existing-composio" },
    ],
    [
      "saved Composio behind a blank export",
      { COMPOSIO_API_KEY: "   " },
      { COMPOSIO_API_KEY: "saved-composio" },
      { COMPOSIO_API_KEY: "saved-composio" },
    ],
    [
      "Arcade",
      { COMPOSIO_API_KEY: "" },
      { ARCADE_API_KEY: "existing-arcade", OPENBOT_BROKER_PROVIDER: "arcade" },
      { ARCADE_API_KEY: "existing-arcade" },
    ],
  ] as const)(
    "the server is started with %s",
    async (_, processEnvironment, settings, expected) => {
      const result = await runStart({
        composioSetup: "real-helper",
        processEnvironment,
        settings,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("COMPOSIO-PRESERVED");
      for (const [name, value] of Object.entries(expected))
        expect(serverSetting(result.serverEnvironment, name)).toBe(value);
    },
  );

  test("provisions without Learning configuration and restarts a server to reload its environment", async () => {
    const result = await runStart({
      composioSetup: "configured",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("COMPOSIO-CONFIGURED");
    expect(result.stdout).toContain(
      "a secret was generated this run, so the server is restarted",
    );
    expect(result.stdout).not.toContain("LEARNING-CHECK");
  });

  /**
   * PROVISIONING IS BEST-EFFORT, LIKE LEARNING. It ran under `set -e`, so a checkout with no
   * Composio key could not start at all while offline, signed out of the CLI, on a CLI without
   * `integrations composio provision`, or against an Ops without the provisioning service.
   */
  test("starts with apps unavailable and the helper's reason when provisioning cannot complete", async () => {
    const result = await runStart({
      composioSetup: "failed",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Composio: apps are unavailable this run. Composio setup failed. Sign in and retry.",
    );
    expect(result.dockerLog).toContain("up -d");
    expect(result.stdout).toContain("server ready");
    expect(result.stdout).not.toContain(
      "a secret was generated this run, so the server is restarted",
    );
  });

  test("the real helper with a CLI that cannot provision leaves startup running", async () => {
    const result = await runStart({
      composioSetup: "real-cli",
      cli: "missing-provision",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Composio: apps are unavailable this run. Composio project setup did not complete.",
    );
    expect(result.stdout + result.stderr).not.toContain("unknown command");
    expect(result.dockerLog).toContain("up -d");
    expect(result.stdout).toContain("server ready");
    expect(result.envFile).not.toContain("COMPOSIO_API_KEY");
    expect(result.stdout).not.toContain(
      "a secret was generated this run, so the server is restarted",
    );
  });

  test("the real helper with a CLI that provisions restarts a running server for the new key", async () => {
    const result = await runStart({
      composioSetup: "real-cli",
      cli: "provisions",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Composio: project key configured in .env.",
    );
    expect(result.envFile).toContain("COMPOSIO_API_KEY=synthetic-cli-key");
    expect(result.stdout).toContain(
      "a secret was generated this run, so the server is restarted",
    );
    expect(result.stdout + result.stderr).not.toContain("synthetic-cli-key");
  });
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
    const result = await runStart();

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
    const result = await runStart({ shell: "sh" });

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
    const result = await runStart({
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
    const result = await runStart({
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
    const result = await runStart({
      settings: { OPENBOT_ONE_COMPUTER_EACH: "true" },
      processEnvironment: { OPENBOT_ONE_COMPUTER_EACH: "false" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).not.toContain("supervisor");
  });

  test("true, or absent, still starts it", async () => {
    for (const omitFromEnv of [[], ["OPENBOT_ONE_COMPUTER_EACH"]] as const) {
      const result = await runStart({ omitFromEnv });

      expect(result.exitCode).toBe(0);
      expect(result.dockerLog).toContain(
        "compose up -d --build postgres supervisor agent-computer agent-bot agent-langgraph",
      );
    }
    // Two whole starts, one after the other.
  }, 20_000);
});

describe("start.sh Learning container check", () => {
  /**
   * The server assigns `openbot` once it exists, but its runtime key cannot create it. start.sh asks
   * the setup helper, without a browser or a prompt, to make sure it exists, and relays its last line.
   */
  test.each(["INTELLIGENCE_API_KEY", "CPK_INTELLIGENCE_API_KEY"])(
    "runs the non-interactive check when %s is set",
    async (keyName) => {
      const result = await runStart({
        settings: { [keyName]: "cpk-synthetic" },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "LEARNING-CHECK scripts/setup-learning.ts --non-interactive",
      );
      expect(result.stdout).not.toContain("noise");
    },
  );

  test.each([
    [
      "a container is named",
      { CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "mine" },
    ],
    ["it is switched off", { OPENBOT_LEARNING_AUTO_ASSIGN: "false" }],
    ["it is switched off with 0", { OPENBOT_LEARNING_AUTO_ASSIGN: "0" }],
  ])("is skipped when %s", async (_, settings) => {
    const result = await runStart({
      settings: { INTELLIGENCE_API_KEY: "cpk-synthetic", ...settings },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("LEARNING-CHECK");
  });

  test("is skipped without a runtime key", async () => {
    const result = await runStart();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("LEARNING-CHECK");
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
      const result = await runStart({
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
      expect(result.dockerLog).toContain("compose run --rm migrate");
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
    const result = await runStart();
    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).toContain(
      "compose up -d --build postgres supervisor agent-computer agent-bot agent-langgraph",
    );
    expect(result.curlLog).toContain("http://localhost:4200/health");
    expect(result.stdout).toContain("agent-bot ready");
    expect(result.stdout).not.toContain("agent-bot: skipped");
  });

  test("Anthropic startup still fails if its managed LangGraph Bot is unavailable", async () => {
    const result = await runStart({
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

describe("start.sh and the OpenBot images", () => {
  /**
   * The server, the worker, the migrations, the computer and the supervisor all run from the
   * published OpenBot images, at the one tag `backend-images.env` names. Compose reads it as
   * OPENBOT_BACKEND_TAG, so every Compose call the script makes is handed it.
   */
  test("runs every Compose service at the tag backend-images.env names", async () => {
    const result = await runStart({ pinnedTag: "sha-from-the-file" });

    expect(result.exitCode).toBe(0);
    const calls = result.dockerLog.trim().split("\n");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toEndWith(" tag=sha-from-the-file");
    expect(result.dockerLog).toContain("compose run --rm migrate");
    expect(result.dockerLog).toContain("compose up -d --no-deps server worker");
  });

  /**
   * The server is on the Compose network, so the Bots call their tools back at `server:3001` and
   * the supervisor attaches each Bot's computer to that network. Both are told before they start:
   * a container keeps what it was started with.
   */
  test("tells the Bots and the supervisor where the server is before they start", async () => {
    const result = await runStart();

    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).toContain(
      "compose up -d --build postgres supervisor agent-computer agent-bot agent-langgraph tool=http://server:3001/api/agent-tools/call network=openbot_default tag=",
    );
  });

  /**
   * `main` moves with every build, so a checkout of main must run the build that is current, not a
   * copy pulled the week before. Compose's own policy keeps a copy it already has, so start.sh
   * fetches the images itself, before anything starts from them.
   */
  test("fetches the OpenBot images at the tag on every start, before anything starts", async () => {
    const result = await runStart({ pinnedTag: "main" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("OpenBot images: main");
    const pull = result.dockerLog.indexOf(
      "compose pull --quiet migrate supervisor agent-computer policy=always",
    );
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(
      result.dockerLog.indexOf("compose up -d --build"),
    );
  });

  test("offline, it starts from the copies already on this machine", async () => {
    const result = await runStart({
      processEnvironment: { TEST_PULL_FAILS: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Could not fetch the OpenBot images at sha-pinned-for-the-test",
    );
    expect(result.dockerLog).toContain("compose up -d --no-deps server worker");
  });

  test("IMAGE_PULL_POLICY=never fetches nothing", async () => {
    const result = await runStart({
      processEnvironment: { IMAGE_PULL_POLICY: "never" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.dockerLog).not.toContain("compose pull");
    expect(result.dockerLog).toContain("compose up -d --no-deps server worker");
  });

  test("a tag in .env or the environment runs another build", async () => {
    for (const run of [
      { settings: { OPENBOT_BACKEND_TAG: "sha-from-env-file" } },
      { processEnvironment: { OPENBOT_BACKEND_TAG: "sha-from-env-file" } },
    ]) {
      const result = await runStart(run);
      expect(result.exitCode).toBe(0);
      expect(result.dockerLog).toMatch(
        /compose up -d --no-deps server worker .* tag=sha-from-env-file\n/,
      );
    }
    // Two whole starts, one after the other.
  }, 20_000);

  test("with no tag at all it says so and starts nothing", async () => {
    const result = await runStart({ pinnedTag: "" });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "backend-images.env names no OPENBOT_BACKEND_TAG",
    );
    expect(result.dockerLog).toBe("");
  });

  /**
   * The server runs in a container, which is handed only what is named for it. It gets `.env` with
   * whatever the environment sets winning, as Bun gave it on the host, and the addresses of what
   * runs on this machine as the container reaches them.
   */
  test("hands the server .env with the environment on top, and this machine's addresses", async () => {
    const result = await runStart({
      settings: {
        OPENAI_BASE_URL: "http://127.0.0.1:46400/v1",
        OPENBOT_LEARNING_AUTO_ASSIGN: "true",
      },
      processEnvironment: {
        OPENBOT_LEARNING_AUTO_ASSIGN: "false",
        OPENBOT_MODEL_CAPABILITIES_URL: "off",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(
      serverSetting(result.serverEnvironment, "OPENBOT_LEARNING_AUTO_ASSIGN"),
    ).toBe("false");
    expect(
      serverSetting(result.serverEnvironment, "OPENBOT_MODEL_CAPABILITIES_URL"),
    ).toBe("off");
    expect(serverSetting(result.serverEnvironment, "MANAGED_AGENT_TOKEN")).toBe(
      "managed-token",
    );
  });
});
