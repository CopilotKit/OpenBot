import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let invokeHandler: Invoke = async () => {
  throw new Error("invoke handler was not installed");
};

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return invokeHandler(command, args);
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));

mock.module("./Mark", () => ({
  Mark: ({ name }: { name: string }) => <span>{name}</span>,
}));

const { App } = await import("./App");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  invokeCalls = [];
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

async function renderApp() {
  let view!: ReturnType<typeof render>;

  await act(async () => {
    view = render(<App />);
  });

  return view;
}

type StartStackPayload = {
  model: {
    provider?: unknown;
    login?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
    model?: unknown;
  };
};

function isStartStackPayload(value: unknown): value is StartStackPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "model" in value &&
    typeof value.model === "object" &&
    value.model !== null
  );
}

function getStartStackPayload() {
  const args = invokeCalls.find((call) => call.command === "start_stack")?.args;
  if (!isStartStackPayload(args)) {
    throw new Error("start_stack payload was not captured");
  }
  return args;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function savedOpenAiConfiguration() {
  return {
    values: {},
    saved: {
      intelligenceApiKey: true,
      modelApiKeys: { openai: true, anthropic: false },
      modelSessions: { openai: false, anthropic: false },
    },
  };
}

function emptyConfiguration() {
  return {
    values: {},
    saved: {
      intelligenceApiKey: false,
      modelApiKeys: { openai: false, anthropic: false },
      modelSessions: { openai: false, anthropic: false },
    },
  };
}

type ExistingConfigurationValues = {
  INTELLIGENCE_API_KEY?: string;
  INTELLIGENCE_API_URL?: string;
  INTELLIGENCE_GATEWAY_WS_URL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_BASE_URL?: string;
};

function useCompatibleEndpointSetup(
  existingValues: ExistingConfigurationValues,
) {
  invokeHandler = async (command) => {
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: existingValues,
        saved: {
          intelligenceApiKey: true,
          modelApiKeys: { openai: true, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
    if (command === "providers") {
      return [
        {
          id: "openai-compatible",
          name: "OpenAI-compatible",
          summary: "Use your own endpoint.",
          logins: ["endpoint"],
          mark: null,
          caution: null,
        },
      ];
    }
    if (command === "prepare_engine") return null;
    if (command === "start_stack") return null;
    throw new Error(`unexpected command ${command}`);
  };
}

async function startWithCompatibleEndpoint(endpointKey = "") {
  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "https://models.example/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "local-model");
  if (endpointKey) {
    await userEvent.type(
      view.getByLabelText("API key, if the endpoint needs one"),
      endpointKey,
    );
  }
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Start OpenBot" }),
  );
}

test("Change the model after an Ask failure stops the stack and reaches the provider picker", async () => {
  invokeHandler = async (command) => {
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: {
          INTELLIGENCE_API_KEY: "ck-test",
          OPENAI_API_KEY: "sk-test",
        },
        saved: {
          intelligenceApiKey: true,
          modelApiKeys: { openai: true, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
    if (command === "providers") {
      return [
        {
          id: "openai",
          name: "OpenAI",
          summary: "Use OpenAI.",
          logins: ["api-key"],
          mark: null,
          caution: null,
        },
      ];
    }
    if (command === "prepare_engine") return null;
    if (command === "start_stack") return null;
    if (command === "ask_the_bot") {
      throw { said: "The model could not answer.", detail: "401" };
    }
    if (command === "stop_stack") return null;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );

  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  await userEvent.click(await view.findByRole("button", { name: "Ask" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Change the model" }),
  );

  await waitFor(() =>
    expect(invokeCalls.some((call) => call.command === "stop_stack")).toBe(
      true,
    ),
  );
  expect(view.getByRole("heading", { name: "Connect your AI" })).toBeTruthy();
  expect(view.getByRole("radio", { name: /OpenAI/ })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Stop OpenBot" })).toBeNull();
});

test("empty Intelligence projects keep sign-in recoverable while Start waits for a project key", async () => {
  let projectLists = 0;
  invokeHandler = async (command) => {
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: {
          OPENAI_API_KEY: "sk-test",
        },
        saved: {
          intelligenceApiKey: false,
          modelApiKeys: { openai: true, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
    if (command === "providers") {
      return [
        {
          id: "openai",
          name: "OpenAI",
          summary: "Use OpenAI.",
          logins: ["api-key"],
          mark: null,
          caution: null,
        },
      ];
    }
    if (command === "begin_intelligence_sign_in") {
      return "https://copilotkit.test/sign-in";
    }
    if (command === "finish_intelligence_sign_in") {
      projectLists += 1;
      if (projectLists === 1) return [];
      return [{ id: "project-1", name: "Project One" }];
    }
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Sign in to CopilotKit" }),
  );

  expect(
    await view.findByText("That account has no projects yet.", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
    "disabled",
    true,
  );

  await userEvent.click(view.getByRole("button", { name: "Sign in again" }));

  expect(await view.findByRole("button", { name: "Project One" })).toBeTruthy();

  await userEvent.click(
    view.getByText("Point at your own Intelligence server"),
  );
  await userEvent.type(view.getByLabelText("Project key"), "ck-test");
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
});

test("saved startup credentials enable Start without raw protected secrets on mount", async () => {
  invokeHandler = async (command) => {
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: {},
        saved: {
          intelligenceApiKey: true,
          modelApiKeys: { openai: true, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
    if (command === "providers") {
      return [
        {
          id: "openai",
          name: "OpenAI",
          summary: "Use OpenAI.",
          logins: ["api-key"],
          mark: null,
          caution: null,
        },
      ];
    }
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(
    invokeCalls.filter((call) => call.command === "already_configured"),
  ).toHaveLength(1);
});

test("root edits reload saved configuration for that root and ignore stale saved responses", async () => {
  const rootA = "/tmp/openbot-root-a";
  const rootB = "/tmp/openbot-root-b";
  const rootC = "/tmp/openbot-root-c";
  const savedForRootA = deferred<ReturnType<typeof savedOpenAiConfiguration>>();
  const emptyForRootB = deferred<ReturnType<typeof emptyConfiguration>>();
  const savedForRootC = deferred<ReturnType<typeof savedOpenAiConfiguration>>();

  invokeHandler = async (command, args) => {
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return rootA;
    if (command === "already_configured") {
      const requestedRoot = (args as { root?: string } | undefined)?.root;
      if (requestedRoot === rootA) return savedForRootA.promise;
      if (requestedRoot === rootB) return emptyForRootB.promise;
      if (requestedRoot === rootC) return savedForRootC.promise;
      throw new Error(`unexpected already_configured root ${requestedRoot}`);
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
    if (command === "providers") {
      return [
        {
          id: "openai",
          name: "OpenAI",
          summary: "Use OpenAI.",
          logins: ["api-key"],
          mark: null,
          caution: null,
        },
      ];
    }
    if (command === "prepare_engine") return null;
    if (command === "start_stack") return null;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderApp();
  await act(async () => {
    savedForRootA.resolve(savedOpenAiConfiguration());
  });

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  expect(view.getByText(/A saved OpenAI API key will be used/)).toBeTruthy();
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );

  const rootField = view.getByLabelText("Where OpenBot lives");
  const user = userEvent.setup({
    document: view.container.ownerDocument,
  });
  await user.clear(rootField);
  await user.type(rootField, rootB);
  await act(async () => {
    rootField.blur();
  });

  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "already_configured"),
    ).toContainEqual({ command: "already_configured", args: { root: rootB } }),
  );
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
    "disabled",
    true,
  );

  await user.clear(rootField);
  await user.type(rootField, rootC);
  await act(async () => {
    rootField.blur();
  });

  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "already_configured"),
    ).toContainEqual({ command: "already_configured", args: { root: rootC } }),
  );
  await act(async () => {
    emptyForRootB.resolve(emptyConfiguration());
  });
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
    "disabled",
    true,
  );

  await act(async () => {
    savedForRootC.resolve(savedOpenAiConfiguration());
  });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));

  expect(getStartStackPayload()).toMatchObject({
    root: rootC,
    model: {
      provider: "openai",
      login: "api-key",
      saved: true,
    },
  });
});

test("bring-your-own agent collects a distinct AG-UI endpoint for startup", async () => {
  invokeHandler = async (command) => {
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: {},
        saved: {
          intelligenceApiKey: true,
          modelApiKeys: { openai: false, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
        {
          id: "byo-url",
          name: "An agent you already run",
          summary: "Give its address.",
          image: null,
          health_path: null,
          credential: "their-endpoint",
          maintainer: "community",
          mark: null,
          port: null,
        },
      ];
    }
    if (command === "providers") {
      return [
        {
          id: "openai-compatible",
          name: "OpenAI-compatible",
          summary: "Use your own endpoint.",
          logins: ["endpoint"],
          mark: null,
          caution: null,
        },
      ];
    }
    if (command === "prepare_engine") return null;
    if (command === "start_stack") return null;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByText("Choose the agent framework"));
  await userEvent.click(
    await view.findByRole("radio", { name: /An agent you already run/ }),
  );

  const continueFromHarness = view.getByRole("button", { name: "Continue" });
  expect(continueFromHarness).toHaveProperty("disabled", true);
  const agentEndpoint = view.getByLabelText("AG-UI endpoint");
  await userEvent.type(agentEndpoint, "https://agent.example/ag-ui");
  await waitFor(() =>
    expect(continueFromHarness).toHaveProperty("disabled", false),
  );
  await userEvent.click(continueFromHarness);

  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "https://models.example/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "local-model");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Start OpenBot" }),
  );

  expect(
    invokeCalls.find((call) => call.command === "start_stack")?.args,
  ).toMatchObject({
    model: {
      provider: "openai-compatible",
      baseUrl: "https://models.example/v1",
      model: "local-model",
    },
    harness: {
      id: "byo-url",
      agentUrl: "https://agent.example/ag-ui",
    },
  });
});

test("custom compatible endpoint startup does not submit a saved OpenAI API key", async () => {
  useCompatibleEndpointSetup({
    OPENAI_API_KEY: "sk-synthetic-openai",
  });

  await startWithCompatibleEndpoint();

  const payload = getStartStackPayload();
  expect(payload.model).toMatchObject({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "https://models.example/v1",
    model: "local-model",
  });
  expect(payload.model).not.toHaveProperty("apiKey");
  expect(JSON.stringify(payload)).not.toContain("sk-synthetic-openai");
});

test("custom compatible endpoint startup submits an explicitly typed endpoint key", async () => {
  useCompatibleEndpointSetup({
    OPENAI_API_KEY: "sk-synthetic-openai",
  });

  await startWithCompatibleEndpoint("endpoint-key");

  const payload = getStartStackPayload();
  expect(payload.model).toMatchObject({
    provider: "openai-compatible",
    login: "endpoint",
    apiKey: "endpoint-key",
    baseUrl: "https://models.example/v1",
    model: "local-model",
  });
  expect(JSON.stringify(payload)).not.toContain("sk-synthetic-openai");
});

for (const provider of [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
] as const) {
  test(`saved ${provider.name} plan session enables Start without raw protected secrets on mount`, async () => {
    invokeHandler = async (command) => {
      if (command === "detect_engine") {
        return {
          engine: "docker",
          responding: true,
          engine_socket: null,
          detail: "Docker is answering.",
        };
      }
      if (command === "default_root") return "/tmp/openbot-app-test";
      if (command === "already_configured") {
        return {
          values: {},
          saved: {
            intelligenceApiKey: true,
            modelApiKeys: { openai: false, anthropic: false },
            modelSessions: {
              openai: provider.id === "openai",
              anthropic: provider.id === "anthropic",
            },
          },
        };
      }
      if (command === "already_running") return false;
      if (command === "windows_blocker") return null;
      if (command === "last_failure") return null;
      if (command === "harnesses") {
        return [
          {
            id: "langgraph",
            name: "LangGraph",
            summary: "Default Bot",
            image: null,
            health_path: null,
            credential: "any-provider",
            maintainer: "first-party",
            mark: null,
            port: 8000,
          },
        ];
      }
      if (command === "providers") {
        return [
          {
            id: provider.id,
            name: provider.name,
            summary: `Use ${provider.name}.`,
            logins: ["plan", "api-key"],
            mark: null,
            caution: null,
          },
        ];
      }
      if (command === "prepare_engine") return null;
      if (command === "start_stack") return null;
      throw new Error(`unexpected command ${command}`);
    };

    const view = await renderApp();

    await userEvent.click(
      await view.findByRole("button", { name: "Set up OpenBot" }),
    );
    await userEvent.click(
      await view.findByRole("button", { name: "Continue" }),
    );
    await userEvent.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    expect(
      view.getByText(new RegExp(`Signed in to ${provider.name}`)),
    ).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Start OpenBot" }),
      ).toHaveProperty("disabled", false),
    );
    await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));

    expect(
      invokeCalls.filter((call) => call.command === "already_configured"),
    ).toEqual([
      {
        command: "already_configured",
        args: { root: "/tmp/openbot-app-test" },
      },
    ]);
    for (const call of invokeCalls) {
      const args = JSON.stringify(call.args ?? {});
      expect(args).not.toContain("OPENAI_API_KEY");
      expect(args).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    }
    expect(
      invokeCalls.find((call) => call.command === "start_stack")?.args,
    ).toMatchObject({
      root: "/tmp/openbot-app-test",
      apiKey: "",
      model: {
        provider: provider.id,
        login: "plan",
        saved: true,
      },
      harness: { id: "langgraph" },
    });
  });
}
