/**
 * Mastra as a Bot.
 *
 * Mastra brings its own HTTP server, so unlike the Python harnesses this one is not a FastAPI app
 * with a route bolted on: the route is registered with Mastra and Mastra serves it.
 * `registerCopilotKit` is Mastra's own helper, from `@ag-ui/mastra/copilotkit`, so the protocol
 * still is not ours.
 */
import { registerCopilotKit } from "@ag-ui/mastra/copilotkit";
import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";

const model = (process.env.BOT_MODEL ?? "gpt-4o-mini").trim();

const openbot = new Agent({
  name: "openbot",
  instructions: "Answer the question you are asked, briefly and correctly.",
  model: openai(model),
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
    port: Number(process.env.PORT ?? 4213),
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
        handler: async (context) => context.json({ ok: true, harness: "mastra" }),
      }),
      registerCopilotKit({ path: "/", resourceId: "openbot" }),
    ],
  },
});
