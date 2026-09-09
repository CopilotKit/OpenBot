import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HeldConfiguration, Provider } from "./ProviderPicker";

const providers: Provider[] = [
  {
    id: "openai",
    name: "OpenAI",
    summary: "Use ChatGPT.",
    logins: ["plan", "api-key"],
    mark: null,
    caution: null,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    summary: "Use Claude.",
    logins: ["plan", "api-key"],
    mark: null,
    caution: null,
  },
];

const endpointProviders: Provider[] = [
  {
    id: "openai-compatible",
    name: "OpenAI-compatible",
    summary: "Use your own endpoint.",
    logins: ["endpoint"],
    mark: null,
    caution: null,
  },
];

type Invoke = (command: string, args?: unknown) => Promise<unknown>;

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

const { ProviderPicker } = await import("./ProviderPicker");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  invokeCalls = [];
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function renderPicker(onChoose: (choice: unknown) => void = () => {}) {
  let view!: ReturnType<typeof render>;

  await act(async () => {
    view = render(
      <ProviderPicker
        chosen={null}
        held={{}}
        onBack={() => {}}
        onChoose={onChoose}
      />,
    );
  });

  return view;
}

async function renderPickerWithHeld(
  held: HeldConfiguration,
  onChoose: (choice: unknown) => void = () => {},
) {
  let view!: ReturnType<typeof render>;

  await act(async () => {
    view = render(
      <ProviderPicker
        chosen={null}
        held={held}
        onBack={() => {}}
        onChoose={onChoose}
      />,
    );
  });

  return view;
}

test("a completed plan sign-in enables and submits only its issuing provider", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    if (command === "begin_chatgpt_sign_in") return "https://chatgpt.test";
    if (command === "finish_chatgpt_sign_in") return "chatgpt-token";
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPicker((choice) => choices.push(choice));

  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await waitFor(() =>
    expect(view.getByText(/Signed in to OpenAI/)).toBeTruthy(),
  );
  await userEvent.click(view.getByRole("radio", { name: /Anthropic/ }));

  expect(view.queryByText(/Signed in to Anthropic/)).toBeNull();
  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);

  await userEvent.click(continueButton);
  expect(choices).toEqual([]);
});

test("a pending plan sign-in completion is ignored after switching provider rows", async () => {
  const chatgpt = deferred<string>();
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    if (command === "begin_chatgpt_sign_in") return "https://chatgpt.test";
    if (command === "finish_chatgpt_sign_in") return chatgpt.promise;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPicker((choice) => choices.push(choice));

  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await waitFor(() =>
    expect(
      invokeCalls.some((call) => call.command === "finish_chatgpt_sign_in"),
    ).toBe(true),
  );
  await userEvent.click(view.getByRole("radio", { name: /Anthropic/ }));

  await act(async () => {
    chatgpt.resolve("chatgpt-token");
  });

  await waitFor(() =>
    expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    ),
  );
  expect(view.queryByText(/Signed in to Anthropic/)).toBeNull();
  expect(choices).toEqual([]);
});

test("a saved provider-scoped plan session enables continue without exposing a token", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld(
    {
      saved: {
        modelSessions: {
          openai: true,
          anthropic: false,
        },
      },
    },
    (choice) => choices.push(choice),
  );

  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  expect(view.getByText(/Signed in to OpenAI/)).toBeTruthy();
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(choices).toEqual([
    {
      provider: "openai",
      login: "plan",
      saved: true,
    },
  ]);
});

for (const provider of providers) {
  test.each(["fresh", "saved"])(
    `${provider.name} %s plan choice omits a key typed before switching login tabs`,
    async (session) => {
      const choices: unknown[] = [];
      const planToken = `synthetic-${provider.id}-plan-token`;
      invokeHandler = async (command) => {
        if (command === "providers") return providers;
        if (session === "fresh") {
          const signIn = provider.id === "openai" ? "chatgpt" : "claude";
          if (command === `begin_${signIn}_sign_in`)
            return "https://sign-in.example";
          if (command === `finish_${signIn}_sign_in`) return planToken;
        }
        throw new Error(`unexpected command ${command}`);
      };
      const view = await renderPickerWithHeld(
        { saved: { modelSessions: { [provider.id]: session === "saved" } } },
        (choice) => choices.push(choice),
      );

      await userEvent.click(
        await view.findByRole("radio", { name: new RegExp(provider.name) }),
      );
      await userEvent.click(view.getByRole("tab", { name: "Use an API key" }));
      await userEvent.type(
        view.getByLabelText(`${provider.name} API key`),
        `sk-synthetic-${provider.id}-hidden`,
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
      await view.findByText(new RegExp(`Signed in to ${provider.name}`));
      expect(view.queryByLabelText(`${provider.name} API key`)).toBeNull();
      await userEvent.click(view.getByRole("button", { name: "Continue" }));

      expect(choices).toHaveLength(1);
      expect(choices[0]).not.toHaveProperty("apiKey");
      expect(choices[0]).toEqual({
        provider: provider.id,
        login: "plan",
        ...(session === "saved" ? { saved: true } : { token: planToken }),
      });
    },
  );

  test(`${provider.name} API-key choice submits its intentionally typed key`, async () => {
    const choices: unknown[] = [];
    invokeHandler = async (command) => {
      if (command === "providers") return providers;
      throw new Error(`unexpected command ${command}`);
    };
    const view = await renderPicker((choice) => choices.push(choice));
    await userEvent.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    await userEvent.click(view.getByRole("tab", { name: "Use an API key" }));
    await userEvent.type(
      view.getByLabelText(`${provider.name} API key`),
      `  sk-synthetic-${provider.id}-intentional  `,
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));

    expect(choices).toEqual([
      {
        provider: provider.id,
        login: "api-key",
        apiKey: `sk-synthetic-${provider.id}-intentional`,
      },
    ]);
  });
}

test("a compatible endpoint does not inherit a saved OpenAI API key", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld(
    {
      OPENAI_API_KEY: "sk-synthetic-openai",
      saved: {
        modelApiKeys: {
          openai: true,
          anthropic: false,
        },
      },
    },
    (choice) => choices.push(choice),
  );

  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "https://models.example/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "local-model");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "https://models.example/v1",
    model: "local-model",
  });
  expect(choices[0]).not.toHaveProperty("apiKey");
});

test("a compatible endpoint submits the key typed into its endpoint key field", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld(
    {
      OPENAI_API_KEY: "sk-synthetic-openai",
      saved: {
        modelApiKeys: {
          openai: true,
          anthropic: false,
        },
      },
    },
    (choice) => choices.push(choice),
  );

  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "https://models.example/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "local-model");
  await userEvent.type(
    view.getByLabelText("API key, if the endpoint needs one"),
    "endpoint-key",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    provider: "openai-compatible",
    login: "endpoint",
    apiKey: "endpoint-key",
    baseUrl: "https://models.example/v1",
    model: "local-model",
  });
});

test.each([
  "http://",
  "https://",
  "httpx://models.example/v1",
  "httpfoo://models.example/v1",
  "https://exa mple.example/v1",
])("a compatible endpoint refuses invalid HTTP(S) URL %s", async (baseUrl) => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPicker((choice) => choices.push(choice));
  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(view.getByLabelText("Base URL"), baseUrl);
  await userEvent.type(view.getByLabelText("Model name"), "local-model");

  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);
  await userEvent.click(continueButton);
  expect(choices).toEqual([]);
});

test("a compatible endpoint accepts local http and external https URLs", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  for (const baseUrl of [
    "http://localhost:11434/v1",
    "https://models.example/v1",
  ]) {
    const view = await renderPicker((choice) => choices.push(choice));
    await userEvent.click(
      await view.findByRole("radio", { name: /OpenAI-compatible/ }),
    );
    await userEvent.type(view.getByLabelText("Base URL"), baseUrl);
    await userEvent.type(view.getByLabelText("Model name"), "local-model");

    const continueButton = view.getByRole("button", { name: "Continue" });
    expect(continueButton).toHaveProperty("disabled", false);
    await userEvent.click(continueButton);
    cleanup();
  }

  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "http://localhost:11434/v1",
      model: "local-model",
    },
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "https://models.example/v1",
      model: "local-model",
    },
  ]);
});
