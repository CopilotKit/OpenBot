// A real CopilotKit runtime serving real OpenAI agents, for record.ts. It runs as its own process, from the CopilotKit
// checkout named by COPILOTKIT_CHECKOUT (built), so the recording client's browser globals never reach it. With
// INTELLIGENCE_API_URL, INTELLIGENCE_GATEWAY_WS_URL and INTELLIGENCE_API_KEY set it runs through Intelligence, and the
// browser side receives AG-UI over the Intelligence WebSocket instead of SSE. Prints `ready <port>` once it listens on
// 127.0.0.1.
const checkout = process.env.COPILOTKIT_CHECKOUT;
if (!checkout) throw new Error("COPILOTKIT_CHECKOUT is not set");
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

const {
  BuiltInAgent,
  CopilotKitIntelligence,
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotEndpointSingleRoute,
  defineTool,
} = await import(`${checkout}/packages/runtime/dist/v2/index.mjs`);
const { z } = await import(
  `${checkout}/packages/runtime/node_modules/zod/index.js`
);

const lookupWeather = defineTool({
  name: "lookupWeather",
  description: "Look up today's weather for a city.",
  parameters: z.object({ city: z.string().describe("The city") }),
  execute: async ({ city }: { city: string }) => ({
    city,
    forecast: "sunny",
    celsius: 21,
  }),
});
const payInvoice = defineTool({
  name: "payInvoice",
  description: "Pay an invoice with a payment card.",
  parameters: z.object({
    invoice: z.string(),
    cardNumber: z.string().describe("The card number exactly as given"),
  }),
  execute: async ({ invoice }: { invoice: string }) => ({
    invoice,
    paid: true,
  }),
});
const approvePurchase = defineTool({
  name: "approvePurchase",
  description:
    "Ask the person to approve a purchase before it is made. Always call this before buying anything.",
  parameters: z.object({
    item: z.string(),
    amount: z.number().describe("Price in dollars"),
  }),
  interrupt: true,
  interruptMessage: "Approve this purchase?",
});

const instructions =
  "You are a terse assistant inside a test harness. Follow the person's instructions about which tools to call exactly.";
const agents = {
  default: new BuiltInAgent({
    model: "openai/gpt-4.1-mini",
    apiKey,
    maxSteps: 6,
    prompt: instructions,
    tools: [lookupWeather, payInvoice],
  }),
  shopper: new BuiltInAgent({
    model: "openai/gpt-4.1-mini",
    apiKey,
    prompt: instructions,
    tools: [approvePurchase],
  }),
  reasoner: new BuiltInAgent({
    model: "openai/gpt-5-mini",
    apiKey,
    maxSteps: 4,
    prompt: instructions,
    tools: [lookupWeather],
    providerOptions: {
      openai: { reasoningEffort: "medium", reasoningSummary: "detailed" },
    },
  }),
  // A real error from the model provider: OpenAI refuses a model that does not exist.
  broken: new BuiltInAgent({
    model: "openai/gpt-recorder-no-such-model",
    apiKey,
    prompt: instructions,
  }),
};

const intelligence = process.env.INTELLIGENCE_API_URL
  ? new CopilotKitIntelligence({
      apiUrl: process.env.INTELLIGENCE_API_URL,
      wsUrl: process.env.INTELLIGENCE_GATEWAY_WS_URL,
      apiKey: process.env.INTELLIGENCE_API_KEY,
    })
  : undefined;
const runtime = intelligence
  ? new CopilotRuntime({
      agents,
      intelligence,
      identifyUser: () => ({
        id: "recorder-agent-traffic",
        name: "Recorder agent traffic",
      }),
    })
  : new CopilotRuntime({ agents, runner: new InMemoryAgentRunner() });
const app = createCopilotEndpointSingleRoute({
  runtime,
  basePath: "/api/copilotkit",
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 0),
  fetch: app.fetch,
  idleTimeout: 120,
});
console.log(`ready ${server.port}`);

export {};
