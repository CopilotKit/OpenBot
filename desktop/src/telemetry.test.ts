import { expect, test } from "bun:test";
import type { ModelChoice } from "./ProviderPicker";
import {
  harnessChoiceEvent,
  modelChoiceEvent,
  type SetupEvent,
} from "./telemetry";

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

type ModelEvent = Extract<SetupEvent, { kind: "model_chosen" }>;

type ModelCase = {
  name: string;
  choice: ModelChoice | null;
  provider: ModelEvent["provider"];
  credentialPath: ModelEvent["credential_path"];
  customBaseUrl?: boolean;
};

const privateFields = {
  token: "synthetic-private-token",
  containerBaseUrl: "http://private-container:9000/v1",
  model: "private-model-name",
};

const modelCases: ModelCase[] = [
  ...(["openai", "anthropic"] as const).flatMap<ModelCase>((provider) => [
    {
      name: `${provider} new subscription`,
      choice: { ...privateFields, provider, login: "plan" as const },
      provider,
      credentialPath: "subscription",
    },
    {
      name: `${provider} saved subscription`,
      choice: {
        ...privateFields,
        provider,
        login: "plan" as const,
        saved: true,
      },
      provider,
      credentialPath: "subscription",
    },
    {
      name: `${provider} new API key`,
      choice: {
        ...privateFields,
        provider,
        login: "api-key" as const,
        apiKey: "synthetic-private-key",
      },
      provider,
      credentialPath: "api_key",
    },
    {
      name: `${provider} saved API key`,
      choice: {
        ...privateFields,
        provider,
        login: "api-key" as const,
        saved: true,
      },
      provider,
      credentialPath: "api_key",
    },
  ]),
  ...(["google", "xai"] as const).flatMap<ModelCase>((provider) =>
    [false, true].map<ModelCase>((saved) => ({
      name: `${provider} ${saved ? "saved" : "new"} OAuth`,
      choice: { ...privateFields, provider, login: "oauth" as const, saved },
      provider,
      credentialPath: "oauth",
    })),
  ),
  ...[
    [
      "Google API key",
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    ],
    ["xAI API key", "https://api.x.ai/v1"],
  ].map<ModelCase>(([name, baseUrl]) => ({
    name,
    choice: {
      ...privateFields,
      provider: "openai-compatible",
      login: "endpoint" as const,
      apiKey: "synthetic-private-key",
      baseUrl,
    },
    provider: "compatible",
    credentialPath: "api_key",
    customBaseUrl: true,
  })),
  ...[
    {
      name: "new key",
      apiKey: "  synthetic-private-key  ",
      credentialPath: "api_key" as const,
    },
    { name: "saved key", saved: true, credentialPath: "api_key" as const },
    {
      name: "blank new key with saved key",
      apiKey: "  ",
      saved: true,
      credentialPath: "api_key" as const,
    },
    { name: "no key", credentialPath: "none" as const },
    { name: "blank key", apiKey: " \t ", credentialPath: "none" as const },
    {
      name: "declined saved key",
      saved: false,
      credentialPath: "none" as const,
    },
  ].map<ModelCase>(({ name, credentialPath, ...credentials }) => ({
    name: `compatible endpoint ${name}`,
    choice: {
      ...privateFields,
      ...credentials,
      provider: "openai-compatible",
      login: "endpoint" as const,
      baseUrl: "https://private-model.example/v1",
    },
    provider: "compatible",
    credentialPath,
    customBaseUrl: true,
  })),
  {
    name: "compatible endpoint blank URL",
    choice: {
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl: " \t ",
    },
    provider: "compatible",
    credentialPath: "none",
  },
  {
    name: "skipped model",
    choice: null,
    provider: "none",
    credentialPath: "none" as const,
  },
];

test.each(modelCases)(
  "$name exports only closed telemetry categories",
  ({ choice, provider, credentialPath, customBaseUrl = false }) => {
    expect(modelChoiceEvent(choice)).toEqual({
      kind: "model_chosen",
      provider,
      credential_path: credentialPath,
      custom_base_url: customBaseUrl,
    });
  },
);

const unsupportedChoices: ModelChoice[] = [
  { provider: "private-provider", login: "api-key" },
  { provider: "openai", login: "endpoint" },
  { provider: "anthropic", login: "oauth" },
  { provider: "google", login: "api-key" },
  { provider: "xai", login: "plan" },
  { provider: "openai-compatible", login: "oauth" },
];

test.each(unsupportedChoices)(
  "unsupported $provider/$login choices are not exported",
  (choice) => expect(modelChoiceEvent(choice)).toBeNull(),
);
