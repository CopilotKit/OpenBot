import { expect, test } from "bun:test";
import { harnessChoiceEvent, modelChoiceEvent } from "./telemetry";

test("harness telemetry admits catalogue enums and excludes URLs and unknown IDs", () => {
  expect(harnessChoiceEvent("byo-url")).toEqual({
    kind: "harness_chosen",
    harness: "byo_url",
  });
  expect(harnessChoiceEvent("claude-agent-sdk")).toEqual({
    kind: "harness_chosen",
    harness: "claude_agent_sdk",
  });
  for (const unknown of [
    "https://private-agent.example",
    "future-harness",
    "__proto__",
    "toString",
  ]) {
    expect(harnessChoiceEvent(unknown)).toBeNull();
  }
});

test.each(["openai", "anthropic"])(
  "%s subscription and API-key telemetry contain only closed categories",
  (provider) => {
    expect(
      modelChoiceEvent({
        provider,
        login: "plan",
        token: "synthetic-private-token",
      }),
    ).toEqual({
      kind: "model_chosen",
      provider,
      credential_path: "subscription",
      custom_base_url: false,
    });
    expect(
      modelChoiceEvent({
        provider,
        login: "api-key",
        apiKey: "synthetic-private-key",
        saved: true,
      }),
    ).toEqual({
      kind: "model_chosen",
      provider,
      credential_path: "api_key",
      custom_base_url: false,
    });
  },
);

test("a custom endpoint becomes a boolean without exporting its URL, model, or credentials", () => {
  expect(
    modelChoiceEvent({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: "https://private-model.example/v1",
      containerBaseUrl: "http://private-container:9000/v1",
      model: "private-model-name",
      apiKey: "synthetic-private-key",
    }),
  ).toEqual({
    kind: "model_chosen",
    provider: "compatible",
    credential_path: "api_key",
    custom_base_url: true,
  });
});

test("a skipped model is explicit and unsupported providers are not exported", () => {
  expect(modelChoiceEvent(null)).toEqual({
    kind: "model_chosen",
    provider: "none",
    credential_path: "none",
    custom_base_url: false,
  });
  expect(
    modelChoiceEvent({ provider: "private-provider", login: "api-key" }),
  ).toBeNull();
  expect(
    modelChoiceEvent({ provider: "openai", login: "endpoint" }),
  ).toBeNull();
});
