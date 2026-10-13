import { describe, expect, test } from "bun:test";
import {
  modelCheckOutcome,
  reportModelAvailability,
} from "../src/model-availability-check";

const KEY = "sk-proj-not-a-real-key-0123456789";

function fakeFetch(status: number) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("what the provider's answer means", () => {
  test("2xx is available", () => {
    expect(
      modelCheckOutcome({ provider: "openai", model: "gpt-x", status: 200 }),
    ).toEqual({ kind: "available" });
  });

  test("404 says the key cannot call the model, and how to fix it", () => {
    // The state a project key with a model allowlist reaches: every Bot turn fails with "does not
    // exist or you do not have access to it", and nothing said so before the first message.
    const outcome = modelCheckOutcome({
      provider: "openai",
      model: "gpt-5.6-terra",
      status: 404,
    });
    expect(outcome.kind).toBe("warning");
    if (outcome.kind !== "warning") return;
    expect(outcome.line.type).toBe("model-unavailable");
    expect(outcome.line.fix).toContain("gpt-5.6-terra");
    expect(outcome.line.fix).toContain("model.yaml");
  });

  test.each([401, 403])("%i says the key itself was refused", (status) => {
    const outcome = modelCheckOutcome({
      provider: "anthropic",
      model: "claude-x",
      status,
    });
    expect(outcome.kind === "warning" && outcome.line.type).toBe(
      "model-credential-rejected",
    );
    expect(outcome.kind === "warning" && outcome.line.fix).toContain(
      "ANTHROPIC_API_KEY",
    );
  });

  test("anything else is reported as unreadable, not as a missing model", () => {
    const outcome = modelCheckOutcome({
      provider: "openai",
      model: "gpt-x",
      status: 503,
    });
    expect(outcome.kind === "warning" && outcome.line.type).toBe(
      "model-check-unreadable",
    );
  });
});

describe("asking at boot", () => {
  test("asks OpenAI for the one model, with the key as a bearer token, and logs nothing when it is there", async () => {
    const { fetcher, calls } = fakeFetch(200);
    const lines: string[] = [];
    const outcome = await reportModelAvailability({
      provider: "openai",
      model: "gpt-5.6-terra",
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      log: (line) => lines.push(line),
    });
    expect(outcome).toEqual({ kind: "available" });
    expect(lines).toEqual([]);
    expect(calls[0]?.url).toBe(
      "https://api.openai.com/v1/models/gpt-5.6-terra",
    );
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test("asks Anthropic with its own headers", async () => {
    const { fetcher, calls } = fakeFetch(200);
    await reportModelAvailability({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      log: () => {},
    });
    expect(calls[0]?.url).toBe(
      "https://api.anthropic.com/v1/models/claude-sonnet-4-5",
    );
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]?.headers["anthropic-version"]).toBeDefined();
  });

  test("logs one line for a model the key cannot call, without the key in it", async () => {
    const { fetcher } = fakeFetch(404);
    const lines: string[] = [];
    await reportModelAvailability({
      provider: "openai",
      model: "gpt-5.6-terra",
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "model-unavailable",
      model: "gpt-5.6-terra",
    });
    expect(lines[0]).not.toContain(KEY);
  });

  test("leaves an OpenAI-compatible endpoint alone, where a 404 would mean nothing", async () => {
    const { fetcher, calls } = fakeFetch(404);
    const outcome = await reportModelAvailability({
      provider: "openai",
      model: "qwen3",
      apiKey: async () => KEY,
      environment: { OPENAI_BASE_URL: "http://localhost:11434/v1" },
      fetch: fetcher,
      log: () => {},
    });
    expect(outcome).toEqual({ kind: "skipped" });
    expect(calls).toHaveLength(0);
  });

  test("says nothing while no key is configured yet", async () => {
    const { fetcher, calls } = fakeFetch(200);
    const lines: string[] = [];
    const outcome = await reportModelAvailability({
      provider: "openai",
      model: "gpt-x",
      apiKey: async () => null,
      environment: {},
      fetch: fetcher,
      log: (line) => lines.push(line),
    });
    expect(outcome).toEqual({ kind: "skipped" });
    expect(calls).toHaveLength(0);
    expect(lines).toEqual([]);
  });

  test("a provider it cannot reach is reported and does not throw", async () => {
    const lines: string[] = [];
    const outcome = await reportModelAvailability({
      provider: "openai",
      model: "gpt-x",
      apiKey: async () => KEY,
      environment: {},
      fetch: (async () => {
        throw new Error("getaddrinfo ENOTFOUND api.openai.com");
      }) as unknown as typeof fetch,
      log: (line) => lines.push(line),
    });
    expect(outcome.kind === "warning" && outcome.line.type).toBe(
      "model-check-unreadable",
    );
    expect(JSON.parse(lines[0] ?? "{}").reason).toContain("ENOTFOUND");
  });
});
