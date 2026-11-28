/**
 * Mastra as a Bot.
 *
 * Mastra brings its own HTTP server, so unlike the Python harnesses this one is not a FastAPI app
 * with a route bolted on: it is a plain Mastra server, and that is the whole point. Mastra already
 * serves its agents over its own API, and OpenBot dials that API through `@ag-ui/mastra`, the bridge
 * Mastra and AG-UI maintain between them. See `remoteTransport` in server/src/copilot.ts.
 *
 * SO THERE IS NO AG-UI ROUTE HERE, deliberately. An earlier version mounted `registerCopilotKit`
 * from `@ag-ui/mastra/copilotkit`, which serves the CopilotKit Runtime protocol rather than AG-UI:
 * a different wire format that answers a run with a complaint about a missing `method` field. The
 * translation belongs on OpenBot's side, in one place, where every remote Bot is governed the same
 * way — not in each harness.
 */
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import { listenPort } from "../../../shared/listen-port";
import {
  apiKeyOrPlaceholder,
  botSettings,
  providerSpec,
} from "../../../shared/model-providers";

/** The providers this Bot can drive: the ones whose SDK modules it loads below. */
const SUPPORTED_PROVIDERS = new Set(["openai", "anthropic"]);

/**
 * The model this Bot answers with, read from the spec file rather than remembered in this file.
 *
 * `shared/model-providers.json` holds this Bot's `bots.agent-mastra` row and the provider facts
 * around it; `BOT_PROVIDER` and `BOT_MODEL` still win over both, as they always have. The file
 * says which providers exist; this file still decides which of them it can drive, because only two
 * SDK modules are loaded here. Both halves refuse at startup: a provider the file has not heard of,
 * and one it has that this harness has no module for, used to fall through to the OpenAI branch
 * below and answer with a model the deployment never chose.
 */
async function buildModel(runKey?: string) {
  const settings = botSettings("agent-mastra");
  const providerName = settings.provider;
  const spec = providerSpec(providerName);
  if (!spec) {
    // What to use is what this harness answers on, which is narrower than the registry.
    throw new Error(
      `BOT_PROVIDER=${providerName} is not one this Bot knows. Use ${[...SUPPORTED_PROVIDERS].join(" or ")}.`,
    );
  }
  if (!SUPPORTED_PROVIDERS.has(spec.id)) {
    throw new Error(
      `BOT_PROVIDER=${providerName} names ${spec.label}, and this Bot loads no ${spec.label} module. It answers on OpenAI and Anthropic only.`,
    );
  }
  const model = settings.model;
  const baseVariable = spec.baseUrlVariable;
  const baseURL = process.env[baseVariable]?.trim();
  // Provider modules create default clients at import, which reject Compose's empty overrides.
  if (!baseURL) delete process.env[baseVariable];

  // The run's own gateway token, only where the address is OpenBot's model gateway.
  const key = runKey && baseURL && onTheGateway(baseURL) ? runKey : undefined;

  if (spec.id === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    // Other harnesses accept an Anthropic origin; AI SDK expects the /v1 API prefix.
    const origin = (baseURL || "https://api.anthropic.com").replace(/\/+$/, "");
    return createAnthropic({
      baseURL: origin.endsWith("/v1") ? origin : `${origin}/v1`,
      ...(key ? { apiKey: key } : {}),
    })(model);
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  const compatible =
    Boolean(baseURL) &&
    baseURL?.replace(/\/+$/, "") !== "https://api.openai.com/v1";
  const openai = createOpenAI({
    baseURL: baseURL || "https://api.openai.com/v1",
    apiKey:
      key ??
      (compatible
        ? apiKeyOrPlaceholder(process.env[spec.keyVariable])
        : undefined),
  });
  // Compatible endpoints commonly expose Chat Completions; OpenAI keeps its Responses default.
  return compatible ? openai.chat(model) : openai(model);
}
const port = listenPort(process.env.PORT, 4213);
if (!port.ok) throw new Error(port.reason);

export const openbotBaseInstructions =
  "Answer the question you are asked, briefly and correctly.";

const OPENBOT_CONTEXT_DESCRIPTIONS = [
  "OpenBot standing role",
  "OpenBot granted tools guidance",
  "OpenBot learned skills",
] as const;

type OpenBotInstructionArgs = {
  requestContext?: {
    get(key: string): unknown;
  };
};

function agUiContextEntries(
  requestContext?: OpenBotInstructionArgs["requestContext"],
) {
  const agUi = requestContext?.get("ag-ui");
  if (
    typeof agUi !== "object" ||
    agUi === null ||
    !("context" in agUi) ||
    !Array.isArray(agUi.context)
  ) {
    return [];
  }
  return agUi.context;
}

type ContextEntry = { description: string; value: string };

function isUsableEntry(entry: unknown): entry is ContextEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "description" in entry &&
    typeof entry.description === "string" &&
    "value" in entry &&
    typeof entry.value === "string" &&
    entry.value.trim().length > 0
  );
}

/**
 * What the model is told: the base line, OpenBot's three model-visible entries in a fixed order,
 * then whatever the calling surface sent, as `description: value`.
 *
 * Every other `OpenBot …` entry is for this process, not the model: the Bot id, the deployment's
 * tool list, and the signed run assertion, which is a credential. The server keeps callers out of
 * that namespace (`RESERVED_MASTRA_CONTEXT_DESCRIPTIONS` in server/src/copilot.ts), so the prefix
 * is a safe line to draw. `OpenBot personal memory` is for the model, but as untrusted data, not
 * as an instruction: the server sends the same records as a quoted conversation row
 * (`quotedConversationRow` in server/src/copilot.ts), so it stays out of here too. Caller context
 * used to be dropped here altogether, although the server forwards it and every other harness puts
 * it in front of the model.
 */
export function buildOpenBotInstructions({
  requestContext,
}: OpenBotInstructionArgs = {}) {
  const contextEntries =
    agUiContextEntries(requestContext).filter(isUsableEntry);
  const openbotInstructions = OPENBOT_CONTEXT_DESCRIPTIONS.flatMap(
    (description) =>
      contextEntries
        .filter((entry) => entry.description === description)
        .map((entry) => entry.value.trim()),
  );
  const callerInstructions = contextEntries
    .filter((entry) => !entry.description.startsWith("OpenBot "))
    .map((entry) =>
      entry.description.trim()
        ? `${entry.description.trim()}: ${entry.value.trim()}`
        : entry.value.trim(),
    );

  const instructions = [...openbotInstructions, ...callerInstructions];
  if (instructions.length === 0) return openbotBaseInstructions;
  return [openbotBaseInstructions, ...instructions].join("\n\n");
}

/** OpenBot's model gateway: its OpenAI and Anthropic wires are under this path on the server. */
const GATEWAY_PATH = "/api/model-provider/";

function onTheGateway(baseURL: string): boolean {
  try {
    return `${new URL(baseURL.trim()).pathname.replace(/\/+$/, "")}/`.includes(
      GATEWAY_PATH,
    );
  } catch {
    return false;
  }
}

/**
 * The run's own gateway token, in its organization, which the server sends a harness it runs as
 * the `OpenBot model route` context entry: `{"via": "openai" | "anthropic", "token": ...}`.
 *
 * One harness serves every organization of an OpenBot, and the key in its environment is the
 * deployment's gateway token, which names one organization. A run with none keeps that key.
 */
export function runKeyFrom(
  requestContext?: OpenBotInstructionArgs["requestContext"],
): string | undefined {
  const entry = agUiContextEntries(requestContext).find(
    (candidate): candidate is ContextEntry =>
      isUsableEntry(candidate) &&
      candidate.description === "OpenBot model route",
  );
  if (!entry) return undefined;
  try {
    const route = JSON.parse(entry.value) as { via?: unknown; token?: unknown };
    if (route.via !== "openai" && route.via !== "anthropic") return undefined;
    return typeof route.token === "string" && route.token.trim()
      ? route.token.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

// Built at start, so a provider this Bot cannot drive is refused before it serves anything.
const deploymentModel = await buildModel();

const openbot = new Agent({
  id: "openbot",
  name: "openbot",
  instructions: buildOpenBotInstructions,
  // A run that brought its own gateway token answers on a model that calls with it.
  model: async ({ requestContext }) => {
    const key = runKeyFrom(requestContext);
    return key ? buildModel(key) : deploymentModel;
  },
});

/** The one header OpenBot's server sends, compared without leaking length through timing. */
function carriesTheServerToken(request: Request): boolean {
  const expected = (process.env.MANAGED_AGENT_TOKEN ?? "").trim();
  const offered = (request.headers.get("x-openbot-agent-token") ?? "").trim();
  // Unset means unconfigured, not open.
  if (!expected || offered.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < offered.length; index += 1) {
    difference |= offered.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export const mastra = new Mastra({
  agents: { openbot },
  server: {
    port: port.port,
    host: "0.0.0.0",
    middleware: [
      // Everything but `/health`, which Compose polls before any token exists.
      async (context, next) => {
        if (new URL(context.req.url).pathname === "/health") return next();
        if (!carriesTheServerToken(context.req.raw)) {
          return context.json({ error: "unauthorised" }, 401);
        }
        return next();
      },
    ],
    apiRoutes: [
      registerApiRoute("/health", {
        method: "GET",
        handler: async (context) =>
          context.json({ ok: true, harness: "mastra" }),
      }),
    ],
  },
});
