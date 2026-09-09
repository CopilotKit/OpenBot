import { afterAll, expect } from "bun:test";

const mode = process.env.SRA009_MODE;
const targetTest =
  process.env.SRA009_TOOL_SELECTION_TEST_PATH ??
  new URL("./tool-selection.integration.test.ts", import.meta.url).pathname;
const modelModulePath =
  process.env.SRA009_MODEL_MODULE_PATH ??
  new URL("../src/routing/model.ts", import.meta.url).pathname;
const syntheticKey = "sra009-synthetic-before-key";

declare global {
  var __SRA009_AFTER_TOOL_SELECTION_RESTORE__:
    | (() => Promise<void> | void)
    | undefined;
}

type ModelModule = {
  createModelCompleter: (deps: {
    model: { provider: string; defaultModel: string };
    resolveApiKey: () => Promise<string | null>;
  }) => (prompt: string) => Promise<string>;
};

function hasModelCompleter(module: unknown): module is ModelModule {
  return (
    typeof module === "object" &&
    module !== null &&
    "createModelCompleter" in module &&
    typeof module.createModelCompleter === "function"
  );
}

let receivedProbe = false;
let receivedAuthMatches = false;
let receivedPathMatches = false;

const probeServer =
  mode === "present" || mode === "teardown-error"
    ? Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          receivedProbe = true;
          receivedPathMatches =
            url.pathname === "/sra009-synthetic-before/v1/chat/completions";
          receivedAuthMatches =
            request.headers.get("authorization") === `Bearer ${syntheticKey}`;
          return Response.json({
            choices: [{ message: { content: "synthetic-live-response" } }],
          });
        },
      })
    : null;

if (mode === "present" || mode === "teardown-error") {
  process.env.OPENAI_BASE_URL = `${probeServer?.url.origin}/sra009-synthetic-before`;
  process.env.OPENAI_API_KEY = syntheticKey;
} else if (mode === "absent") {
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
} else {
  throw new Error(`unknown SRA009_MODE ${String(mode)}`);
}

const modelModule: unknown = await import(modelModulePath);
if (!hasModelCompleter(modelModule)) {
  throw new Error(
    "SRA009_MODEL_MODULE_PATH did not export createModelCompleter",
  );
}

let proofEmitted = false;

async function emitRestorationProof() {
  proofEmitted = true;
  try {
    if (mode === "present" || mode === "teardown-error") {
      const restoredBase =
        process.env.OPENAI_BASE_URL ===
        `${probeServer?.url.origin}/sra009-synthetic-before`;
      const restoredKey = process.env.OPENAI_API_KEY === syntheticKey;
      let modelText = "";
      let modelStatus = "not-called";
      try {
        modelText = await modelModule.createModelCompleter({
          model: { provider: "openai", defaultModel: "gpt-5.5" },
          resolveApiKey: async () => syntheticKey,
        })("answer with JSON");
        modelStatus = "resolved";
      } catch {
        modelStatus = "rejected";
      }
      const result = {
        mode,
        restoredBase,
        restoredKey,
        modelStatus,
        modelTextMatches: modelText === "synthetic-live-response",
        receivedProbe,
        receivedPathMatches,
        receivedAuthMatches,
        keyStillFixture: process.env.OPENAI_API_KEY === "test-key",
      };
      console.log(`SRA009_ENV_RESTORE ${JSON.stringify(result)}`);
      expect(result).toEqual({
        mode,
        restoredBase: true,
        restoredKey: true,
        modelStatus: "resolved",
        modelTextMatches: true,
        receivedProbe: true,
        receivedPathMatches: true,
        receivedAuthMatches: true,
        keyStillFixture: false,
      });
      return;
    }

    const result = {
      mode,
      baseAbsent: process.env.OPENAI_BASE_URL === undefined,
      keyAbsent: process.env.OPENAI_API_KEY === undefined,
      keyStillFixture: process.env.OPENAI_API_KEY === "test-key",
    };
    console.log(`SRA009_ENV_RESTORE ${JSON.stringify(result)}`);
    expect(result).toEqual({
      mode: "absent",
      baseAbsent: true,
      keyAbsent: true,
      keyStillFixture: false,
    });
  } finally {
    probeServer?.stop(true);
  }
}

globalThis.__SRA009_AFTER_TOOL_SELECTION_RESTORE__ = emitRestorationProof;

await import(targetTest);

afterAll(async () => {
  try {
    if (!proofEmitted) {
      await emitRestorationProof();
    }
  } finally {
    globalThis.__SRA009_AFTER_TOOL_SELECTION_RESTORE__ = undefined;
  }
});
