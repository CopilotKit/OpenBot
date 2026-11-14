import { beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

function composeFile() {
  return readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );
}

/** The file as Compose reads it before interpolation: every `${...}` is still text. */
function composeServices() {
  return (
    parse(composeFile()) as {
      services: Record<
        string,
        {
          profiles?: string[];
          image?: string;
          build?: { context: string; dockerfile: string };
          entrypoint?: string[];
          command?: string[];
          working_dir?: string;
          env_file?: Array<{ path: string; required: boolean }>;
          environment?: Record<string, string>;
          depends_on?: Record<string, { condition: string }>;
          restart?: string;
          networks?: string[];
          user?: string;
          volumes?: Array<
            | string
            | {
                type: string;
                source: string;
                target: string;
                bind?: { create_host_path?: boolean };
              }
          >;
        }
      >;
    }
  ).services;
}

function runLangGraphAguiModelProbe(
  openaiBaseUrl: string | undefined,
  options: {
    botProvider?: string;
    botModel?: string;
    openaiApiKey?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "openbot-langgraph-agui-"));
  try {
    writeFileSync(
      join(dir, "ag_ui_langgraph.py"),
      [
        "class LangGraphAgent:",
        "    def __init__(self, **kwargs):",
        "        pass",
        "",
        "def add_langgraph_fastapi_endpoint(**kwargs):",
        "    pass",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "probe.py"),
      [
        "import json",
        "import os",
        "import sys",
        "from types import ModuleType",
        "from ag_ui_langgraph import LangGraphAgent",
        // This probe tests provider configuration without framework dependencies.
        // Real tool execution is covered by the Python protocol regressions.
        "tools = ModuleType('src.tool_runtime')",
        "tools.ToolAwareAgent = LangGraphAgent",
        "tools.bind_tools = tools.execute_tools = tools.next_step = lambda *args: None",
        "tools.billing_refusal = tools.provider_message = tools.provider_refusal = lambda *args, **kwargs: None",
        "from types import SimpleNamespace",
        // No run chose a model or effort, so the deployment's own configuration applies.
        "tools.current_tools = lambda: SimpleNamespace(model='', effort='')",
        "tools.model_messages = lambda messages: messages",
        "sys.modules['src.tool_runtime'] = tools",
        "from src import main",
        "chosen = main._model()",
        "print(json.dumps({'base_url': os.environ.get('OPENAI_BASE_URL'), **chosen}))",
        "",
      ].join("\n"),
    );
    mkdirSync(join(dir, "langchain"), { recursive: true });
    writeFileSync(
      join(dir, "langchain", "chat_models.py"),
      [
        "def init_chat_model(model, *, model_provider=None):",
        "    return {'model': model, 'model_provider': model_provider}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "langchain", "__init__.py"), "");
    mkdirSync(join(dir, "fastapi"), { recursive: true });
    writeFileSync(
      join(dir, "fastapi", "__init__.py"),
      [
        "class FastAPI:",
        "    def middleware(self, *_args, **_kwargs):",
        "        def decorator(fn):",
        "            return fn",
        "        return decorator",
        "    def get(self, *_args, **_kwargs):",
        "        def decorator(fn):",
        "            return fn",
        "        return decorator",
        "",
        "class Request:",
        "    pass",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "fastapi", "responses.py"),
      [
        "class JSONResponse:",
        "    def __init__(self, *args, **kwargs):",
        "        self.args = args",
        "        self.kwargs = kwargs",
        "",
      ].join("\n"),
    );
    mkdirSync(join(dir, "langgraph", "checkpoint"), { recursive: true });
    writeFileSync(
      join(dir, "langgraph", "graph.py"),
      [
        "START = 'start'",
        "END = 'end'",
        "MessagesState = dict",
        "class StateGraph:",
        "    def __init__(self, *_args, **_kwargs):",
        "        pass",
        "    def add_node(self, *_args, **_kwargs):",
        "        pass",
        "    def add_edge(self, *_args, **_kwargs):",
        "        pass",
        "    def add_conditional_edges(self, *_args, **_kwargs):",
        "        pass",
        "    def compile(self, **_kwargs):",
        "        return object()",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "langgraph", "__init__.py"), "");
    writeFileSync(join(dir, "langgraph", "checkpoint", "__init__.py"), "");
    writeFileSync(
      join(dir, "langgraph", "checkpoint", "memory.py"),
      ["class MemorySaver:", "    pass", ""].join("\n"),
    );
    // The ChatGPT plan's model list (`chatgpt_models`) imports httpx at module level. The probe
    // only builds a model, so a stand-in is enough, like the packages above.
    writeFileSync(
      join(dir, "httpx.py"),
      [
        "class AsyncClient:",
        "    def __init__(self, *_args, **_kwargs):",
        "        pass",
        "",
      ].join("\n"),
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BOT_MODEL: options.botModel ?? "gpt-test",
      OPENAI_API_KEY: options.openaiApiKey ?? "sk-test",
      PYTHONPATH: `${dir}:${join(import.meta.dir, "..", "agent-langgraph-agui")}`,
    };
    delete env.CHATGPT_AUTH_FILE;
    if (options.botProvider !== undefined) {
      env.BOT_PROVIDER = options.botProvider;
    } else {
      delete env.BOT_PROVIDER;
    }
    if (openaiBaseUrl === undefined) {
      delete env.OPENAI_BASE_URL;
    } else {
      env.OPENAI_BASE_URL = openaiBaseUrl;
    }
    const result: {
      base_url: string | null;
      model: string;
      model_provider: string | null;
    } = JSON.parse(
      execFileSync("python3", [join(dir, "probe.py")], {
        env,
        encoding: "utf8",
      }),
    );
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runComposeConfig(
  env: Record<string, string>,
  desktop = false,
  userOverride?: string,
) {
  const output = execFileSync(
    "docker",
    [
      "compose",
      ...(desktop
        ? [
            "-f",
            "docker-compose.yml",
            "-f",
            "desktop/src-tauri/telemetry.compose.yml",
            ...(userOverride ? ["-f", userOverride] : []),
            ...([env.COPILOTKIT_TELEMETRY_DISABLED, env.DO_NOT_TRACK].some(
              (value) => value === "1" || value === "true",
            )
              ? ["-f", "desktop/src-tauri/telemetry-disabled.compose.yml"]
              : []),
          ]
        : []),
      "--env-file",
      "/dev/null",
      "--profile",
      "harness",
      "--profile",
      "openbot",
      "config",
      "--format",
      "json",
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        PICKED_HARNESS_IMAGE: "openbot-agent-langgraph-agui:test",
        ...env,
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(output) as {
    services: Record<
      string,
      {
        image?: string;
        entrypoint?: string[] | null;
        command?: string[] | null;
        working_dir?: string;
        healthcheck?: { disable?: boolean; test?: string[] };
        environment: Record<string, string>;
        extra_hosts?: string[];
        volumes?: Array<{ type: string; source: string; target: string }>;
      }
    >;
  };
}

test("passes desktop identity, metadata and opt-out into the server container", () => {
  const telemetry = {
    CPK_TELEMETRY_ID: "12345678-1234-4123-8123-123456789012",
    COPILOTKIT_TELEMETRY_SAMPLE_RATE: "1",
    COPILOTKIT_TELEMETRY_URL: "http://127.0.0.1:4321/ingest",
    OPENBOT_DISTRIBUTION: "desktop",
    OPENBOT_VERSION: "1.0.0",
    OPENBOT_PLATFORM: "macos",
    OPENBOT_ARCH: "aarch64",
    OPENBOT_OS_VERSION: "26.0",
    OPENBOT_ENGINE: "docker",
    COPILOTKIT_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    OPENBOT_PRODUCT_TELEMETRY: "0",
  };
  const enterprise = runComposeConfig(telemetry).services;
  for (const key of Object.keys(telemetry)) {
    expect(enterprise.server.environment[key]).toBeUndefined();
  }
  const services = runComposeConfig(
    {
      ...telemetry,
      OPENBOT_ACCOUNT_EMAIL: "synthetic@example.invalid",
      OPENBOT_PROMPT: "synthetic private content",
    },
    true,
  ).services;
  for (const [key, value] of Object.entries(telemetry)) {
    expect(services.server.environment[key]).toBe(value);
    expect(services["agent-computer"].environment[key]).toBeUndefined();
  }
  expect(services.server.environment.OPENBOT_ACCOUNT_EMAIL).toBeUndefined();
  expect(services.server.environment.OPENBOT_PROMPT).toBeUndefined();
  const overlay = parse(
    readFileSync(
      join(import.meta.dir, "../desktop/src-tauri/telemetry.compose.yml"),
      "utf8",
    ),
  );
  expect(Object.keys(overlay.services)).toEqual(["server"]);
  expect(Object.keys(overlay.services.server.environment).sort()).toEqual(
    Object.keys(telemetry).sort(),
  );
  // Telemetry configuration must not change the local server's runtime mode.
  expect(services.server.environment.NODE_ENV).toBe("");
});

test("keeps a server opt-out from the user's Compose override", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-telemetry-override-"));
  try {
    const override = join(dir, "custom.yml");
    writeFileSync(
      override,
      'services:\n  server:\n    environment:\n      DO_NOT_TRACK: "1"\n      OPENBOT_PRODUCT_TELEMETRY: "0"\n',
    );
    const env = runComposeConfig(
      { OPENBOT_DISTRIBUTION: "desktop" },
      true,
      override,
    ).services.server.environment;
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.OPENBOT_PRODUCT_TELEMETRY).toBe("0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native opt-out wins over a Compose override that enables telemetry", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbot-native-opt-out-"));
  try {
    const override = join(dir, "custom.yml");
    writeFileSync(
      override,
      'services:\n  server:\n    environment:\n      DO_NOT_TRACK: "0"\n      COPILOTKIT_TELEMETRY_DISABLED: "0"\n      OPENBOT_PRODUCT_TELEMETRY: "1"\n',
    );
    for (const key of ["DO_NOT_TRACK", "COPILOTKIT_TELEMETRY_DISABLED"]) {
      for (const value of ["true", "1"]) {
        const env = runComposeConfig({ [key]: value }, true, override).services
          .server.environment;
        expect(env.COPILOTKIT_TELEMETRY_DISABLED).toBe("1");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaves optional telemetry settings absent for ordinary Compose startup", () => {
  const env = runComposeConfig({}).services.server.environment;
  for (const key of [
    "CPK_TELEMETRY_ID",
    "COPILOTKIT_TELEMETRY_URL",
    "OPENBOT_DISTRIBUTION",
    "OPENBOT_PRODUCT_TELEMETRY",
    "COPILOTKIT_TELEMETRY_DISABLED",
    "DO_NOT_TRACK",
  ]) {
    expect(env[key] ?? undefined).toBeUndefined();
  }
});

// `docker compose config` pays a one-off cold start on the first call in a process — the Compose
// plugin initialising and resolving every image reference — which is several seconds on a loaded CI
// runner and a fraction of that once warm. A test that happened to be the first to call it was
// eating that cost inside its own 5s timeout and flaking, while every later test ran in well under a
// second. Absorb the cold start once here, under a timeout that has room for it, so no individual
// test carries it.
beforeAll(() => {
  runComposeConfig({});
}, 60_000);

/**
 * Older Compose (v2.24.5, for one) validates every service before it applies profiles, so one
 * service whose image comes out blank fails the whole project, profile or not. The desktop app
 * runs `compose config` before it starts anything, so on those versions Start stopped with
 * "Compose config exited with exit status: 15" whenever no harness was picked.
 *
 * Current Compose applies the same check to every service a profile turns on, so turning them all
 * on with nothing set is how this suite sees what older Compose sees. CI also runs v2.24.5 itself.
 */
test("gives every service a real image when nothing is set, so older Compose reads the file", () => {
  const output = execFileSync(
    "docker",
    [
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "desktop/src-tauri/telemetry.compose.yml",
      "-f",
      "desktop/src-tauri/telemetry-disabled.compose.yml",
      "--env-file",
      "/dev/null",
      "--profile",
      "*",
      "config",
      "--format",
      "json",
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const services = (
    JSON.parse(output) as { services: Record<string, { image?: string }> }
  ).services;
  expect(Object.keys(services)).toContain("agent-harness");
  const blank = Object.entries(services)
    .filter(([, service]) => !service.image?.trim())
    .map(([name]) => name);
  expect(blank).toEqual([]);
});

/**
 * SPIRE issued each Bot's computer a workload identity that nothing ever checked, so it went: no
 * service, volume, setting or mount for it, and the supervisor is not told where one would be.
 */
test("runs no SPIRE", () => {
  const services = composeServices();
  const mentions = /spire|spiffe/i;
  expect(Object.keys(services).filter((name) => mentions.test(name))).toEqual(
    [],
  );
  const volumes = Object.keys(
    (parse(composeFile()) as { volumes?: Record<string, unknown> }).volumes ??
      {},
  );
  expect(volumes.filter((name) => mentions.test(name))).toEqual([]);
  for (const [name, service] of Object.entries(services)) {
    const settings = Object.keys(service.environment ?? {});
    const mounts = (service.volumes ?? []).map((volume) =>
      typeof volume === "string" ? volume : volume.source,
    );
    expect({
      name,
      found: [...settings, ...mounts].filter((entry) => mentions.test(entry)),
    }).toEqual({ name, found: [] });
  }
});

/**
 * The managed Bot is the LangGraph harness. agent-bot, a proof of concept that wrote the protocol by
 * hand, and the TypeScript agent-langgraph were retired; the fintech example's Risk Analyst is
 * registered at MANAGED_AGENT_AG_UI_URL, so the address the server is given must name a service
 * this file starts, built from a harness this repository has, on the port its image listens on.
 */
test("runs the LangGraph harness as the managed Bot, and neither retired Bot", () => {
  const services = composeServices();
  // Both names are still in the file for one release, behind a profile nothing turns on, so an app
  // from the release before can read it (tests/older-apps.test.ts). Neither is run: with every
  // profile anything asks for, Compose brings up neither, and neither is built from this tree.
  const run = Object.keys(runComposeConfig({}).services);
  for (const retired of ["agent-bot", "agent-langgraph"]) {
    expect(run).not.toContain(retired);
    expect(services[retired]?.profiles).toEqual(["for-older-apps"]);
    expect(services[retired]?.build).toBeUndefined();
  }
  const address = new URL(
    runComposeConfig({
      MANAGED_AGENT_AG_UI_URL: "http://127.0.0.1:4201/",
    }).services.server.environment.MANAGED_AGENT_AG_UI_URL ?? "",
  );
  const managed = services[address.hostname];
  expect(managed?.build?.dockerfile).toBe("agent-langgraph-agui/Dockerfile");
  const dockerfile = readFileSync(
    join(import.meta.dir, "..", "agent-langgraph-agui", "Dockerfile"),
    "utf8",
  );
  expect(address.port).toBe(/^EXPOSE (\d+)$/m.exec(dockerfile)?.[1]);
});

test("provides PostgreSQL with pgvector for local development", () => {
  const compose = composeFile();

  expect(compose).toContain("postgres:");
  expect(compose).toContain("pgvector/pgvector:");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture — this asserts on unexpanded placeholder text, so a real template would break the test.
  expect(compose).toContain("${POSTGRES_PORT:-5432}:5432");
});

/**
 * Every published port is settable, and defaults to the number the documentation gives.
 *
 * `scripts/start.sh` reads these same names to decide where to look for each service.
 */
test("publishes every service on a settable port with the documented default", () => {
  const compose = composeFile();

  const published = [
    ["POSTGRES_PORT", "5432", "5432"],
    ["COMPUTER_PORT", "4100", "4100"],
    ["SUPERVISOR_PORT", "4500", "4300"],
    ["LANGGRAPH_PORT", "4201", "4206"],
    ["SERVER_PORT", "3001", "3001"],
  ] as const;

  for (const [name, host, container] of published) {
    expect(compose).toContain(`\${${name}:-${host}}:${container}`);
  }
  // One process behind both: the server serves the built app on its own port, unless
  // SERVER_APP_PORT is set empty, which is how scripts/start.sh leaves APP_PORT to the checkout's app.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture.
  expect(compose).toContain("${SERVER_APP_PORT-${APP_PORT:-3010}}:3001");
});

/**
 * The services that answer to a secret are published to the host's loopback and no further.
 *
 * A published port with no interface in front of it binds every address the host has, so the
 * service answers anything that can route to the machine. That is the wrong default for all of
 * these and worst for the supervisor, which holds the Docker socket: reaching it is root on the
 * host by way of four verbs, and `SUPERVISOR_TOKEN` is a shared secret rather than a network
 * boundary. The computer says the same thing about itself in a comment beside its own port, and
 * this is that reasoning applied to every service that has one.
 *
 * Named ports rather than a blanket rule, so adding a service is a decision about where it should
 * answer rather than something this test quietly grants.
 */
test("publishes every service that holds a secret on loopback only", () => {
  const compose = composeFile();

  for (const name of [
    "POSTGRES_PORT",
    "SUPERVISOR_PORT",
    "COMPUTER_PORT",
    "LANGGRAPH_PORT",
    "PICKED_HARNESS_PORT",
    "APP_PORT",
    "SERVER_PORT",
  ]) {
    const published = [
      ...compose.matchAll(
        new RegExp(
          `^\\s*- "([^"\\n]*?)\\$\\{(?:SERVER_APP_PORT-\\$\\{)?${name}:-\\d+\\}\\}?:[^"\\n]+"`,
          "gm",
        ),
      ),
    ];
    expect(published.length).toBeGreaterThan(0);
    for (const mapping of published) {
      expect(["127.0.0.1:", "[::1]:"]).toContain(mapping[1]);
    }
  }
});

/**
 * The host reads OPENAI_BASE_URL directly; containers can need a different route to that model.
 * Exercise Compose's nested interpolation so all shipped Bots and the picked harness receive the
 * override when present and keep the host fallback when it is absent or explicitly cleared.
 */
const compatibleEndpointCases: Array<{
  name: string;
  environment: Record<string, string>;
  expected: string;
}> = [
  {
    name: "uses the container override ahead of the host endpoint",
    environment: {
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      OPENAI_CONTAINER_BASE_URL: "http://model-service:11434/v1",
    },
    expected: "http://model-service:11434/v1",
  },
  {
    name: "uses the host endpoint when the container override is unset",
    environment: { OPENAI_BASE_URL: "https://models.example/v1" },
    expected: "https://models.example/v1",
  },
  {
    name: "uses the host endpoint when the container override is cleared",
    environment: {
      OPENAI_BASE_URL: "https://models.example/v1",
      OPENAI_CONTAINER_BASE_URL: "",
    },
    expected: "https://models.example/v1",
  },
  {
    name: "leaves the endpoint empty when neither route is configured",
    environment: {},
    expected: "",
  },
];

for (const { name, environment, expected } of compatibleEndpointCases) {
  test(`every Bot ${name}`, () => {
    const config = runComposeConfig({
      OPENAI_API_KEY: "synthetic-openai-key",
      ...environment,
    });
    for (const service of ["agent-langgraph-agui", "agent-harness"]) {
      expect(config.services[service].environment.OPENAI_BASE_URL).toBe(
        expected,
      );
    }
  });
}

test("passes every other provider's key and endpoint into the managed Bot and the picked harness", () => {
  const config = runComposeConfig({
    ANTHROPIC_API_KEY: "sk-ant-synthetic",
    ANTHROPIC_BASE_URL: "https://anthropic-gateway.example",
    GOOGLE_API_KEY: "synthetic-google",
    GOOGLE_GENERATIVE_AI_BASE_URL: "https://generativelanguage.example/v1beta",
  });

  // A service either receives the variable or it does not; reading the file's text cannot tell
  // the difference, because any one service declaring it would satisfy a raw `toContain`.
  for (const service of ["agent-langgraph-agui", "agent-harness"]) {
    expect(config.services[service].environment).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-synthetic",
      ANTHROPIC_BASE_URL: "https://anthropic-gateway.example",
      GOOGLE_API_KEY: "synthetic-google",
      GOOGLE_GENERATIVE_AI_BASE_URL:
        "https://generativelanguage.example/v1beta",
    });
  }
});

test("normalizes the picked LangGraph harness's blank OpenAI endpoint before model construction", () => {
  expect(runLangGraphAguiModelProbe("").base_url).toBeNull();
  expect(runLangGraphAguiModelProbe("   ").base_url).toBeNull();
  expect(runLangGraphAguiModelProbe("http://127.0.0.1:4310/v1").base_url).toBe(
    "http://127.0.0.1:4310/v1",
  );
});

test("passes the selected Anthropic provider and model into the picked harness", () => {
  const config = runComposeConfig({
    ANTHROPIC_API_KEY: "sk-ant-synthetic",
    ANTHROPIC_BASE_URL: "https://anthropic-gateway.example",
    BOT_PROVIDER: "anthropic",
    BOT_MODEL: "claude-sonnet-4-5",
    OPENAI_API_KEY: "",
  });

  expect(config.services["agent-harness"].environment).toMatchObject({
    ANTHROPIC_API_KEY: "sk-ant-synthetic",
    ANTHROPIC_BASE_URL: "https://anthropic-gateway.example",
    BOT_PROVIDER: "anthropic",
    BOT_MODEL: "claude-sonnet-4-5",
    OPENAI_API_KEY: "",
  });

  expect(
    runLangGraphAguiModelProbe(undefined, {
      botProvider: "anthropic",
      botModel: "claude-sonnet-4-5",
      openaiApiKey: "",
    }),
  ).toMatchObject({
    model: "claude-sonnet-4-5",
    model_provider: "anthropic",
  });

  const openaiConfig = runComposeConfig({
    OPENAI_API_KEY: "sk-openai-synthetic",
    OPENAI_BASE_URL: "https://openai-compatible.example/v1",
  });
  expect(openaiConfig.services["agent-harness"].environment).toMatchObject({
    OPENAI_API_KEY: "sk-openai-synthetic",
    OPENAI_BASE_URL: "https://openai-compatible.example/v1",
    BOT_PROVIDER: "openai",
    // Unset arrives as unset: the server, not a stand-in here, decides the model.
    BOT_MODEL: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_BASE_URL: "",
  });
});

test("mounts the ChatGPT token store directory into the picked harness", () => {
  const config = runComposeConfig({
    CHATGPT_AUTH_FILE: "/root/.langchain/chatgpt-auth.json",
  });

  expect(config.services["agent-harness"].environment).toMatchObject({
    CHATGPT_AUTH_FILE: "/root/.langchain/chatgpt-auth.json",
  });
  expect(config.services["agent-harness"].volumes).toContainEqual(
    expect.objectContaining({
      type: "bind",
      target: "/root/.langchain",
    }),
  );
  expect(config.services["agent-harness"].volumes).not.toContainEqual(
    expect.objectContaining({
      type: "bind",
      target: "/root/.langchain/chatgpt-auth.json",
    }),
  );
});

/**
 * The server, the computer and the supervisor are pulled, never built: the published OpenBot
 * images, at the one tag backend-images.env names, read as OPENBOT_BACKEND_TAG. The server and the
 * computer are one image, `openbot`, started with a command each; the supervisor is its own. Each
 * is still overridable by its own setting, which is how OpenBot Desktop pins a release's digests.
 */
test("runs the server and the computer from the one published image, and the supervisor from its own", () => {
  const services = composeServices();
  const images = {
    server: ["openbot", "SERVER_IMAGE"],
    "agent-computer": ["openbot", "COMPUTER_IMAGE"],
    supervisor: ["openbot-supervisor", "SUPERVISOR_IMAGE"],
  } as const;
  for (const [name, [image, variable]] of Object.entries(images)) {
    expect(services[name].build).toBeUndefined();
    expect(services[name].image).toBe(
      `\${${variable}:-ghcr.io/copilotkit/${image}:\${OPENBOT_BACKEND_TAG:-see-backend-images.env}}`,
    );
    expect(services[name].pull_policy).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture.
      "${IMAGE_PULL_POLICY:-missing}",
    );
  }
  // Each Bot's computer runs the image the shared one does.
  expect(services.supervisor.environment?.COMPUTER_IMAGE).toBe(
    services["agent-computer"].image,
  );

  const pinned = /^OPENBOT_BACKEND_TAG=(\S+)$/m.exec(
    readFileSync(join(import.meta.dir, "..", "backend-images.env"), "utf8"),
  )?.[1];
  expect(pinned).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/);
  const config = runComposeConfig({ OPENBOT_BACKEND_TAG: pinned ?? "" });
  expect(config.services["agent-computer"].image).toBe(
    `ghcr.io/copilotkit/openbot:${pinned}`,
  );
  expect(config.services.server.image).toBe(
    config.services["agent-computer"].image,
  );
});

/**
 * The OpenBot image started with no command is the whole of OpenBot in one container: a server, a
 * computer beside it and the process that minds them. So every service on it names the executable
 * for the one part it is, as its entrypoint, which is what drops the image's own. Read from what
 * Compose itself resolves, with a release's one pinned image under both settings.
 */
test("starts each service on the OpenBot image as its own part of it, never as the whole image", () => {
  const pinned = `ghcr.io/copilotkit/openbot@sha256:${"1".repeat(64)}`;
  const { services } = runComposeConfig({
    SERVER_IMAGE: pinned,
    COMPUTER_IMAGE: pinned,
  });
  expect(services.server.image).toBe(pinned);
  expect(services["agent-computer"].image).toBe(pinned);
  expect(services.supervisor.environment?.COMPUTER_IMAGE).toBe(pinned);

  expect(services.server.entrypoint).toEqual(["/app/bin/openbot", "server"]);
  expect(services.server.command ?? null).toBeNull();
  expect(services.server.working_dir).toBe("/app/server");
  expect(services["agent-computer"].entrypoint).toEqual([
    "/app/bin/openbot-computer",
  ]);
  expect(services["agent-computer"].command ?? null).toBeNull();
  // The image's own PORT is the server's, so the computer is told its own.
  expect(services["agent-computer"].environment?.PORT).toBe("4100");

  // And each answers for its own health, or says it has none to answer for. The image's own check
  // asks after a server on its port, so a service left with it that is not the server (the worker
  // an app from the release before starts) is unhealthy for ever, and `up --wait` fails on it.
  for (const [name, service] of Object.entries(services)) {
    if (service.image !== pinned) continue;
    const check = service.healthcheck;
    expect({
      name,
      own: check?.disable === true || (check?.test?.length ?? 0) > 0,
    }).toEqual({ name, own: true });
  }

  // Every other service on that image names an executable too.
  for (const [name, service] of Object.entries(services)) {
    if (service.image !== pinned) continue;
    expect({ name, entrypoint: service.entrypoint?.[0] }).toEqual({
      name,
      entrypoint:
        name === "agent-computer"
          ? "/app/bin/openbot-computer"
          : "/app/bin/openbot",
    });
  }
});

/**
 * A Bot has a shell in its computer, and the image there now carries the server's executable. What
 * keeps that harmless is that the computer is a container of its own, given only what is written
 * under it: none of the deployment's `.env`, no database address, no key, no licence.
 */
test("gives the computer's container none of the server's settings", () => {
  const secrets = {
    KEY_ENCRYPTION_KEY: "sentinel-key-encryption-key",
    BETTER_AUTH_SECRET: "sentinel-better-auth-secret",
    COPILOTKIT_LICENSE_TOKEN: "sentinel-licence",
    CPK_INTELLIGENCE_API_KEY: "sentinel-project-key",
    INTELLIGENCE_API_KEY: "sentinel-intelligence-key",
    OPENAI_API_KEY: "sentinel-openai-key",
    ANTHROPIC_API_KEY: "sentinel-anthropic-key",
    COMPOSIO_API_KEY: "sentinel-composio-key",
    SUPERVISOR_TOKEN: "sentinel-supervisor-token",
    AGENT_TOOL_TOKEN: "sentinel-agent-tool-token",
    MANAGED_AGENT_TOKEN: "sentinel-managed-agent-token",
  };
  const { services } = runComposeConfig(secrets);
  const computer = JSON.stringify(services["agent-computer"]);
  for (const [name, value] of Object.entries(secrets)) {
    expect(computer).not.toContain(name);
    expect(computer).not.toContain(value);
  }
  expect(computer).not.toContain("DATABASE_URL");
  // The control: the same settings do reach the server.
  const server = JSON.stringify(services.server);
  expect(server).toContain("sentinel-key-encryption-key");
  expect(server).toContain("sentinel-intelligence-key");
  expect(server).toContain("DATABASE_URL");
});

/**
 * The server applies its own migrations when it starts and does its scheduled work itself (firing
 * routines, cleaning up unsent attachments, suspending idle computers). `migrate` and `worker` are
 * still defined, for this one release, so an OpenBot Desktop app from the release before reads the
 * file as current: that app requires a `worker` service and asks for `migrate`'s image by name.
 * Nothing in this release starts either, so nothing waits on one, both sit behind the profile, and
 * neither is handed the secret the worker used to present.
 */
test("still defines migrate and worker for one release, with nothing that waits on either", () => {
  const services = composeServices();

  for (const [name, service] of Object.entries(services)) {
    const waitsOn = Object.keys(service.depends_on ?? {});
    expect({ name, waitsOn }).toEqual({
      name,
      waitsOn: waitsOn.filter(
        (other) => other !== "migrate" && other !== "worker",
      ),
    });
    expect(Object.keys(service.environment ?? {})).not.toContain(
      "WORKER_SHARED_SECRET",
    );
  }
  expect(composeFile()).not.toContain("WORKER_SHARED_SECRET");

  expect(services.worker).toEqual({
    profiles: ["openbot"],
    image: services.server.image,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture.
    pull_policy: "${IMAGE_PULL_POLICY:-missing}",
    entrypoint: ["/app/bin/openbot"],
    command: ["worker"],
    working_dir: "/app/server",
    healthcheck: { disable: true },
    restart: "unless-stopped",
    networks: ["data"],
  });
  expect(services.migrate).toEqual({
    profiles: ["openbot"],
    image: services.server.image,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture.
    pull_policy: "${IMAGE_PULL_POLICY:-missing}",
    entrypoint: ["/app/bin/openbot"],
    command: ["migrate"],
    working_dir: "/app/server",
    healthcheck: { disable: true },
    environment: {
      DATABASE_URL: "postgres://openbot:openbot@postgres:5432/openbot",
    },
    depends_on: { postgres: { condition: "service_healthy" } },
    restart: "no",
    networks: ["data"],
  });
});

/**
 * What tells this file from an earlier release's, in which `worker` and `migrate` are in use: one
 * top-level line. OpenBot Desktop, scripts/start.sh and the updater read it as text, so it is at
 * column 0, once, and Compose (which ignores a top-level `x-` field) still reads the file.
 */
test("says on one top-level line that the server does the scheduled work", () => {
  const marked = composeFile()
    .split("\n")
    .filter((line) => line.startsWith("x-openbot-scheduled-work"));
  expect(marked).toEqual(["x-openbot-scheduled-work: server"]);
  expect(Object.keys(runComposeConfig({}).services)).toContain("server");
});

test("starts the server once PostgreSQL is healthy, because it migrates as it starts", () => {
  const server = composeServices().server;

  expect(server.command).toBeUndefined();
  expect(server.depends_on).toEqual({
    postgres: { condition: "service_healthy" },
  });
});

/**
 * Per-Bot egress reaches the processes that read it.
 *
 * `EGRESS_PROXY_<BOT>` and `EGRESS_PROXY_DEFAULT` are resolved from `process.env` by the computer
 * itself (`agent-computer/src/egress.ts`), and the supervisor forwards every `EGRESS_PROXY` key out
 * of its own environment into each computer it creates (`supervisor/src/index.ts`). Compose gives a
 * container only what its `environment:` and `env_file:` blocks name, and for a long time neither
 * named these, so an operator who configured a proxy per the documentation got a browser that went
 * out directly and no error saying so.
 *
 * A file rather than `environment:` entries because the names are per-Bot and therefore not knowable
 * here, and a file of its own rather than `.env` because that one holds the deployment's secrets and
 * the browser container is deliberately not given them.
 */
test("carries per-Bot egress into the computer and the supervisor", () => {
  const compose = composeFile();

  // Both halves: the shared computer reads them itself, and the supervisor passes them on.
  const services = compose.split(/^ {2}(?=\S)/m);
  for (const name of ["agent-computer:", "supervisor:"]) {
    const service = services.find((block) => block.startsWith(name));
    expect(service).toBeDefined();
    expect(service).toContain("egress.env");
  }

  // Optional, because a deployment with no proxy is the ordinary case and must still start.
  expect(compose).toContain("required: false");
});

/**
 * The personal edition's one computer is its one person's (scripts/start.sh sets `COMPUTER_PERSON_ID`), so Record runs
 * in their Bots' browsers there. Anywhere else it is unset, and the shared computer stays nobody's.
 */
test("starts the shared computer as one person's only when told whose it is", () => {
  expect(
    runComposeConfig({ COMPUTER_PERSON_ID: "personal" }).services[
      "agent-computer"
    ]?.environment.COMPUTER_PERSON_ID,
  ).toBe("personal");
  expect(
    runComposeConfig({}).services["agent-computer"]?.environment
      .COMPUTER_PERSON_ID,
  ).toBe("");
});

/**
 * The personal edition's one computer runs the person's own browser beside their Bots, which it knows from the edition
 * (agent-computer's person-access.ts): the edition in `.env` has to reach it, as it reaches the server.
 */
/**
 * A Recorder in the shared computer is handed the laptop's loopback addresses for OpenBot and a local gateway, which in
 * that container are the container: OpenBot Desktop names where each is reached instead, and the computer relays them
 * (agent-computer's loopback-relay.ts). The setting, and the host the gateway's relay names, have to reach it.
 */
test("hands the shared computer the loopback addresses it relays, and this machine by name", () => {
  const computer = runComposeConfig({
    COMPUTER_LOOPBACK_RELAYS:
      "3010=server:3001,14401=host.docker.internal:14401",
  }).services["agent-computer"];
  expect(computer?.environment.COMPUTER_LOOPBACK_RELAYS).toBe(
    "3010=server:3001,14401=host.docker.internal:14401",
  );
  expect(computer?.extra_hosts).toEqual(["host.docker.internal=host-gateway"]);
  expect(
    runComposeConfig({}).services["agent-computer"]?.environment
      .COMPUTER_LOOPBACK_RELAYS,
  ).toBe("");
});

test("tells the shared computer which edition it runs in", () => {
  expect(
    runComposeConfig({ OPENBOT_EDITION: "personal" }).services["agent-computer"]
      ?.environment.OPENBOT_EDITION,
  ).toBe("personal");
  expect(
    runComposeConfig({}).services["agent-computer"]?.environment
      .OPENBOT_EDITION,
  ).toBe("");
});

test("gives the selected harness the same governed callback as the managed Bot", () => {
  const config = runComposeConfig({
    OPENBOT_TOOL_URL: "http://callback.example/api/agent-tools/call",
    AGENT_TOOL_TOKEN: "synthetic-callback-token",
  });
  for (const service of ["agent-harness", "agent-langgraph-agui"] as const) {
    expect(config.services[service].environment).toMatchObject({
      OPENBOT_TOOL_URL: "http://callback.example/api/agent-tools/call",
      AGENT_TOOL_TOKEN: "synthetic-callback-token",
    });
    expect(config.services[service].extra_hosts).toContain(
      "host.docker.internal=host-gateway",
    );
  }
});

/**
 * Rootless Podman on Linux gives `host-gateway` an address that is not this machine's loopback, where
 * the person's browser and a local Intelligence listen. OpenBot Desktop sets `OPENBOT_HOST_GATEWAY`
 * there, to the address its Podman configuration maps to loopback, and every service that calls the
 * host by name takes it.
 */
test("sends host.docker.internal where OPENBOT_HOST_GATEWAY says", () => {
  const config = runComposeConfig({ OPENBOT_HOST_GATEWAY: "10.0.2.2" });
  for (const service of [
    "server",
    "agent-harness",
    "agent-langgraph-agui",
  ] as const) {
    expect(config.services[service].extra_hosts).toContain(
      "host.docker.internal=10.0.2.2",
    );
  }
});

/**
 * OpenBot's own server, started by name.
 *
 * A plain `docker compose up -d` starts what it always did; `scripts/start.sh` and an installed
 * OpenBot name it. The profile is what keeps it out of the plain run; naming the service is
 * still enough to start it.
 */
test("keeps OpenBot's own server behind a profile, restarted by Docker", () => {
  const server = composeServices().server;

  expect(server.profiles).toEqual(["openbot"]);
  // Restarted by Docker, because nothing on the host is watching it.
  expect(server.restart).toBe("unless-stopped");
});

/**
 * Every address the server is given names a service on its network.
 *
 * `.env` says `127.0.0.1` and `localhost`, which is right for a server on the host and means the
 * container itself inside one. The settings in `environment:` win over that file, so these are what
 * the server actually uses.
 */
test("gives the server container addresses, not the host's loopback", () => {
  const server = composeServices().server;
  const environment = server.environment ?? {};

  expect(server.env_file).toEqual([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture.
    { path: "${OPENBOT_SERVER_ENV_FILE:-./.env}", required: false },
  ]);
  expect(environment).toMatchObject({
    PORT: "3001",
    SERVER_PORT: "3001",
    DATABASE_URL: "postgres://openbot:openbot@postgres:5432/openbot",
    AGENT_COMPUTER_URL: "http://agent-computer:4100",
  });
  for (const [name, value] of Object.entries(environment)) {
    expect(`${name}=${value}`).not.toMatch(/localhost|127\.0\.0\.1|\[::1\]/);
  }
  // Production refuses `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS`, which a local OpenBot needs.
  expect(environment.NODE_ENV).toBe("");
});

/**
 * The supervisor by name unless the deployment says there is none.
 *
 * Unset is every deployment that predates the setting. Set empty is OpenBot Desktop, which runs the
 * personal edition on one computer, and that edition refuses to start with a supervisor.
 */
test("gives the server the supervisor unless the deployment empties it", () => {
  expect(
    runComposeConfig({}).services.server?.environment.COMPUTER_SUPERVISOR_URL,
  ).toBe("http://supervisor:4300");
  const none = runComposeConfig({ COMPUTER_SUPERVISOR_CONTAINER_URL: "" })
    .services.server?.environment;
  expect(none?.COMPUTER_SUPERVISOR_URL ?? "").toBe("");
  expect(none?.AGENT_COMPUTER_URL).toBe("http://agent-computer:4100");
});

test("puts the server beside the database and the Bots, and nothing a Bot can reach beside the database", () => {
  const services = composeServices();

  expect(services.server.networks).toEqual(["data", "default"]);
  const besideTheDatabase = Object.entries(services)
    .filter(([, service]) => service.networks?.includes("data"))
    .map(([name]) => name);
  // `migrate` and `worker` for this one release, on `data` alone, as they always were.
  expect(besideTheDatabase.sort()).toEqual([
    "migrate",
    "postgres",
    "server",
    "worker",
  ]);
});

test("hands the desktop's host-access token to the server and nothing else", () => {
  const holders = Object.entries(composeServices())
    .filter(([, service]) =>
      Object.keys(service.environment ?? {}).includes(
        "OPENBOT_DESKTOP_HOST_TOKEN",
      ),
    )
    .map(([name]) => name);

  expect(holders).toEqual(["server"]);
});

test("addresses the server's Bots and endpoints from inside the network", () => {
  const withBots = runComposeConfig({
    MANAGED_AGENT_AG_UI_URL: "http://127.0.0.1:4201/",
    PICKED_HARNESS_URL: "http://127.0.0.1:4202/run",
    PICKED_HARNESS_CONTAINER_URL: "http://agent-harness:4202/run",
    OPENAI_BASE_URL: "http://127.0.0.1:3001/api/model-provider/v1",
    OPENAI_CONTAINER_BASE_URL:
      "http://host.docker.internal:3001/api/model-provider/v1",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:14401",
    INTELLIGENCE_CONTAINER_GATEWAY_WS_URL: "ws://host.docker.internal:14401",
    OPENBOT_THIS_MACHINE_CONTAINER_HOST: "host.docker.internal",
  });
  expect(withBots.services.server.environment).toMatchObject({
    // How the server reaches an agent the person registered on their own loopback.
    OPENBOT_THIS_MACHINE_HOST: "host.docker.internal",
    MANAGED_AGENT_AG_UI_URL: "http://agent-langgraph-agui:4206/",
    PICKED_HARNESS_URL: "http://agent-harness:4202/run",
    OPENAI_BASE_URL: "http://host.docker.internal:3001/api/model-provider/v1",
    // The server's own way to the gateway, and the browser's, which is on the host.
    INTELLIGENCE_GATEWAY_WS_URL: "ws://host.docker.internal:14401",
    INTELLIGENCE_BROWSER_GATEWAY_WS_URL: "ws://localhost:14401",
  });

  // No managed Bot stays no managed Bot, and a remote harness keeps its own address.
  const without = runComposeConfig({
    MANAGED_AGENT_AG_UI_URL: "",
    PICKED_HARNESS_URL: "https://agents.example/run",
  });
  expect(without.services.server.environment).toMatchObject({
    OPENBOT_THIS_MACHINE_HOST: "",
    MANAGED_AGENT_AG_UI_URL: "",
    PICKED_HARNESS_URL: "https://agents.example/run",
  });
});

/**
 * A Google or xAI sign-in is a file the server renews itself, so it reaches the container as the
 * folder it sits in: the renewal writes a sibling and renames it over the original.
 */
test("mounts the model sign-in folder into the server, and only there", () => {
  const services = composeServices();
  const server = services.server;

  expect(server.volumes).toContainEqual({
    type: "bind",
    source: "./.openbot",
    target: "/openbot",
    bind: { create_host_path: false },
  });
  expect(server.environment?.OPENBOT_MODEL_OAUTH_FILE).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the unexpanded placeholder is what is asserted.
    "${OPENBOT_MODEL_OAUTH_FILE:+/openbot/model-oauth.json}",
  );
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the unexpanded placeholder is what is asserted.
  expect(server.user).toBe("${OPENBOT_SERVER_USER:-1001:1001}");
  for (const [name, service] of Object.entries(services)) {
    if (name === "server") continue;
    expect(JSON.stringify(service.volumes ?? [])).not.toContain(".openbot");
  }
});

/*
 * A Bot's shell runs `ping` on its computer. iputils' ping carries the `cap_net_raw` file
 * capability, and a process cannot exec a file whose capabilities are outside the container's
 * bounding set. Docker's default set has NET_RAW; Podman's (the Desktop's engine on Windows and the
 * default everywhere) does not, so on Windows `ping 8.8.8.8` answered "Operation not permitted",
 * even as root. The computer asks for NET_RAW itself, so both engines give it the same.
 */
test("the computer is given NET_RAW, so ping works on Podman as on Docker", () => {
  const computer = (
    parse(composeFile()) as {
      services: Record<string, { cap_add?: string[]; cap_drop?: string[] }>;
    }
  ).services["agent-computer"];
  expect(computer?.cap_add ?? []).toContain("NET_RAW");
  expect(computer?.cap_drop ?? []).not.toContain("NET_RAW");
});
