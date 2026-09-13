import { expect, test } from "bun:test";
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

function composeFile() {
  return readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );
}

function rootDockerfile() {
  return readFileSync(join(import.meta.dir, "..", "Dockerfile"), "utf8");
}

function agentComputerDockerfile() {
  return readFileSync(
    join(import.meta.dir, "..", "agent-computer", "Dockerfile"),
    "utf8",
  );
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

function runComposeConfig(env: Record<string, string>) {
  const output = execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "--profile",
      "harness",
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
        environment: Record<string, string>;
        extra_hosts?: string[];
        volumes?: Array<{ type: string; source: string; target: string }>;
      }
    >;
  };
}

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
    ["BOT_PORT", "4200", "4200"],
    ["LANGGRAPH_PORT", "4201", "4201"],
  ] as const;

  for (const [name, host, container] of published) {
    expect(compose).toContain(`\${${name}:-${host}}:${container}`);
  }
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
    "BOT_PORT",
    "LANGGRAPH_PORT",
    "PICKED_HARNESS_PORT",
  ]) {
    const published = [
      ...compose.matchAll(
        new RegExp(`^\\s*- "([^"\\n]*)\\$\\{${name}:-\\d+\\}:[^"\\n]+"`, "gm"),
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
    for (const service of ["agent-bot", "agent-langgraph", "agent-harness"]) {
      expect(config.services[service].environment.OPENAI_BASE_URL).toBe(
        expected,
      );
    }
  });
}

test("preserves the framework Bot's other provider endpoints", () => {
  const compose = composeFile();
  for (const variable of [
    "ANTHROPIC_BASE_URL",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
  ]) {
    expect(compose).toContain(`${variable}: \${${variable}:-}`);
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
    BOT_MODEL: "gpt-5.5",
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

test("enables pgvector before creating vector columns", () => {
  const migration = readFileSync(
    join(import.meta.dir, "..", "server", "drizzle", "0000_schema.sql"),
    "utf8",
  );

  // The order is the property, not the first line. A `vector` column cannot be created before the
  // extension that defines the type, and a generated migration has no reason to put them in that
  // order on its own.
  const extension = migration.indexOf("CREATE EXTENSION IF NOT EXISTS vector;");
  const firstVectorColumn = migration.search(/"embedding" vector\(/);
  expect(extension).toBeGreaterThanOrEqual(0);
  expect(firstVectorColumn).toBeGreaterThan(extension);
});

test("runs migrations after PostgreSQL becomes healthy", () => {
  const compose = composeFile();

  expect(compose).toContain("migrate:");
  expect(compose).toContain("condition: service_healthy");
  expect(compose).toContain('"drizzle-kit", "migrate"');
});

test("builds the deployment image with Playwright's Chromium payload only", () => {
  for (const dockerfile of [rootDockerfile(), agentComputerDockerfile()]) {
    expect(dockerfile).toContain(
      "FROM node:24.18.1-bookworm-slim AS node-toolchain",
    );
    expect(dockerfile).toContain("FROM ubuntu:24.04");
    expect(dockerfile).not.toContain("mcr.microsoft.com/playwright");
    expect(dockerfile).toContain("ARG PLAYWRIGHT_VERSION=1.62.1");
    expect(dockerfile).toContain("ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright");
    expect(dockerfile).toContain(
      "COPY --from=node-toolchain /usr/local /usr/local",
    );
    expect(dockerfile).toContain(
      'bunx --bun "playwright@' +
        "$" +
        "{PLAYWRIGHT_VERSION}" +
        '" install --with-deps chromium',
    );
    expect(dockerfile).not.toMatch(/\bnodejs\b|\bnpm\b/);
    expect(dockerfile).not.toMatch(
      /\binstall(?:\s+--with-deps)?\s+(firefox|webkit)\b/,
    );
  }

  const compose = composeFile();
  expect(compose).toContain(
    [
      "agent-computer:",
      "    build:",
      "      context: .",
      "      dockerfile: agent-computer/Dockerfile",
    ].join("\n"),
  );
});

test("takes Bun from the same immutable release in both computer images", () => {
  const { packageManager } = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  );
  const bunVersion = packageManager.replace("bun@", "");
  const sources = [];
  for (const dockerfile of [rootDockerfile(), agentComputerDockerfile()]) {
    const source = dockerfile.match(
      /^FROM (oven\/bun:\S+) AS bun-toolchain$/m,
    )?.[1];
    expect(source).toMatch(
      new RegExp(
        `^oven/bun:${bunVersion.replaceAll(".", "\\.")}@sha256:[a-f0-9]{64}$`,
      ),
    );
    expect(dockerfile).toContain(
      "COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun",
    );
    expect(dockerfile).not.toContain("bun.sh/install");
    expect(dockerfile).not.toMatch(/\b(?:curl|wget)\b[^\n]*\|\s*(?:bash|sh)\b/);
    sources.push(source);
  }
  expect(sources[0]).toBe(sources[1]);
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

test("gives the selected harness the same governed callback as the framework Bot", () => {
  const config = runComposeConfig({
    OPENBOT_TOOL_URL: "http://callback.example/api/agent-tools/call",
    AGENT_TOOL_TOKEN: "synthetic-callback-token",
  });
  for (const service of ["agent-harness", "agent-langgraph"] as const) {
    expect(config.services[service].environment).toMatchObject({
      OPENBOT_TOOL_URL: "http://callback.example/api/agent-tools/call",
      AGENT_TOOL_TOKEN: "synthetic-callback-token",
    });
    expect(config.services[service].extra_hosts).toContain(
      "host.docker.internal=host-gateway",
    );
  }
});
