import { expect, test } from "bun:test";
import { detectLocalAi, isLocalBaseUrl } from "../src/local-ai/detect";

function fakeFetch(answers: Record<string, unknown>) {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    if (!(url in answers)) throw new Error("connection refused");
    return new Response(JSON.stringify(answers[url]), { status: 200 });
  };
  return { fetcher, asked };
}

test("finds Ollama and LM Studio models, leaving out embedding models", async () => {
  const { fetcher } = fakeFetch({
    "http://127.0.0.1:11434/api/tags": {
      models: [{ name: "qwen3:8b", size: 5_200_000_000 }],
    },
    "http://host.docker.internal:1234/v1/models": {
      data: [{ id: "llama-3.1-8b" }, { id: "nomic-embed-text" }],
    },
  });
  const report = await detectLocalAi({}, fetcher);
  expect(report.runtimes).toEqual([
    {
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: "qwen3:8b", sizeBytes: 5_200_000_000 }],
    },
    {
      name: "LM Studio",
      baseUrl: "http://host.docker.internal:1234/v1",
      models: [{ id: "llama-3.1-8b", sizeBytes: null }],
    },
  ]);
});

test("asks only its own fixed local addresses", async () => {
  const { fetcher, asked } = fakeFetch({});
  const report = await detectLocalAi(
    { OPENAI_BASE_URL: "https://evil.example/v1" },
    fetcher,
  );
  expect(report.runtimes).toEqual([]);
  for (const url of asked) {
    expect(url).toMatch(
      /^http:\/\/(127\.0\.0\.1|host\.docker\.internal):(11434|1234)\//,
    );
  }
  expect(report.inUse.isLocal).toBe(false);
});

test("says when the server already uses a local model", async () => {
  const { fetcher } = fakeFetch({});
  const report = await detectLocalAi(
    {
      OPENAI_BASE_URL: "http://host.docker.internal:11434/v1",
      BOT_MODEL: "qwen3:8b",
    },
    fetcher,
  );
  expect(report.inUse).toEqual({
    baseUrl: "http://host.docker.internal:11434/v1",
    model: "qwen3:8b",
    isLocal: true,
  });
  expect(isLocalBaseUrl("https://api.openai.com/v1")).toBe(false);
});
