import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";

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

function setupEvents() {
  return invokeCalls
    .filter((call) => call.command === "record_setup_event")
    .map((call) => call.args);
}

test("setup records telemetry without a consent gate and deduplicates viewed steps", async () => {
  useRootConfigurationSetup("/tmp/private-setup-root", async () =>
    emptyConfiguration(),
  );
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "record_setup_event") return null;
    return previous(command, args);
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });

  expect(view.queryByRole("checkbox")).toBeNull();
  expect(view.queryByRole("switch")).toBeNull();
  expect(setupEvents()).toEqual([
    { event: { kind: "step_viewed", step: "welcome" } },
  ]);
  await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(setupEvents()).toEqual([
    { event: { kind: "step_viewed", step: "welcome" } },
    { event: { kind: "step_viewed", step: "harness" } },
    { event: { kind: "harness_chosen", harness: "langgraph" } },
    { event: { kind: "step_viewed", step: "model" } },
  ]);
  await userEvent.click(view.getByRole("button", { name: "Back" }));
  expect(setupEvents().at(-1)).toEqual({
    event: { kind: "step_viewed", step: "harness" },
  });
});

test("setup records only model categories and reaches Ask when telemetry is unavailable", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "record_setup_event") throw new Error("offline");
    return previous(command, args);
  };
  const privateUrl = "https://private-model.example/v1";
  const privateKey = "synthetic-secret-endpoint-key";
  const view = await enterCompatibleEndpoint(privateUrl, privateKey);
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(setupEvents()).toContainEqual({
    event: {
      kind: "model_chosen",
      provider: "compatible",
      credential_path: "api_key",
      custom_base_url: true,
    },
  });
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  await view.findByRole("button", { name: "Ask" });
  expect(setupEvents().at(-1)).toEqual({
    event: { kind: "step_viewed", step: "ask" },
  });
  const serialized = JSON.stringify(setupEvents());
  for (const privateValue of [
    privateUrl,
    privateKey,
    "local-model",
    "/tmp/openbot-app-test",
  ]) {
    expect(serialized).not.toContain(privateValue);
  }
  expect(view.queryByText(/Nothing here leaves this computer/)).toBeNull();
});

type StartStackPayload = {
  root?: unknown;
  apiKey?: unknown;
  apiUrl?: unknown;
  gatewayWsUrl?: unknown;
  harness?: unknown;
  model: {
    provider?: unknown;
    login?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
    containerBaseUrl?: unknown;
    model?: unknown;
    saved?: unknown;
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

function useRootConfigurationSetup(
  rootA: string,
  loadConfiguration: (root: string) => Promise<unknown>,
) {
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
    if (command === "selected_root") return null;
    if (command === "already_configured") {
      if (
        typeof args !== "object" ||
        args === null ||
        !("root" in args) ||
        typeof args.root !== "string"
      ) {
        throw new Error("already_configured requires a root");
      }
      return loadConfiguration(args.root);
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
}

test("Windows detection failure blocks setup and displays its diagnostic", async () => {
  useRootConfigurationSetup("/tmp/openbot-windows-detection-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  const problem = {
    said: "OpenBot could not check Windows virtualization support.",
    detail: "powershell exited with 17: synthetic CIM access denied",
  };
  invokeHandler = async (command, args) => {
    if (command === "windows_blocker") throw problem;
    return setupHandler(command, args);
  };

  const view = await renderApp();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(problem.said);
  await userEvent.click(view.getByText("Technical details"));
  expect(alert.textContent).toContain(problem.detail);
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(
    view.queryByText(/firmware settings|wsl --install|wsl --update/),
  ).toBeNull();
  expect(
    invokeCalls.some((call) => call.command === "windows_blocker_instruction"),
  ).toBe(false);
});

test("a failed Windows blocker instruction is visible instead of an empty blocker", async () => {
  useRootConfigurationSetup("/tmp/openbot-windows-detection-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "windows_blocker") return "wsl-absent";
    if (command === "windows_blocker_instruction") {
      throw { said: "The blocker instruction could not be read." };
    }
    return setupHandler(command, args);
  };
  const view = await renderApp();
  expect((await view.findByRole("alert")).textContent).toContain(
    "The blocker instruction could not be read.",
  );
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
});

test("a successfully detected missing WSL feature keeps its setup instruction", async () => {
  useRootConfigurationSetup("/tmp/openbot-windows-detection-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  const instruction =
    "Run wsl --install, restart Windows, and start OpenBot again.";
  invokeHandler = async (command, args) => {
    if (command === "windows_blocker") return "wsl-absent";
    if (command === "windows_blocker_instruction") return instruction;
    return setupHandler(command, args);
  };
  const view = await renderApp();
  expect(await view.findByText(instruction)).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
});

test("disabled Virtual Machine Platform displays its feature-specific fix and blocks setup", async () => {
  useRootConfigurationSetup("/tmp/openbot-vmp-detection-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  const instruction =
    "Virtual Machine Platform is switched off. Open Windows Terminal or PowerShell as an administrator, run `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, restart Windows, and start OpenBot again.";
  invokeHandler = async (command, args) => {
    if (command === "windows_blocker")
      return "virtual-machine-platform-disabled";
    if (command === "windows_blocker_instruction") {
      expect(args).toEqual({ blocker: "virtual-machine-platform-disabled" });
      return instruction;
    }
    return setupHandler(command, args);
  };
  const view = await renderApp();
  expect(await view.findByText(instruction)).toBeTruthy();
  expect(
    view.getByRole("heading", {
      name: "Virtual Machine Platform is switched off",
    }),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(
    invokeCalls.some((call) =>
      ["prepare_engine", "start_stack"].includes(call.command),
    ),
  ).toBe(false);
});

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

async function enterCompatibleEndpoint(
  baseUrl: string,
  endpointKey = "",
  containerBaseUrl = "",
) {
  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(view.getByLabelText("Base URL"), baseUrl);
  if (containerBaseUrl) {
    await userEvent.type(
      view.getByLabelText("Container Base URL, if different"),
      containerBaseUrl,
    );
  }
  await userEvent.type(view.getByLabelText("Model name"), "local-model");
  if (endpointKey) {
    await userEvent.type(
      view.getByLabelText("API key, if the endpoint needs one"),
      endpointKey,
    );
  }
  return view;
}

async function startWithCompatibleEndpoint(
  endpointKey = "",
  baseUrl = "https://models.example/v1",
  containerBaseUrl = "",
) {
  const view = await enterCompatibleEndpoint(
    baseUrl,
    endpointKey,
    containerBaseUrl,
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Start OpenBot" }),
  );
}

function useSavedCompatibleEndpointSetup(
  baseUrl = "https://models.example/v1",
  model = "saved-model",
  keyed = true,
  savedModel = "compatible-endpoint",
  containerBaseUrl: string | undefined = undefined,
) {
  useCompatibleEndpointSetup({});
  const setupHandler = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "already_configured") {
      return {
        values: {
          OPENAI_BASE_URL: baseUrl,
          ...(containerBaseUrl === undefined
            ? {}
            : { OPENAI_CONTAINER_BASE_URL: containerBaseUrl }),
          BOT_MODEL: model,
        },
        saved: {
          intelligenceApiKey: true,
          model: savedModel,
          modelApiKeys: { compatible: keyed },
          modelSessions: {},
        },
      };
    }
    return setupHandler(command, args);
  };
}

test.each([true, false])(
  "saved compatible endpoint reaches Start with scoped public fields (keyed=%s)",
  async (keyed) => {
    useSavedCompatibleEndpointSetup(undefined, undefined, keyed);
    const view = await renderApp();
    await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(view.getByLabelText("Base URL")).toHaveProperty(
      "value",
      "https://models.example/v1",
    );
    expect(view.getByLabelText("Model name")).toHaveProperty(
      "value",
      "saved-model",
    );
    expect(
      view.getByLabelText("API key, if the endpoint needs one"),
    ).toHaveProperty("value", "");
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    );
    await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(getStartStackPayload()).toEqual({
      root: "/tmp/openbot-app-test",
      apiKey: "",
      apiUrl: "https://api.intelligence.copilotkit.ai",
      gatewayWsUrl: "wss://realtime.intelligence.copilotkit.ai",
      harness: { id: "langgraph" },
      model: {
        provider: "openai-compatible",
        login: "endpoint",
        baseUrl: "https://models.example/v1",
        model: "saved-model",
        ...(keyed ? { saved: true } : {}),
      },
    });
  },
);

test.each([
  ["", "saved-model"],
  ["https://models.example/v1", ""],
  ["https://models.example/v1", "   "],
  ["ftp://models.example/v1", "saved-model"],
  ["https://", "saved-model"],
])(
  "incomplete saved endpoint stays on the provider screen (%s, %s)",
  async (baseUrl, model) => {
    useSavedCompatibleEndpointSetup(baseUrl, model);
    const view = await renderApp();
    await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
    expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
      false,
    );
  },
);

test("an unsupported saved model kind does not become a startable endpoint", async () => {
  useSavedCompatibleEndpointSetup(
    undefined,
    undefined,
    true,
    "unsupported-model",
  );
  const view = await renderApp();
  await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

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

test("empty Intelligence projects keep sign-in retryable while Start waits for a project key", async () => {
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

test("mount navigates to OpenBot only when the selected root is already owned and running", async () => {
  const root = "/tmp/openbot-owned-running-root";
  useRootConfigurationSetup(root, async () => emptyConfiguration());
  const setupHandler = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "already_running") {
      expect(args).toEqual({ root });
      return true;
    }
    return setupHandler(command, args);
  };

  await renderApp();
  await waitFor(() =>
    expect(invokeCalls).toContainEqual({ command: "show_openbot" }),
  );
});

test("mount leaves setup visible when the shared port answers without selected root ownership", async () => {
  const root = "/tmp/openbot-unowned-running-root";
  useRootConfigurationSetup(root, async () => emptyConfiguration());

  const view = await renderApp();

  expect(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  ).toBeTruthy();
  expect(invokeCalls.some((call) => call.command === "show_openbot")).toBe(
    false,
  );
});

for (const staleProbe of [false, true]) {
  test(`recovery mount keeps setup available after ${staleProbe ? "a stale positive" : "a negative"} adoption probe`, async () => {
    useRootConfigurationSetup("/tmp/openbot-worker-recovery", async () =>
      emptyConfiguration(),
    );
    const setupHandler = invokeHandler;
    const failure = {
      said: "Part of OpenBot (worker) stopped and could not be started again. Try starting OpenBot once more.",
    };
    invokeHandler = async (command, args) => {
      if (command === "already_running") return staleProbe;
      if (command === "last_failure") return failure;
      if (command === "show_openbot") throw failure;
      return setupHandler(command, args);
    };
    const view = await renderApp();
    await waitFor(() =>
      expect(
        invokeCalls.some((call) => call.command === "already_running"),
      ).toBe(true),
    );
    if (staleProbe) {
      await waitFor(() =>
        expect(
          invokeCalls.some((call) => call.command === "show_openbot"),
        ).toBe(true),
      );
    }
    expect(view.getByRole("button", { name: "Set up OpenBot" })).toBeTruthy();
    expect(view.getByRole("alert").textContent).toContain(failure.said);
    expect(view.queryByRole("button", { name: "Stop OpenBot" })).toBeNull();
  });
}

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

async function chooseModelAfterRootEdit(
  view: Awaited<ReturnType<typeof renderApp>>,
  apiKey?: string,
) {
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
    "disabled",
    true,
  );
  await userEvent.click(
    view.getByRole("button", { name: "Change AI connection" }),
  );
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  if (apiKey)
    await userEvent.type(view.getByLabelText("OpenAI API key"), apiKey);
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
}

test("root edits reload saved configuration for that root and ignore stale saved responses", async () => {
  const rootA = "/tmp/openbot-root-a";
  const rootB = "/tmp/openbot-root-b";
  const rootC = "/tmp/openbot-root-c";
  const savedForRootA = deferred<ReturnType<typeof savedOpenAiConfiguration>>();
  const emptyForRootB = deferred<ReturnType<typeof emptyConfiguration>>();
  const savedForRootC = deferred<ReturnType<typeof savedOpenAiConfiguration>>();

  useRootConfigurationSetup(rootA, async (requestedRoot) => {
    if (requestedRoot === rootA) return savedForRootA.promise;
    if (requestedRoot === rootB) return emptyForRootB.promise;
    if (requestedRoot === rootC) return savedForRootC.promise;
    throw new Error(`unexpected already_configured root ${requestedRoot}`);
  });

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
  await chooseModelAfterRootEdit(view);
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

test("same-process setup remount prefers the retained selected root", async () => {
  const rootA = "/tmp/openbot-default-root";
  const rootB = "/tmp/openbot-retained-root";
  useRootConfigurationSetup(rootA, async (requestedRoot) => {
    if (requestedRoot !== rootB)
      throw new Error(`unexpected already_configured root ${requestedRoot}`);
    return savedOpenAiConfiguration();
  });
  const setupHandler = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "selected_root") return rootB;
    return setupHandler(command, args);
  };

  const view = await renderApp();
  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(view.getByLabelText("Where OpenBot lives")).toHaveProperty(
    "value",
    rootB,
  );
  await userEvent.click(
    await view.findByRole("button", { name: "Start OpenBot" }),
  );

  expect(
    invokeCalls.filter((call) => call.command === "already_configured"),
  ).toEqual([{ command: "already_configured", args: { root: rootB } }]);
  expect(getStartStackPayload().root).toBe(rootB);
});

test.each([
  { name: "initial load", pendingRoot: "a", finalRoot: "b", savedModel: false },
  {
    name: "blur-started load",
    pendingRoot: "b",
    finalRoot: "c",
    savedModel: true,
  },
  {
    name: "away-and-back edit",
    pendingRoot: "a",
    finalRoot: "a",
    savedModel: false,
  },
])(
  "root edits invalidate the $name before blur",
  async ({ pendingRoot, finalRoot, savedModel }) => {
    const rootA = "/tmp/openbot-root-a";
    const rootB = "/tmp/openbot-root-b";
    const currentRoot = `/tmp/openbot-root-${finalRoot}`;
    const requests: Array<{
      root: string;
      response: Deferred<ReturnType<typeof savedOpenAiConfiguration>>;
    }> = [];
    useRootConfigurationSetup(rootA, async (root) => {
      const response = deferred<ReturnType<typeof savedOpenAiConfiguration>>();
      requests.push({ root, response });
      return response.promise;
    });

    const view = await renderApp();
    const user = userEvent.setup({ document: view.container.ownerDocument });
    if (savedModel) {
      await act(async () =>
        requests[0].response.resolve(savedOpenAiConfiguration()),
      );
    }
    await user.click(
      await view.findByRole("button", { name: "Set up OpenBot" }),
    );
    await user.click(await view.findByRole("button", { name: "Continue" }));
    await user.click(await view.findByRole("radio", { name: /OpenAI/ }));
    expect(
      Boolean(view.queryByText(/A saved OpenAI API key will be used/)),
    ).toBe(savedModel);
    if (!savedModel) {
      await user.type(
        view.getByLabelText("OpenAI API key"),
        "sk-synthetic-current-model",
      );
    }
    await user.click(view.getByRole("button", { name: "Continue" }));
    await user.click(view.getByText("Point at your own Intelligence server"));
    const rootField = view.getByLabelText("Where OpenBot lives");
    const startButton = view.getByRole("button", { name: "Start OpenBot" });
    expect(startButton).toHaveProperty("disabled", !savedModel);

    await user.clear(rootField);
    await user.type(rootField, rootB);
    if (pendingRoot === "b") {
      // Start a new load on blur, then edit again while that load is pending.
      await act(async () => rootField.blur());
    }
    if (currentRoot !== rootB) {
      await user.clear(rootField);
      await user.type(rootField, currentRoot);
    }
    const pending = requests[requests.length - 1];
    expect(pending.root).toBe(`/tmp/openbot-root-${pendingRoot}`);
    const requestCountBeforeBlur = requests.length;

    function expectClearedState() {
      expect(rootField).toHaveProperty("value", currentRoot);
      expect(view.container.ownerDocument.activeElement === rootField).toBe(
        true,
      );
      expect(
        view.queryByText(
          /Connected to CopilotKit|A saved CopilotKit connection/,
        ),
      ).toBeNull();
      expect(view.getByLabelText("Project key")).toHaveProperty("value", "");
      expect(view.getByLabelText("API URL")).toHaveProperty(
        "value",
        "https://api.intelligence.copilotkit.ai",
      );
      expect(view.getByLabelText("Gateway WebSocket URL")).toHaveProperty(
        "value",
        "wss://realtime.intelligence.copilotkit.ai",
      );
      expect(startButton).toHaveProperty("disabled", true);
      expect(requests).toHaveLength(requestCountBeforeBlur);
      expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
        false,
      );
    }

    expectClearedState();
    await act(async () =>
      pending.response.resolve({
        ...savedOpenAiConfiguration(),
        values: {
          INTELLIGENCE_API_KEY: "ck-synthetic-stale",
          INTELLIGENCE_API_URL: "https://stale.example/api",
          INTELLIGENCE_GATEWAY_WS_URL: "wss://stale.example/ws",
        },
      }),
    );
    expectClearedState();

    // Intelligence alone cannot restore readiness for a saved model cleared by the edit.
    if (savedModel) {
      await act(async () => rootField.blur());
      await act(async () =>
        requests[requests.length - 1].response.resolve({
          ...emptyConfiguration(),
          saved: { ...emptyConfiguration().saved, intelligenceApiKey: true },
        }),
      );
      expect(
        view.getByText(
          "A saved CopilotKit connection will be checked when you start.",
        ),
      ).toBeTruthy();
      expect(startButton).toHaveProperty("disabled", true);
      await user.click(rootField);
    }
    await act(async () => rootField.blur());
    expect(requests[requests.length - 1].root).toBe(currentRoot);
    expect(startButton).toHaveProperty("disabled", true);
    await act(async () =>
      requests[requests.length - 1].response.resolve({
        ...savedOpenAiConfiguration(),
        values: {
          INTELLIGENCE_API_URL: "https://current.example/api",
          INTELLIGENCE_GATEWAY_WS_URL: "wss://current.example/ws",
        },
      }),
    );
    expect(
      view.getByText(
        "A saved CopilotKit connection will be checked when you start.",
      ),
    ).toBeTruthy();
    await chooseModelAfterRootEdit(
      view,
      savedModel ? undefined : "sk-synthetic-current-model",
    );
    const currentStart = view.getByRole("button", { name: "Start OpenBot" });
    expect(currentStart).toHaveProperty("disabled", false);
    await user.click(currentStart);
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(getStartStackPayload()).toEqual({
      root: currentRoot,
      apiKey: "",
      apiUrl: "https://current.example/api",
      gatewayWsUrl: "wss://current.example/ws",
      harness: { id: "langgraph" },
      model: savedModel
        ? { provider: "openai", login: "api-key", saved: true }
        : {
            provider: "openai",
            login: "api-key",
            apiKey: "sk-synthetic-current-model",
          },
    });
  },
);

function useBringYourOwnHarnessSetup() {
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
}

async function enterBringYourOwnHarnessEndpoint(agentUrl: string) {
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
  if (agentUrl) {
    await userEvent.type(agentEndpoint, agentUrl.replaceAll("[", "[["));
  }
  expect(agentEndpoint).toHaveProperty("value", agentUrl);
  return view;
}

test.each([
  "",
  "http://",
  "https://",
  "httpx://models.example/v1",
  "httpfoo://models.example/v1",
  "https://exa mple.example/v1",
  "HTTP://agent.example/ag-ui",
  "https:agent.example/ag-ui",
])("bring-your-own agent refuses startup for URL %s", async (agentUrl) => {
  useBringYourOwnHarnessSetup();
  const view = await enterBringYourOwnHarnessEndpoint(agentUrl);

  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);
  await userEvent.click(continueButton);
  expect(view.getByRole("heading", { name: "Your first Bot" })).toBeTruthy();
  expect(view.queryByRole("heading", { name: "Connect your AI" })).toBeNull();
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(invokeCalls.filter((call) => call.command === "start_stack")).toEqual(
    [],
  );
});

test.each([
  ["https://agent.example/ag-ui", "https://agent.example/ag-ui"],
  ["http://localhost:11434/v1", "http://localhost:11434/v1"],
  ["https://models.example/v1", "https://models.example/v1"],
  ["https://bücher.example/ag-ui", "https://bücher.example/ag-ui"],
  ["http://[::1]:8000/ag-ui", "http://[::1]:8000/ag-ui"],
  ["  http://localhost:8000/ag-ui  ", "http://localhost:8000/ag-ui"],
])(
  "bring-your-own agent collects a distinct AG-UI endpoint for startup: %s",
  async (agentUrl, expectedAgentUrl) => {
    useBringYourOwnHarnessSetup();
    const view = await enterBringYourOwnHarnessEndpoint(agentUrl);

    const continueFromHarness = view.getByRole("button", { name: "Continue" });
    expect(continueFromHarness).toHaveProperty("disabled", false);
    await userEvent.click(continueFromHarness);
    expect(
      await view.findByRole("heading", { name: "Connect your AI" }),
    ).toBeTruthy();
    await userEvent.click(
      await view.findByRole("radio", { name: /OpenAI-compatible/ }),
    );
    await userEvent.type(
      view.getByLabelText("Base URL"),
      "https://provider.example/v1",
    );
    await userEvent.type(view.getByLabelText("Model name"), "local-model");
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    await userEvent.click(
      await view.findByRole("button", { name: "Start OpenBot" }),
    );

    const payload = getStartStackPayload();
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(payload).toEqual({
      root: "/tmp/openbot-app-test",
      apiKey: "",
      apiUrl: "https://api.intelligence.copilotkit.ai",
      gatewayWsUrl: "wss://realtime.intelligence.copilotkit.ai",
      harness: { id: "byo-url", agentUrl: expectedAgentUrl },
      model: {
        provider: "openai-compatible",
        login: "endpoint",
        baseUrl: "https://provider.example/v1",
        model: "local-model",
      },
    });
    expect(payload.model).not.toHaveProperty("apiKey");
  },
);

test.each([
  "http://",
  "https://",
  "httpx://models.example/v1",
  "httpfoo://models.example/v1",
  "https://exa mple.example/v1",
])("custom compatible endpoint refuses startup for URL %s", async (baseUrl) => {
  useCompatibleEndpointSetup({});
  const view = await enterCompatibleEndpoint(baseUrl);

  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);
  await userEvent.click(continueButton);
  expect(view.getByRole("heading", { name: "Connect your AI" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(invokeCalls.filter((call) => call.command === "start_stack")).toEqual(
    [],
  );
});

test.each(["http://localhost:11434/v1", "https://models.example/v1"])(
  "custom compatible endpoint startup for URL %s does not submit a saved OpenAI API key",
  async (baseUrl) => {
    useCompatibleEndpointSetup({
      OPENAI_API_KEY: "sk-synthetic-openai",
    });

    await startWithCompatibleEndpoint("", baseUrl);

    const payload = getStartStackPayload();
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(payload).toEqual({
      root: "/tmp/openbot-app-test",
      apiKey: "",
      apiUrl: "https://api.intelligence.copilotkit.ai",
      gatewayWsUrl: "wss://realtime.intelligence.copilotkit.ai",
      harness: { id: "langgraph" },
      model: {
        provider: "openai-compatible",
        login: "endpoint",
        baseUrl,
        model: "local-model",
      },
    });
    expect(payload.model).not.toHaveProperty("apiKey");
    expect(JSON.stringify(payload)).not.toContain("sk-synthetic-openai");
  },
);

test("custom compatible endpoint startup can route containers to a different public URL", async () => {
  useCompatibleEndpointSetup({});

  await startWithCompatibleEndpoint(
    "",
    "http://127.0.0.1:11434/v1",
    "http://ollama:11434/v1",
  );

  const payload = getStartStackPayload();
  expect(payload.model).toEqual({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "http://127.0.0.1:11434/v1",
    containerBaseUrl: "http://ollama:11434/v1",
    model: "local-model",
  });
});

test("saved compatible endpoint restores the optional container URL", async () => {
  useSavedCompatibleEndpointSetup(
    "http://127.0.0.1:11434/v1",
    "qwen3-vl:2b",
    false,
    "compatible-endpoint",
    "http://ollama:11434/v1",
  );

  const view = await renderApp();
  await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(
    view.getByLabelText("Container Base URL, if different"),
  ).toHaveProperty("value", "http://ollama:11434/v1");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Start OpenBot" }),
  );

  expect(getStartStackPayload().model).toMatchObject({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "http://127.0.0.1:11434/v1",
    containerBaseUrl: "http://ollama:11434/v1",
    model: "qwen3-vl:2b",
  });
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
  test.each(["fresh", "saved"])(
    `${provider.name} %s plan startup omits a key typed before switching login tabs`,
    async (session) => {
      const planToken = `synthetic-${provider.id}-plan-token`;
      const hiddenKey = `sk-synthetic-${provider.id}-hidden`;
      useRootConfigurationSetup("/tmp/openbot-app-test", async () => ({
        ...emptyConfiguration(),
        saved: {
          ...emptyConfiguration().saved,
          intelligenceApiKey: true,
          modelSessions: { [provider.id]: session === "saved" },
        },
      }));
      const setupHandler = invokeHandler;
      invokeHandler = async (command, args) => {
        if (command === "providers") {
          return [
            {
              ...provider,
              summary: `Use ${provider.name}.`,
              logins: ["plan", "api-key"],
              mark: null,
              caution: null,
            },
          ];
        }
        if (session === "fresh") {
          const signIn = provider.id === "openai" ? "chatgpt" : "claude";
          if (command === `begin_${signIn}_sign_in`)
            return "https://sign-in.example";
          if (command === `finish_${signIn}_sign_in`) return planToken;
        }
        return setupHandler(command, args);
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
      await userEvent.click(view.getByRole("tab", { name: "Use an API key" }));
      await userEvent.type(
        view.getByLabelText(`${provider.name} API key`),
        hiddenKey,
      );
      await userEvent.click(
        view.getByRole("tab", { name: "Sign in with my plan" }),
      );
      if (session === "fresh") {
        await userEvent.click(
          view.getByRole("button", { name: `Sign in with ${provider.name}` }),
        );
        if (provider.id === "anthropic") {
          await userEvent.type(
            await view.findByLabelText("Code from your browser"),
            "synthetic-code",
          );
          await userEvent.click(
            view.getByRole("button", { name: "Finish signing in" }),
          );
        }
      }
      await view.findByText(
        new RegExp(
          session === "saved"
            ? `A saved ${provider.name} sign-in will be checked`
            : `Signed in to ${provider.name}`,
        ),
      );
      await userEvent.click(view.getByRole("button", { name: "Continue" }));
      await userEvent.click(
        await view.findByRole("button", { name: "Start OpenBot" }),
      );

      const payload = getStartStackPayload();
      expect(payload.model).not.toHaveProperty("apiKey");
      expect(payload.model).toEqual({
        provider: provider.id,
        login: "plan",
        ...(session === "saved" ? { saved: true } : { token: planToken }),
      });
      expect(JSON.stringify(payload)).not.toContain(hiddenKey);
    },
  );

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
      view.getByText(
        new RegExp(`A saved ${provider.name} sign-in will be checked`),
      ),
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

for (const provider of [
  { id: "openai", name: "OpenAI", plan: "ChatGPT" },
  { id: "anthropic", name: "Anthropic", plan: "Claude" },
]) {
  for (const login of ["plan", "api-key"] as const) {
    test(`unknown legacy ${provider.name} ${login} and Intelligence reuse stays passive until Start`, async () => {
      useRootConfigurationSetup("/tmp/synthetic-legacy-root", async () => ({
        values: {},
        saved: {},
      }));
      const setupHandler = invokeHandler;
      invokeHandler = async (command, args) => {
        if (command === "providers")
          return [
            {
              ...provider,
              summary: "Synthetic provider",
              logins: ["plan", "api-key"],
              mark: null,
              caution: null,
            },
          ];
        if (command === "start_stack")
          throw {
            said: "Synthetic saved credential is unavailable.",
            detail: "Synthetic denial",
          };
        return setupHandler(command, args);
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
      if (login === "api-key")
        await userEvent.click(
          view.getByRole("tab", { name: "Use an API key" }),
        );
      await userEvent.click(
        view.getByRole("button", {
          name:
            login === "plan"
              ? `Use a saved ${provider.plan} sign-in`
              : `Use a saved ${provider.name} API key`,
        }),
      );
      await userEvent.click(view.getByRole("button", { name: "Continue" }));
      expect(
        view.getByRole("button", { name: "Start OpenBot" }),
      ).toHaveProperty("disabled", true);
      await userEvent.click(
        view.getByRole("button", { name: "Use a saved connection" }),
      );
      expect(view.queryByText("Connected to CopilotKit.")).toBeNull();
      // Returning to the provider screen retains deliberate reuse without signing in automatically.
      await userEvent.click(
        view.getByRole("button", { name: "Change AI connection" }),
      );
      await userEvent.click(
        await view.findByRole("button", { name: "Continue" }),
      );
      expect(
        invokeCalls.some((call) =>
          /sign_in|start_stack|ask_the_bot/.test(call.command),
        ),
      ).toBe(false);
      await userEvent.click(
        view.getByRole("button", { name: "Start OpenBot" }),
      );
      await view.findByText("Synthetic saved credential is unavailable.");
      expect(getStartStackPayload()).toMatchObject({
        apiKey: "",
        model: { provider: provider.id, login, saved: true },
      });
      expect(getStartStackPayload().model).not.toHaveProperty("token");
      expect(getStartStackPayload().model).not.toHaveProperty("apiKey");
      expect(
        view.getByRole("button", { name: "Sign in to CopilotKit again" }),
      ).toBeTruthy();
    });
  }
}

test("Start credential failures do not expose a restore action", async () => {
  useCompatibleEndpointSetup({
    INTELLIGENCE_API_KEY: "synthetic-intelligence",
  });
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "start_stack")
      throw {
        said: "Saved credential needs authorization.",
        detail: "synthetic item refusal",
        [["reco", "very"].join("")]: {
          ticket: "synthetic-one-use",
          operation: "read",
          setting: "INTELLIGENCE_API_KEY",
          label: "Restore access to saved setup",
          explanation:
            "This Mac is protecting a credential from your saved OpenBot setup. Restoring access may ask macOS to confirm this app. Your saved data stays in place.",
        },
      };
    return previous(command, args);
  };
  const view = await enterCompatibleEndpoint(
    "https://models.example/v1",
    "synthetic-model-key",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));

  expect(
    await view.findByText("Saved credential needs authorization."),
  ).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Restore access to saved setup" }),
  ).toBeNull();
  expect(
    invokeCalls.some((c) => c.command === ["reco", "ver_credential"].join("")),
  ).toBe(false);
  expect(
    invokeCalls.filter(
      (c) => c.command === ["cancel", "_credential", "_reco", "very"].join(""),
    ),
  ).toEqual([]);
});

test("the Enter that finishes a composed character does not ask the Bot", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "ask_the_bot") return "42";
    return previous(command, args);
  };
  const view = await enterCompatibleEndpoint("https://models.example/v1");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  const question = await view.findByLabelText("Your question");
  // Keys land on the focused field.
  await userEvent.click(question);

  // Japanese, Chinese and Korean are typed through an input method, where Enter confirms the
  // character being built. Chromium marks that keydown `isComposing`; the macOS WebKit webview
  // sends it after compositionend with key code 229. Neither should send the question.
  await act(async () => {
    fireEvent.keyDown(question, { key: "Enter", isComposing: true });
    fireEvent.keyDown(question, { key: "Enter", keyCode: 229 });
  });

  expect(invokeCalls.filter((call) => call.command === "ask_the_bot")).toEqual(
    [],
  );
});
