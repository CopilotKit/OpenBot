import {
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentResponseUsageMetadata,
} from "@google/genai";
import type { A2uiRequestProcessor, RendererState } from "@a2ui/agent";
import { DecisionError, type SubmitDecisions } from "./decision.ts";
import { collectExpress, expressPrompt } from "./express.ts";

export const expressModel = "gemini-3.5-flash-lite";
const apiVersion = "v1beta";

export function configuredKey() {
  return (
    process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim()
  );
}

export function geminiClient(apiKey: string) {
  return new GoogleGenAI({
    apiKey,
    vertexai: false,
    apiVersion,
    httpOptions: {
      baseUrl: "https://generativelanguage.googleapis.com",
      timeout: 45_000,
      retryOptions: { attempts: 1 },
    },
  });
}

export function decisionClient(client: GoogleGenAI): SubmitDecisions {
  return (request) =>
    client.decisions.create(request, {
      retries: { strategy: "none" },
      timeout_ms: 30_000,
    });
}

export async function liveExpress(
  client: GoogleGenAI,
  processor: A2uiRequestProcessor,
  state: RendererState,
  input: object,
) {
  const started = performance.now();
  let firstApiChunkMs: number | undefined;
  let lastApiChunkMs: number | undefined;
  let usage: GenerateContentResponseUsageMetadata | undefined;
  let modelVersion: string | undefined;

  async function* apiChunks() {
    const current = { role: "user", parts: [{ text: JSON.stringify(input) }] };
    const stream = await client.models.generateContentStream({
      model: expressModel,
      contents: [current],
      config: {
        systemInstruction: expressPrompt(processor),
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        maxOutputTokens: 2048,
      },
    });
    for await (const chunk of stream) {
      const elapsed = performance.now() - started;
      firstApiChunkMs ??= elapsed;
      lastApiChunkMs = elapsed;
      usage = chunk.usageMetadata ?? usage;
      modelVersion = chunk.modelVersion ?? modelVersion;
      if (!chunk.text) continue;
      yield chunk.text;
    }
  }

  const result = await collectExpress(processor, state, apiChunks());
  return {
    ...result,
    usage,
    modelVersion,
    firstApiChunkMs,
    lastApiChunkMs,
    completeMs: performance.now() - started,
  };
}

export function errorSummary(error: unknown) {
  if (error instanceof DecisionError) return { kind: error.code };
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    name?: unknown;
  };
  const status = candidate?.status ?? candidate?.statusCode;
  return {
    kind: error instanceof Error ? error.constructor.name : "UnknownError",
    ...(typeof status === "number" ? { status } : {}),
  };
}
