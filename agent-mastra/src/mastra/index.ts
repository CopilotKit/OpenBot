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

async function configuredModel() {
  const provider = process.env.BOT_PROVIDER?.trim() || "openai";
  const model =
    process.env.BOT_MODEL?.trim() ||
    (provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini");
  const baseVariable =
    provider === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
  const baseURL = process.env[baseVariable]?.trim();
  // Provider modules create default clients at import, which reject Compose's empty overrides.
  if (!baseURL) delete process.env[baseVariable];

  if (provider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    // Other harnesses accept an Anthropic origin; AI SDK expects the /v1 API prefix.
    const origin = (baseURL || "https://api.anthropic.com").replace(/\/+$/, "");
    return createAnthropic({
      baseURL: origin.endsWith("/v1") ? origin : `${origin}/v1`,
    })(model);
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  const compatible =
    Boolean(baseURL) &&
    baseURL?.replace(/\/+$/, "") !== "https://api.openai.com/v1";
  const openai = createOpenAI({
    baseURL: baseURL || "https://api.openai.com/v1",
    apiKey: compatible
      ? process.env.OPENAI_API_KEY?.trim() || "no-key-needed"
      : undefined,
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

export function buildOpenBotInstructions({
  requestContext,
}: OpenBotInstructionArgs = {}) {
  const contextEntries = agUiContextEntries(requestContext);
  const openbotInstructions = OPENBOT_CONTEXT_DESCRIPTIONS.flatMap(
    (description) =>
      contextEntries
        .filter(
          (entry): entry is { description: string; value: string } =>
            typeof entry === "object" &&
            entry !== null &&
            "description" in entry &&
            entry.description === description &&
            "value" in entry &&
            typeof entry.value === "string" &&
            entry.value.trim().length > 0,
        )
        .map((entry) => entry.value.trim()),
  );

  if (openbotInstructions.length === 0) return openbotBaseInstructions;
  return [openbotBaseInstructions, ...openbotInstructions].join("\n\n");
}

const openbot = new Agent({
  id: "openbot",
  name: "openbot",
  instructions: buildOpenBotInstructions,
  model: await configuredModel(),
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
