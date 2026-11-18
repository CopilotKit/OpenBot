import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMatrix,
  classifyMastra,
  classifyRun,
  codexGate,
  type Harness,
  type MatrixRow,
  NOT_CHECKED,
  PROVIDERS,
  parseCapabilities,
  providersFor,
  renderTable,
  usableModels,
} from "./model-compat";

const ROOT = join(import.meta.dir, "..");
const NOW = Date.parse("2026-11-17T12:00:00Z");

// The listings below are cut from what each provider answered on 2026-11-17.
const openaiListing = {
  data: [
    { id: "gpt-6.1-terra", created: 1792000000 },
    { id: "gpt-6.2-sol", created: 1793000000 },
    { id: "gpt-5.5", created: 1776900000 },
    { id: "gpt-5.5-2026-04-23", created: 1776900000 },
    { id: "gpt-5.3-codex", created: 1770000000 },
    { id: "gpt-5-search-api", created: 1760000000 },
    { id: "chat-latest", created: 1760000000 },
    { id: "gpt-4o-mini-tts", created: 1740000000 },
    { id: "gpt-realtime-2", created: 1780000000 },
    { id: "gpt-image-2", created: 1776000000 },
    { id: "text-embedding-3-large", created: 1700000000 },
    { id: "whisper-1", created: 1680000000 },
    { id: "gpt-live-1", created: 1790000000 },
    { id: "gpt-4-turbo", created: 1700000000 },
    { id: "o1", created: 1720000000 },
    { id: "o3", created: 1744000000, shutdown_date: "2026-11-01" },
    { id: "o3-pro", created: 1749000000, shutdown_date: "2026-12-11" },
  ],
};

const anthropicListing = {
  data: [
    {
      id: "claude-fable-5-2",
      created_at: "2026-11-09T18:30:00Z",
      lifecycle: "active",
    },
    {
      id: "claude-opus-5-5",
      created_at: "2026-09-21T16:24:00Z",
      lifecycle: "active",
    },
    {
      id: "claude-sonnet-5-5",
      created_at: "2026-09-28T00:00:00Z",
      lifecycle: "active",
    },
    {
      id: "claude-sonnet-4-5-20250929",
      created_at: "2025-09-29T00:00:00Z",
      retires_at: "2026-11-30T17:00:00Z",
      lifecycle: "deprecated",
    },
    {
      id: "claude-3-opus-20240229",
      created_at: "2024-02-29T00:00:00Z",
      retires_at: "2026-01-05T00:00:00Z",
      lifecycle: "retired",
    },
  ],
};

const geminiListing = {
  object: "list",
  data: [
    { id: "models/gemini-3.8-flash", object: "model", owned_by: "google" },
    { id: "models/gemini-4-argon", object: "model", owned_by: "google" },
    { id: "models/gemini-embedding-001", object: "model", owned_by: "google" },
    {
      id: "models/imagen-4.0-generate-001",
      object: "model",
      owned_by: "google",
    },
    { id: "models/veo-3.0-generate-001", object: "model", owned_by: "google" },
    { id: "models/gemini-3.8-flash-live", object: "model", owned_by: "google" },
    {
      id: "models/gemini-robotics-er-1.5",
      object: "model",
      owned_by: "google",
    },
    { id: "models/aqa", object: "model", owned_by: "google" },
    {
      id: "models/gemini-2.5-flash-preview-tts",
      object: "model",
      owned_by: "google",
    },
  ],
};

test("an OpenAI key is offered only the chat models a Bot can run, newest first", () => {
  expect(usableModels("openai", openaiListing, new Map(), NOW)).toEqual([
    "gpt-6.2-sol",
    "gpt-6.1-terra",
    "gpt-5.5",
    "o3-pro",
  ]);
});

test("models.dev saying a model takes no tools drops it, as the picker does", () => {
  const capabilities = parseCapabilities({
    openai: { models: { "gpt-6.1-terra": { tool_call: false } } },
  });
  expect(
    usableModels("openai", openaiListing, capabilities, NOW),
  ).not.toContain("gpt-6.1-terra");
});

test("an Anthropic key is offered every current Claude, retired ones dropped", () => {
  expect(usableModels("anthropic", anthropicListing, new Map(), NOW)).toEqual([
    "claude-fable-5-2",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-sonnet-4-5-20250929",
  ]);
});

test("a Google key keeps the Gemini chat models and drops media, live, robots and aqa", () => {
  expect(usableModels("google", geminiListing, new Map(), NOW).sort()).toEqual([
    "gemini-3.8-flash",
    "gemini-4-argon",
  ]);
});

const harnesses: Harness[] = [
  {
    image: "agent-claude-sdk",
    credential: "anthropic",
    port: 4212,
    runPath: "",
  },
  { image: "agent-antigravity", credential: "google", port: 4214, runPath: "" },
  {
    image: "agent-agno",
    credential: "any-provider",
    port: 4203,
    runPath: "/agui",
  },
];

test("each harness is paired with the providers it can run on", () => {
  expect(providersFor(harnesses[0]!)).toEqual(["anthropic"]);
  expect(providersFor(harnesses[1]!)).toEqual(["google"]);
  expect(providersFor(harnesses[2]!)).toEqual(
    PROVIDERS.map((provider) => provider.id),
  );
});

test("the matrix has one row per harness, image tag and model, and skips a provider with no key", () => {
  const rows = buildMatrix({
    harnesses,
    tags: ["latest", "main"],
    listings: new Map([
      ["anthropic", { models: ["claude-opus-5-5", "claude-sonnet-5-5"] }],
      ["openai", { error: "401 Incorrect API key provided" }],
    ]),
  });
  const runs = rows.filter(
    (row): row is Extract<MatrixRow, { kind: "run" }> => row.kind === "run",
  );
  // claude-sdk and agno on Anthropic: 2 harnesses x 2 tags x 2 models.
  expect(runs).toHaveLength(8);
  expect(
    runs
      .filter((row) => row.harness.image === "agent-claude-sdk")
      .map((row) => `${row.tag} ${row.model}`),
  ).toEqual([
    "latest claude-opus-5-5",
    "latest claude-sonnet-5-5",
    "main claude-opus-5-5",
    "main claude-sonnet-5-5",
  ]);
  const listingFailures = rows.filter((row) => row.kind === "listing-failed");
  expect(
    listingFailures.map((row) => [row.harness.image, row.provider]),
  ).toEqual([["agent-agno", "openai"]]);
  const skipped = rows.filter((row) => row.kind === "no-key");
  expect(
    skipped.map((row) => [row.harness.image, row.provider]).sort(),
  ).toEqual([
    ["agent-agno", "google"],
    ["agent-agno", "xai"],
    ["agent-antigravity", "google"],
  ]);
});

// What the Claude Agent SDK harness at claude-agent-sdk==0.2.152 streamed for claude-opus-5-5.
const claudeSdkRefusal = [
  'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}',
  'data: {"type":"CUSTOM","name":"system:status","value":{"status":"requesting"}}',
  `data: {"type":"RUN_ERROR","message":"API Error: 400 Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.","code":"OPENBOT_MODEL_REFUSED"}`,
  "",
].join("\n\n");

// What the Agno harness streamed for claude-sonnet-5-5, and for a model Anthropic does not have.
const agnoReply = [
  'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}',
  'data: {"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant"}',
  'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"OK"}',
  'data: {"type":"TEXT_MESSAGE_END","messageId":"m"}',
  'data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
].join("\n\n");
const agnoNotFound = [
  'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}',
  `data: {"type":"RUN_ERROR","rawEvent":{"event":"RunError","content":"litellm.NotFoundError: AnthropicException - b'{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"not_found_error\\",\\"message\\":\\"model: claude-nonexistent-9\\"}}'"}}`,
].join("\n\n");

test("a run the provider refused fails with the provider's own words", () => {
  const result = classifyRun({ status: 200, body: claudeSdkRefusal });
  expect(result.status).toBe("fail");
  expect(result.detail).toContain(
    "Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required",
  );
});

test("a run that answered passes", () => {
  expect(classifyRun({ status: 200, body: agnoReply })).toEqual({
    status: "pass",
    detail: "OK",
  });
});

test("a reply that carries the model's reasoning fails, though it says OK", () => {
  // What gemma-4-31b-it answered through the LangGraph (TypeScript) engine.
  const leaked = agnoReply.replace(
    '"delta":"OK"',
    '"delta":"<thought>The user wants one word.</thought>OK"',
  );
  const outcome = classifyRun({ status: 200, body: leaked });
  expect(outcome.status).toBe("fail");
  expect(outcome.detail).toContain("reasoning in the reply text");
});

test("an error a framework puts in its raw event is still the failure's text", () => {
  const result = classifyRun({ status: 200, body: agnoNotFound });
  expect(result.status).toBe("fail");
  expect(result.detail).toContain("not_found_error");
});

test("a run that finished without a reply, or answered with an error as text, fails", () => {
  expect(
    classifyRun({
      status: 200,
      body: 'data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}',
    }).status,
  ).toBe("fail");
  const asText = classifyRun({
    status: 200,
    body: [
      'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Error code: 400 - model not supported"}',
      'data: {"type":"RUN_FINISHED"}',
    ].join("\n\n"),
  });
  expect(asText.status).toBe("fail");
  expect(asText.detail).toContain("model not supported");
});

test("a reply that arrives only as a messages snapshot, as CrewAI's bridge sends it, passes", () => {
  const crewaiReply = [
    'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}',
    'data: {"type":"MESSAGES_SNAPSHOT","messages":[{"id":"u","role":"user","content":"Reply with the single word OK."},{"id":"a","role":"assistant","content":"OK"}]}',
    'data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
  ].join("\n\n");
  expect(classifyRun({ status: 200, body: crewaiReply })).toEqual({
    status: "pass",
    detail: "OK",
  });
  // The person's own message in the snapshot is not a reply.
  const onlyThePrompt = crewaiReply.replace(
    ',{"id":"a","role":"assistant","content":"OK"}',
    "",
  );
  expect(classifyRun({ status: 200, body: onlyThePrompt }).status).toBe("fail");
});

test("Mastra's own API answer is read as a reply or a refusal", () => {
  expect(
    classifyMastra({
      status: 200,
      body: '{"text":"OK","finishReason":"stop"}',
    }),
  ).toEqual({ status: "pass", detail: "OK" });
  expect(
    classifyMastra({
      status: 500,
      body: '{"error":"This model is only supported in v1/responses and not in v1/chat/completions."}',
    }),
  ).toEqual({
    status: "fail",
    detail:
      "HTTP 500: This model is only supported in v1/responses and not in v1/chat/completions.",
  });
});

test("a refused request fails with its status and body", () => {
  expect(
    classifyRun({ status: 401, body: '{"error":"unauthorised"}' }),
  ).toEqual({
    status: "fail",
    detail: 'HTTP 401: {"error":"unauthorised"}',
  });
});

// Shaped as openai/codex publishes codex-rs/models-manager/models.json.
const codexCatalogue = {
  models: [
    {
      slug: "gpt-6.1-terra",
      visibility: "list",
      minimal_client_version: "0.153.0",
    },
    {
      slug: "gpt-6.3-sol",
      visibility: "list",
      minimal_client_version: "0.170.0",
    },
    {
      slug: "gpt-daybreak-blue-latest",
      visibility: "hide",
      minimal_client_version: "0.142.2",
    },
  ],
};

test("a ChatGPT plan model newer than the harness's Codex client version fails the gate", () => {
  expect(codexGate("0.167.0", codexCatalogue)).toEqual([
    {
      model: "gpt-6.1-terra",
      status: "pass",
      detail: "needs Codex 0.153.0, harness sends 0.167.0",
    },
    {
      model: "gpt-6.3-sol",
      status: "fail",
      detail: "needs Codex 0.170.0, harness sends 0.167.0",
    },
  ]);
  // Compared as numbers, not text.
  expect(
    codexGate("0.99.0", {
      models: [
        { slug: "m", visibility: "list", minimal_client_version: "0.100.0" },
      ],
    })[0]!.status,
  ).toBe("fail");
});

test("the table escapes what would break a Markdown row", () => {
  const table = renderTable([
    {
      harness: "agent-agno",
      tag: "latest",
      provider: "openai",
      model: "gpt-6.1-terra",
      status: "fail",
      detail: "a | b\nc",
    },
  ]);
  expect(table).toContain("a \\| b c");
});

test("every provider the Desktop offers by address is checked", () => {
  const picker = readFileSync(
    join(ROOT, "desktop/src/ProviderPicker.tsx"),
    "utf8",
  );
  const presets = [...picker.matchAll(/baseUrl: "(https:[^"]+)"/g)].map(
    (match) => match[1]!.replace(/\/+$/, ""),
  );
  expect(presets.length).toBeGreaterThan(0);
  const checked = [
    ...PROVIDERS.map((provider) => provider.baseUrl),
    ...NOT_CHECKED.map((left) => left.baseUrl),
  ].map((url) => url?.replace(/\/+$/, ""));
  for (const preset of presets) expect(checked).toContain(preset);
});

test("every published harness is one the matrix can run", () => {
  const published: string[] = JSON.parse(
    readFileSync(join(ROOT, ".github/published-images.json"), "utf8"),
  );
  const { harnesses: known } = JSON.parse(
    readFileSync(join(ROOT, "shared/harnesses.json"), "utf8"),
  ) as { harnesses: Harness[] };
  for (const image of published) {
    const harness = known.find((row) => row.image === image);
    expect(harness, image).toBeDefined();
    expect(providersFor(harness!).length, image).toBeGreaterThan(0);
  }
});
