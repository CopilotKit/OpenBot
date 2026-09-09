import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

async function renderApp() {
  const { App } = await import("./App");
  let view!: ReturnType<typeof render>;

  await act(async () => {
    view = render(<App />);
  });

  return view;
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
        INTELLIGENCE_API_KEY: "ck-test",
        OPENAI_API_KEY: "sk-test",
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
