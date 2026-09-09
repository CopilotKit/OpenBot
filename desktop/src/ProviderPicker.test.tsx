import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Provider } from "./ProviderPicker";

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
  const { ProviderPicker } = await import("./ProviderPicker");
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
