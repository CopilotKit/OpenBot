import { afterAll, expect, test } from "bun:test";

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
  var __SRA009_AFTER_TOOL_SELECTION_SETUP_RESTORE__:
    | ((setup: {
        llmUrl: string;
        stopStatuses: PromiseSettledResult<void>[];
      }) => Promise<void> | void)
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
  mode === "present" || mode === "teardown-error" || mode === "setup-error"
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

if (mode === undefined) {
  test("SRA-009 restoration driver is inert without an explicit mode", () => {
    expect(process.env.SRA009_MODE).toBeUndefined();
  });
} else if (
  mode === "present" ||
  mode === "teardown-error" ||
  mode === "setup-error"
) {
  process.env.OPENAI_BASE_URL = `${probeServer?.url.origin}/sra009-synthetic-before`;
  process.env.OPENAI_API_KEY = syntheticKey;
} else if (mode === "absent") {
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
} else {
  throw new Error(`unknown SRA009_MODE ${String(mode)}`);
}

async function emitRestorationProof(modelModule: ModelModule) {
  proofEmitted = true;
  try {
    if (
      mode === "present" ||
      mode === "teardown-error" ||
      mode === "setup-error"
    ) {
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

async function fixtureListenerStopped(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return false;
  } catch {
    return true;
  }
}

let proofEmitted = false;

if (mode !== undefined) {
  const modelModule: unknown = await import(modelModulePath);
  if (!hasModelCompleter(modelModule)) {
    throw new Error(
      "SRA009_MODEL_MODULE_PATH did not export createModelCompleter",
    );
  }

  globalThis.__SRA009_AFTER_TOOL_SELECTION_RESTORE__ = () =>
    emitRestorationProof(modelModule);
  globalThis.__SRA009_AFTER_TOOL_SELECTION_SETUP_RESTORE__ = async (setup) => {
    await emitRestorationProof(modelModule);
    globalThis.__SRA009_AFTER_TOOL_SELECTION_RESTORE__ = undefined;
    const result = {
      mode,
      llmStopStatus: setup.stopStatuses[0]?.status,
      remoteStopStatus: setup.stopStatuses[1]?.status,
      fixtureListenerStopped: await fixtureListenerStopped(setup.llmUrl),
    };
    console.log(`SRA009_SETUP_RESTORE ${JSON.stringify(result)}`);
    expect(result).toEqual({
      mode: "setup-error",
      llmStopStatus: "fulfilled",
      remoteStopStatus: "rejected",
      fixtureListenerStopped: true,
    });
  };

  if (mode === "setup-error") {
    process.env.SRA009_FAIL_SETUP_AFTER_ENV = "1";
  }

  await import(targetTest);
}

afterAll(async () => {
  try {
    if (mode !== undefined) {
      const modelModule: unknown = await import(modelModulePath);
      if (!hasModelCompleter(modelModule)) {
        throw new Error(
          "SRA009_MODEL_MODULE_PATH did not export createModelCompleter",
        );
      }
      if (!proofEmitted) {
        await emitRestorationProof(modelModule);
      }
    }
  } finally {
    globalThis.__SRA009_AFTER_TOOL_SELECTION_RESTORE__ = undefined;
    globalThis.__SRA009_AFTER_TOOL_SELECTION_SETUP_RESTORE__ = undefined;
    delete process.env.SRA009_FAIL_SETUP_AFTER_ENV;
  }
});
