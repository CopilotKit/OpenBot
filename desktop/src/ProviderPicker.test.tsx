import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import type {
  HeldConfiguration,
  ModelChoice,
  Provider,
} from "./ProviderPicker";

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

const cloudProviders = [
  {
    id: "google",
    name: "Google Gemini",
    // Google's guidelines allow only "Sign in with Google" beside its G.
    signsInWith: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    keyLink: "Get a Google Gemini API key",
  },
  {
    id: "xai",
    name: "xAI",
    signsInWith: "xAI",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.7",
    keyUrl: "https://console.x.ai/",
    // "an", by the sound of the name: the link read "Get a xAI API key".
    keyLink: "Get an xAI API key",
  },
];

/** Signs in through a device authorization that mints an API key, then uses it like a typed one. */
const unbiased = {
  id: "unbiased",
  name: "Unbiased AI",
  baseUrl: "https://api.unbiased.ai/v1",
  model: "pareto",
  keyUrl: "https://platform.unbiased.ai/dashboard/keys",
  keyLink: "Get an Unbiased AI API key",
};

const allProviders: Provider[] = [
  ...providers,
  ...[...cloudProviders, unbiased].map(
    (provider): Provider => ({
      id: provider.id,
      name: provider.name,
      summary: "Use an API key.",
      logins: ["endpoint"],
      mark: null,
      caution: null,
    }),
  ),
  ...endpointProviders,
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
  // The mark a "Sign in with" button carries, by the id it was given. The real one draws that
  // vendored file, which needs Vite's glob.
  ButtonMark: ({ id }: { id: string | null }) =>
    id ? <img alt="" data-mark={id} /> : null,
}));

const { ProviderPicker } = await import("./ProviderPicker");

beforeAll(() =>
  GlobalRegistrator.register({
    settings: { navigation: { disableChildPageNavigation: true } },
  }),
);
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
        root=" /tmp/openbot-provider-root "
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
        root=" /tmp/openbot-provider-root "
        onBack={() => {}}
        onChoose={onChoose}
      />,
    );
  });

  return view;
}

/** Chooses a provider row, going back to the whole list first when one is already chosen. */
async function pick(view: ReturnType<typeof render>, name: RegExp) {
  const change = view.queryByRole("button", {
    name: "Choose a different provider",
  });
  if (change) await userEvent.click(change);
  await userEvent.click(await view.findByRole("radio", { name }));
}

/*
 * Every "Sign in with" button carries the mark of the provider it signs in to, as the web app's
 * sign-in buttons do. They carried none, and Google's and xAI's rows had no mark to carry.
 */
test("every Sign in with button carries its provider's mark", async () => {
  const marked: Provider[] = [
    { ...providers[0], mark: "openai" },
    { ...providers[1], mark: "anthropic" },
    {
      id: "google",
      name: "Google Gemini",
      summary: "Use an API key or sign in.",
      logins: ["endpoint", "oauth"],
      mark: "google-color",
      caution: null,
    },
    {
      id: "xai",
      name: "xAI",
      summary: "Use an API key or sign in.",
      logins: ["endpoint", "oauth"],
      mark: "xai",
      caution: null,
    },
  ];
  invokeHandler = async (command) => {
    if (command === "providers") return marked;
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPickerWithHeld({
    saved: { modelSessions: { anthropic: true } },
  });

  for (const provider of marked) {
    await pick(view, new RegExp(`^${provider.name}`));
    if (provider.logins.includes("oauth"))
      await userEvent.click(view.getByRole("tab", { name: "Sign in" }));
    const name =
      provider.id === "anthropic"
        ? "Sign in again with Anthropic"
        : provider.id === "google"
          ? "Sign in with Google"
          : `Sign in with ${provider.name}`;
    const button = view.getByRole("button", { name });
    expect(button.querySelector("img")?.getAttribute("data-mark")).toBe(
      provider.mark,
    );
  }
});

/*
 * "Any OpenAI-compatible endpoint" was the one row with nothing beside its name. It stands for no one
 * vendor, so it carries no vendor's mark, and gets a plain icon in the marks' tile instead.
 */
test("the OpenAI-compatible endpoint row shows a plain icon in a mark tile", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return allProviders;
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPicker();

  const row = (
    await view.findByRole("radio", { name: /^OpenAI-compatible/ })
  ).closest("label");
  const tile = row?.querySelector(".mark-tile");
  expect(tile?.getAttribute("data-icon")).toBe("cloud");
  expect(tile?.getAttribute("aria-hidden")).toBe("true");
  expect(tile?.querySelector("svg")).toBeTruthy();
  // The other rows keep their own marks; only the endpoint row gets the plain icon.
  expect(view.container.querySelectorAll("[data-icon]").length).toBe(1);
});

test("a completed plan sign-in enables and submits only its issuing provider", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command, args) => {
    if (command === "providers") return providers;
    if (command === "begin_chatgpt_sign_in") {
      expect(args).toEqual({ root: "/tmp/openbot-provider-root" });
      return "https://chatgpt.test";
    }
    if (command === "finish_chatgpt_sign_in") return "chatgpt-token";
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPicker((choice) => choices.push(choice));

  await pick(view, /OpenAI/);
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await waitFor(() =>
    expect(view.getByText(/Signed in to OpenAI/)).toBeTruthy(),
  );
  // The finished sign-in moves on by itself, with its own provider's token.
  await waitFor(
    () =>
      expect(choices).toEqual([
        { provider: "openai", login: "plan", token: "chatgpt-token" },
      ]),
    { timeout: 4000 },
  );
  await pick(view, /Anthropic/);

  expect(view.queryByText(/Signed in to Anthropic/)).toBeNull();
  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);

  await userEvent.click(continueButton);
  expect(choices).toHaveLength(1);
});

test("a finished sign-in shows its tick for a second, and choosing another row then cancels the move", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    if (command === "begin_chatgpt_sign_in") return "https://chatgpt.test";
    if (command === "finish_chatgpt_sign_in") return "chatgpt-token";
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPicker((choice) => choices.push(choice));
  await pick(view, /OpenAI/);
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  const tick = await view.findByText(/✓/);
  expect(tick.closest("p")?.textContent).toContain("Signed in to OpenAI.");
  expect(choices).toEqual([]);
  // Another row inside the second: nothing moves on.
  await pick(view, /Anthropic/);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1300)));
  expect(choices).toEqual([]);
  expect(view.queryByText(/✓/)).toBeNull();
});

test("a pending plan sign-in completion is ignored after switching provider rows", async () => {
  const chatgpt = deferred<string>();
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    if (command === "begin_chatgpt_sign_in") {
      return "https://chatgpt.test";
    }
    if (command === "finish_chatgpt_sign_in") return chatgpt.promise;
    if (command === "cancel_chatgpt_sign_in") return null;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPicker((choice) => choices.push(choice));

  await pick(view, /OpenAI/);
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await waitFor(() =>
    expect(
      invokeCalls.some((call) => call.command === "finish_chatgpt_sign_in"),
    ).toBe(true),
  );
  // The wait for the browser is said with a spinner, as every setup row is.
  const waiting = view.getByRole("status");
  expect(waiting.textContent).toBe("Waiting for you to approve it…");
  expect(waiting.querySelector(".step-spinner")).not.toBeNull();
  await pick(view, /Anthropic/);

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

/*
 * A ChatGPT sign-in left behind keeps listening for the browser. Its tab can still finish, and the
 * browser then says "You're signed in" while this screen has moved on and dropped the result. So
 * leaving it stops it: the tab then gets OpenBot's own page saying the sign-in ended.
 */
test("leaving a ChatGPT sign-in that is still waiting stops it", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    if (command === "begin_chatgpt_sign_in") return "https://chatgpt.test";
    if (command === "finish_chatgpt_sign_in") return new Promise(() => {});
    if (command === "cancel_chatgpt_sign_in") return null;
    throw new Error(`unexpected command ${command}`);
  };
  const cancelled = () =>
    invokeCalls.filter((call) => call.command === "cancel_chatgpt_sign_in")
      .length;

  const view = await renderPicker();
  await pick(view, /OpenAI/);
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await waitFor(() =>
    expect(
      invokeCalls.some((call) => call.command === "finish_chatgpt_sign_in"),
    ).toBe(true),
  );
  expect(cancelled()).toBe(0);

  await pick(view, /Anthropic/);
  await waitFor(() => expect(cancelled()).toBe(1));

  // And when the screen goes away mid-wait, as Back does.
  await pick(view, /OpenAI/);
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "finish_chatgpt_sign_in")
        .length,
    ).toBe(2),
  );
  view.unmount();
  await waitFor(() => expect(cancelled()).toBe(2));
});

test("a ChatGPT sign-in that finished is not cancelled when the screen moves on", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    if (command === "begin_chatgpt_sign_in") return "https://chatgpt.test";
    if (command === "finish_chatgpt_sign_in") return "chatgpt-token";
    if (command === "cancel_chatgpt_sign_in") return null;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPicker();
  await pick(view, /OpenAI/);
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await view.findByText(/Signed in to OpenAI/);
  view.unmount();
  expect(
    invokeCalls.some((call) => call.command === "cancel_chatgpt_sign_in"),
  ).toBe(false);
});

test.each([
  {
    name: "Anthropic",
    signIn: "claude",
    says: "Anthropic opens in your browser. Approve the request there, then paste the code it shows you back here. You won't need an API key.",
    asksForCode: true,
  },
  {
    name: "OpenAI",
    signIn: "chatgpt",
    says: "OpenAI opens in your browser. You won't type anything here or need an API key.",
    asksForCode: false,
  },
])(
  "$name's plan sign-in says beforehand whether it will ask for a code",
  async ({ name, signIn, says, asksForCode }) => {
    const finished = deferred<string>();
    invokeHandler = async (command) => {
      if (command === "providers") return providers;
      if (command === `begin_${signIn}_sign_in`)
        return "https://sign-in.example";
      if (command === `finish_${signIn}_sign_in`) return finished.promise;
      if (command === `cancel_${signIn}_sign_in`) return null;
      throw new Error(`unexpected command ${command}`);
    };
    const view = await renderPicker();
    await pick(view, new RegExp(name));

    const promise = view.getByText(/in your browser\./);
    expect(promise.textContent).toBe(says);

    await userEvent.click(
      view.getByRole("button", { name: `Sign in with ${name}` }),
    );
    await view.findByText("Open the sign-in page");
    expect(Boolean(view.queryByLabelText("Code from your browser"))).toBe(
      asksForCode,
    );
  },
);

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

  await pick(view, /OpenAI/);
  expect(view.getByText(/A saved OpenAI sign-in will be checked/)).toBeTruthy();
  expect(view.getByText(/Your Bot will use LangChain/)).toBeTruthy();
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
      invokeHandler = async (command, args) => {
        if (command === "providers") return providers;
        if (session === "fresh") {
          const signIn = provider.id === "openai" ? "chatgpt" : "claude";
          if (command === `begin_${signIn}_sign_in`) {
            expect(args).toEqual({ root: "/tmp/openbot-provider-root" });
            return "https://sign-in.example";
          }
          if (command === `finish_${signIn}_sign_in`) return planToken;
        }
        throw new Error(`unexpected command ${command}`);
      };
      const view = await renderPickerWithHeld(
        { saved: { modelSessions: { [provider.id]: session === "saved" } } },
        (choice) => choices.push(choice),
      );

      await pick(view, new RegExp(provider.name));
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
      await view.findByText(
        new RegExp(
          session === "saved"
            ? `A saved ${provider.name} sign-in will be checked`
            : `Signed in to ${provider.name}`,
        ),
      );
      expect(view.queryByLabelText(`${provider.name} API key`)).toBeNull();
      // A fresh sign-in moves on by itself; a saved one is only offered, so it waits for Continue.
      if (session === "saved") {
        await userEvent.click(view.getByRole("button", { name: "Continue" }));
      } else {
        await waitFor(() => expect(choices).toHaveLength(1), {
          timeout: 4000,
        });
      }

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
    await pick(view, new RegExp(provider.name));
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

  await pick(view, /OpenAI-compatible/);
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

  await pick(view, /OpenAI-compatible/);
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

test("a compatible endpoint carries an optional container-only URL", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld({}, (choice) => choices.push(choice));
  await pick(view, /OpenAI-compatible/);
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "http://127.0.0.1:11434/v1",
  );
  await userEvent.type(
    view.getByLabelText("Container Base URL, if different"),
    "http://ollama:11434/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "qwen3-vl:2b");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "http://127.0.0.1:11434/v1",
      containerBaseUrl: "http://ollama:11434/v1",
      model: "qwen3-vl:2b",
    },
  ]);
});

test("a compatible endpoint uses the host URL for containers when no override is entered", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld({}, (choice) => choices.push(choice));
  await pick(view, /OpenAI-compatible/);
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "https://models.example/v1",
  );
  expect(
    view.getByText(
      /Leave this empty unless containers need a different address/,
    ),
  ).toBeTruthy();
  await userEvent.type(view.getByLabelText("Model name"), "remote-model");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "https://models.example/v1",
      model: "remote-model",
    },
  ]);
});

test("a compatible endpoint refuses an invalid container-only URL", async () => {
  const choices: unknown[] = [];
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderPickerWithHeld({}, (choice) => choices.push(choice));
  await pick(view, /OpenAI-compatible/);
  await userEvent.type(
    view.getByLabelText("Base URL"),
    "http://127.0.0.1:11434/v1",
  );
  await userEvent.type(
    view.getByLabelText("Container Base URL, if different"),
    "ollama:11434/v1",
  );
  await userEvent.type(view.getByLabelText("Model name"), "qwen3-vl:2b");

  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);
  await userEvent.click(continueButton);
  expect(choices).toEqual([]);
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
  await pick(view, /OpenAI-compatible/);
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
    await pick(view, /OpenAI-compatible/);
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

for (const provider of providers) {
  for (const login of ["plan", "api-key"] as const) {
    test(`unknown legacy ${provider.id} ${login} reuse is explicit and provider scoped`, async () => {
      const choices: unknown[] = [];
      invokeHandler = async (command) => {
        if (command === "providers") return providers;
        throw new Error(`unexpected protected command ${command}`);
      };
      const view = await renderPicker((choice) => choices.push(choice));
      await pick(view, new RegExp(provider.name));
      if (login === "api-key")
        await userEvent.click(
          view.getByRole("tab", { name: "Use an API key" }),
        );
      expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
        "disabled",
        true,
      );
      if (login === "api-key")
        await userEvent.type(
          view.getByLabelText(`${provider.name} API key`),
          "synthetic-unselected-new-key",
        );
      const label =
        login === "plan"
          ? `Use a saved ${provider.id === "anthropic" ? "Claude" : "ChatGPT"} sign-in`
          : `Use a saved ${provider.name} API key`;
      await userEvent.click(view.getByRole("button", { name: label }));
      expect(
        view.queryByText(new RegExp(`Signed in to ${provider.name}`)),
      ).toBeNull();
      await userEvent.click(view.getByRole("button", { name: "Continue" }));
      expect(choices).toEqual([{ provider: provider.id, login, saved: true }]);
      const other = providers.find((item) => item.id !== provider.id)!;
      await pick(view, new RegExp(other.name));
      expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
        "disabled",
        true,
      );
      expect(invokeCalls.map((call) => call.command)).toEqual(["providers"]);
    });
  }
}

test("recorded Claude plan intent survives reopening beside an unrelated saved API key", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    throw new Error(`unexpected protected command ${command}`);
  };
  const choices: unknown[] = [];
  const view = await renderPickerWithHeld(
    {
      saved: {
        model: "claude-plan",
        modelSessions: { anthropic: true },
        modelApiKeys: { anthropic: true, openai: true },
      },
    },
    (choice) => choices.push(choice),
  );
  expect(await view.findByRole("radio", { name: /Anthropic/ })).toHaveProperty(
    "checked",
    true,
  );
  expect(
    view
      .getByRole("tab", { name: "Sign in with my plan" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(choices).toEqual([
    { provider: "anthropic", login: "plan", saved: true },
  ]);
  expect(invokeCalls.map((call) => call.command)).toEqual(["providers"]);
  expect(
    view.getByRole("button", { name: "Sign in again with Anthropic" }),
  ).toBeTruthy();
});

test("a saved compatible endpoint restores public fields and requests its scoped key", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected protected command ${command}`);
  };
  const user = userEvent.setup({ document });
  const choices: unknown[] = [];
  const view = await renderPickerWithHeld(
    {
      OPENAI_BASE_URL: "https://models.example/v1",
      OPENAI_CONTAINER_BASE_URL: "http://ollama:11434/v1",
      BOT_MODEL: "local-model",
      saved: {
        model: "compatible-endpoint",
        modelApiKeys: { compatible: true },
      },
    },
    (choice) => choices.push(choice),
  );
  expect(await view.findByLabelText("Base URL")).toHaveProperty(
    "value",
    "https://models.example/v1",
  );
  expect(view.getByLabelText("Model name")).toHaveProperty(
    "value",
    "local-model",
  );
  expect(
    view.getByLabelText("API key, if the endpoint needs one"),
  ).toHaveProperty("value", "");
  expect(view.getByText(/A saved API key for this endpoint/)).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "https://models.example/v1",
      containerBaseUrl: "http://ollama:11434/v1",
      model: "local-model",
      saved: true,
    },
  ]);
  expect(invokeCalls.map((call) => call.command)).toEqual(["providers"]);

  await user.clear(view.getByLabelText("Base URL"));
  await user.type(view.getByLabelText("Base URL"), "https://other.example/v1");
  expect(view.queryByText(/A saved API key for this endpoint/)).toBeNull();
  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(choices[1]).toEqual({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "https://other.example/v1",
    model: "local-model",
  });
});

test("saved endpoint key can be explicitly replaced or omitted", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected protected command ${command}`);
  };
  const user = userEvent.setup({ document });
  const choices: unknown[] = [];
  const held: HeldConfiguration = {
    OPENAI_BASE_URL: "https://models.example/v1",
    BOT_MODEL: "local-model",
    saved: {
      model: "compatible-endpoint",
      modelApiKeys: { compatible: true },
    },
  };
  const view = await renderPickerWithHeld(held, (choice) =>
    choices.push(choice),
  );
  await view.findByLabelText("Base URL");
  await user.type(
    view.getByLabelText("API key, if the endpoint needs one"),
    "synthetic-new-key",
  );
  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(choices[0]).toEqual({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "https://models.example/v1",
    model: "local-model",
    apiKey: "synthetic-new-key",
  });
  view.unmount();
  const reopened = await renderPickerWithHeld(held, (choice) =>
    choices.push(choice),
  );
  await user.click(
    await reopened.findByRole("button", {
      name: "Continue without the saved key",
    }),
  );
  await user.click(reopened.getByRole("button", { name: "Continue" }));
  expect(choices[1]).toEqual({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "https://models.example/v1",
    model: "local-model",
  });
});

test("a saved keyless endpoint never requests a saved first-party key", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return endpointProviders;
    throw new Error(`unexpected protected command ${command}`);
  };
  const user = userEvent.setup({ document });
  const choices: unknown[] = [];
  const view = await renderPickerWithHeld(
    {
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      BOT_MODEL: "local-model",
      saved: { model: "compatible-endpoint", modelApiKeys: { openai: true } },
    },
    (choice) => choices.push(choice),
  );
  await view.findByLabelText("Base URL");
  expect(view.queryByText(/A saved API key for this endpoint/)).toBeNull();
  await user.click(view.getByRole("button", { name: "Continue" }));
  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-model",
    },
  ]);
});

test("OAuth tab switch cancels a late authorization before opening the browser", async () => {
  let resolveBegin!: (value: unknown) => void;
  invokeHandler = async (command) => {
    if (command === "providers")
      return allProviders.map((row) =>
        row.id === "xai" ? { ...row, logins: ["endpoint", "oauth"] } : row,
      );
    if (command === "begin_model_oauth")
      return new Promise((resolve) => {
        resolveBegin = resolve;
      });
    if (command === "cancel_model_oauth") return null;
    throw new Error(`unexpected command ${command}`);
  };
  const view = await renderPicker();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("radio", { name: /xAI/ }));
  await user.click(view.getByRole("tab", { name: "Sign in" }));
  await user.click(view.getByRole("button", { name: "Sign in with xAI" }));
  await user.click(view.getByRole("tab", { name: "Use an API key" }));
  await act(async () => {
    resolveBegin({
      attemptId: "late-attempt",
      url: "https://authorization.example.test",
      userCode: null,
    });
  });
  expect(invokeCalls).toContainEqual({
    command: "cancel_model_oauth",
    args: { attemptId: "late-attempt" },
  });
  expect(
    invokeCalls.some((call) => call.command === "plugin:opener|open_url"),
  ).toBe(false);
  expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
    "disabled",
    true,
  );
});

for (const provider of cloudProviders) {
  test(`${provider.name} OAuth completes through native storage without exposing tokens`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers")
        return allProviders.map((row) =>
          row.id === provider.id
            ? { ...row, logins: ["endpoint", "oauth"] }
            : row,
        );
      if (command === "begin_model_oauth")
        return {
          attemptId: "synthetic-attempt",
          url: "https://authorization.example.test/approve",
          userCode: "SYNTHETIC",
        };
      if (
        command === "plugin:opener|open_url" ||
        command === "finish_model_oauth"
      )
        return null;
      throw new Error(`unexpected command ${command}`);
    };
    const choices: unknown[] = [];
    const view = await renderPicker((choice) => choices.push(choice));
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    await user.click(view.getByRole("tab", { name: "Sign in" }));
    await user.click(
      view.getByRole("button", {
        name: `Sign in with ${provider.signsInWith}`,
      }),
    );
    await view.findByText(`Signed in to ${provider.name}.`);
    // Signed in with a model already named: on by itself, no Continue.
    await waitFor(() => expect(choices).toHaveLength(1), { timeout: 4000 });
    expect(choices).toEqual([
      {
        provider: provider.id,
        login: "oauth",
        model: provider.model,
        saved: true,
      },
    ]);
    expect(invokeCalls).toContainEqual({
      command: "begin_model_oauth",
      args: { root: "/tmp/openbot-provider-root", provider: provider.id },
    });
    expect(invokeCalls).toContainEqual({
      command: "finish_model_oauth",
      args: { attemptId: "synthetic-attempt" },
    });
  });
}

for (const provider of [...cloudProviders, unbiased]) {
  test(`${provider.name} opens its API key page externally without sending entered credentials`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers") return allProviders;
      if (command === "plugin:opener|open_url") return null;
      throw new Error(`unexpected command ${command}`);
    };
    const view = await renderPicker();
    const user = userEvent.setup({ document: view.container.ownerDocument });
    await user.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    await user.type(
      view.getByLabelText(`${provider.name} API key`),
      "synthetic-private-api-key",
    );
    expect(invokeCalls.map((call) => call.command)).toEqual(["providers"]);
    await user.click(view.getByRole("link", { name: provider.keyLink }));
    expect(invokeCalls).toEqual([
      { command: "providers", args: undefined },
      { command: "plugin:opener|open_url", args: { url: provider.keyUrl } },
    ]);
  });

  test(`${provider.name} uses its official endpoint and editable model with an API key`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers") return allProviders;
      throw new Error(`unexpected protected command ${command}`);
    };
    const user = userEvent.setup({ document });
    const choices: unknown[] = [];
    const view = await renderPicker((choice) => choices.push(choice));
    await user.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );

    expect(view.getByLabelText("Model name")).toHaveProperty(
      "value",
      provider.model,
    );
    expect(view.queryByLabelText("Base URL")).toBeNull();
    expect(
      view.queryByRole("tab", { name: "Sign in with my plan" }),
    ).toBeNull();
    expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.type(
      view.getByLabelText(`${provider.name} API key`),
      "synthetic-provider-key",
    );
    await user.click(view.getByRole("button", { name: "Continue" }));
    expect(choices[0]).toEqual({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: "synthetic-provider-key",
    });
    await user.clear(view.getByLabelText("Model name"));
    await user.type(
      view.getByLabelText("Model name"),
      "another-compatible-model",
    );
    await user.click(view.getByRole("button", { name: "Continue" }));
    expect(choices[1]).toEqual({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: provider.baseUrl,
      model: "another-compatible-model",
      apiKey: "synthetic-provider-key",
    });
  });

  test(`${provider.name} restores its choice when returning from the next setup step`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers") return allProviders;
      throw new Error(`unexpected protected command ${command}`);
    };
    const chosen: ModelChoice = {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: provider.baseUrl,
      model: "chosen-model",
      apiKey: "synthetic-returning-key",
    };
    const choices: ModelChoice[] = [];
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <ProviderPicker
          chosen={chosen}
          held={{}}
          root="/tmp/provider-return"
          onBack={() => {}}
          onChoose={(choice) => choices.push(choice)}
        />,
      );
    });
    expect(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    ).toHaveProperty("checked", true);
    expect(view.getByLabelText(`${provider.name} API key`)).toHaveProperty(
      "value",
      "synthetic-returning-key",
    );
    expect(view.getByLabelText("Model name")).toHaveProperty(
      "value",
      "chosen-model",
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(choices).toEqual([chosen]);
  });

  test(`${provider.name} recognizes a saved endpoint but never carries its key to another provider`, async () => {
    invokeHandler = async (command) => {
      if (command === "providers") return allProviders;
      throw new Error(`unexpected protected command ${command}`);
    };
    // A trailing slash is an equivalent UI identity, but the saved URL itself must
    // survive unchanged so backend credential matching remains endpoint-scoped.
    const savedUrl = provider.baseUrl.endsWith("/")
      ? provider.baseUrl.slice(0, -1)
      : `${provider.baseUrl}/`;
    const choices: unknown[] = [];
    const view = await renderPickerWithHeld(
      {
        OPENAI_BASE_URL: savedUrl,
        BOT_MODEL: "saved-model",
        saved: {
          model: "compatible-endpoint",
          modelApiKeys: { compatible: true, openai: true },
        },
      },
      (choice) => choices.push(choice),
    );
    expect(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    ).toHaveProperty("checked", true);
    expect(view.getByLabelText(`${provider.name} API key`)).toHaveProperty(
      "value",
      "",
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(choices[0]).toEqual({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: savedUrl,
      model: "saved-model",
      saved: true,
    });

    await userEvent.type(
      view.getByLabelText(`${provider.name} API key`),
      "synthetic-replacement-key",
    );
    const other = cloudProviders.find(
      (candidate) => candidate.id !== provider.id,
    )!;
    await pick(view, new RegExp(other.name));
    expect(view.getByLabelText(`${other.name} API key`)).toHaveProperty(
      "value",
      "",
    );
    expect(view.queryByText(/A saved API key for this endpoint/)).toBeNull();
    expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(
      view.getByLabelText(`${other.name} API key`),
      "synthetic-other-key",
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(choices[1]).toEqual({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: other.baseUrl,
      model: other.model,
      apiKey: "synthetic-other-key",
    });
  });
}

test("an Unbiased AI sign-in mints an API key that goes on as its endpoint credential", async () => {
  const finish = deferred<string>();
  invokeHandler = async (command) => {
    if (command === "providers")
      return allProviders.map((row) =>
        row.id === "unbiased" ? { ...row, logins: ["oauth", "endpoint"] } : row,
      );
    if (command === "begin_model_oauth")
      return {
        attemptId: "unbiased-attempt",
        url: "https://platform.unbiased.ai/activate?user_code=BCDF-GHJK",
        userCode: "BCDF-GHJK",
      };
    if (command === "plugin:opener|open_url") return null;
    if (command === "finish_model_oauth") return finish.promise;
    throw new Error(`unexpected command ${command}`);
  };
  const choices: unknown[] = [];
  const view = await renderPicker((choice) => choices.push(choice));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("radio", { name: /Unbiased AI/ }));
  // Sign-in is the way in by default, with the gateway's model already named.
  expect(
    view.getByRole("tab", { name: "Sign in" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(view.getByLabelText("Model name")).toHaveProperty("value", "pareto");
  await user.click(
    view.getByRole("button", { name: "Sign in with Unbiased AI" }),
  );
  // The code is on screen for matching against the approval page, beside the link to it.
  await view.findByText("BCDF-GHJK");
  expect(invokeCalls).toContainEqual({
    command: "plugin:opener|open_url",
    args: { url: "https://platform.unbiased.ai/activate?user_code=BCDF-GHJK" },
  });
  await act(async () => {
    finish.resolve("sk_pareto_synthetic");
  });
  await view.findByText("Signed in to Unbiased AI.");
  await waitFor(() => expect(choices).toHaveLength(1), { timeout: 4000 });
  expect(choices).toEqual([
    {
      provider: "openai-compatible",
      login: "endpoint",
      apiKey: "sk_pareto_synthetic",
      baseUrl: "https://api.unbiased.ai/v1",
      model: "pareto",
    },
  ]);
  // Held, never shown.
  expect(view.container.textContent).not.toContain("sk_pareto_synthetic");
});

test("a refused Unbiased AI sign-in shows why, submits nothing and keeps no key", async () => {
  invokeHandler = async (command) => {
    if (command === "providers")
      return allProviders.map((row) =>
        row.id === "unbiased" ? { ...row, logins: ["oauth", "endpoint"] } : row,
      );
    if (command === "begin_model_oauth")
      return {
        attemptId: "unbiased-attempt",
        url: "https://platform.unbiased.ai/activate?user_code=BCDF-GHJK",
        userCode: "BCDF-GHJK",
      };
    if (command === "plugin:opener|open_url") return null;
    if (command === "finish_model_oauth")
      throw new Error(
        "Unbiased AI sign-in was not approved: the user denied this authorization.",
      );
    throw new Error(`unexpected command ${command}`);
  };
  const choices: unknown[] = [];
  const view = await renderPicker((choice) => choices.push(choice));
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByRole("radio", { name: /Unbiased AI/ }));
  await user.click(
    view.getByRole("button", { name: "Sign in with Unbiased AI" }),
  );
  await view.findByText(/not approved: the user denied this authorization/);
  // The wait is over: no code, no link, and the button offers a fresh start, not "again".
  expect(view.queryByText("BCDF-GHJK")).toBeNull();
  expect(view.queryByText("Signed in to Unbiased AI.")).toBeNull();
  expect(
    view.getByRole("button", { name: "Sign in with Unbiased AI" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
    "disabled",
    true,
  );
  await new Promise((settle) => setTimeout(settle, 1200));
  expect(choices).toEqual([]);
});

test("a chosen provider stands alone, and Change or Escape shows them all again", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    return null;
  };
  const view = await renderPicker();
  const everyRow = (await view.findAllByRole("radio")).length;
  expect(everyRow).toBeGreaterThan(1);

  await userEvent.click(view.getByRole("radio", { name: /Anthropic/ }));
  expect(view.getAllByRole("radio")).toHaveLength(1);
  await userEvent.click(
    view.getByRole("button", { name: "Choose a different provider" }),
  );
  expect(view.getAllByRole("radio")).toHaveLength(everyRow);
  expect(
    view.queryByRole("button", { name: "Choose a different provider" }),
  ).toBeNull();

  await userEvent.click(view.getByRole("radio", { name: /OpenAI$|^OpenAI/ }));
  expect(view.getAllByRole("radio")).toHaveLength(1);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(view.getAllByRole("radio")).toHaveLength(everyRow);
});

/**
 * The chosen row's own text ran under Change: "…vLLM or your own." sat behind the button on the
 * compatible endpoint's row. The lone row keeps the room Change takes at its right.
 */
test("a chosen provider's text leaves room for Change", async () => {
  invokeHandler = async (command) => {
    if (command === "providers") return providers;
    return null;
  };
  const view = await renderPicker();
  await view.findAllByRole("radio");
  await userEvent.click(view.getByRole("radio", { name: /Anthropic/ }));
  const row = view.getByRole("radio").closest("label");
  expect(row?.className).toContain("beside-change");
  const styles = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
  const rule = styles.match(/\.tile\.beside-change\s*\{([^}]*)\}/)?.[1] ?? "";
  const room = Number(rule.match(/padding-right:\s*(\d+)px/)?.[1] ?? 0);
  // Change is about 50px wide, 16px in from the edge, with a gap before the text.
  expect(room).toBeGreaterThanOrEqual(80);
});
