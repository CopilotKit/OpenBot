/**
 * LangGraph in TypeScript, as an OpenBot engine: the default for new Bots on an API key, a Gemini
 * sign-in or a ChatGPT plan. See server.ts for the surface and run.ts for the graph.
 */
import { listenPort } from "../../shared/listen-port.ts";
import { createEngine } from "./server.ts";

const port = listenPort(process.env.PORT, 4215);
if (!port.ok) {
  console.error(port.reason);
  process.exit(1);
}

// 0.0.0.0: inside a container this is the container's own namespace, and Compose decides which
// host addresses it is published on.
createEngine().listen(port.port, "0.0.0.0", () => {
  console.log(`LangGraph (TypeScript) engine listening on ${port.port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => process.exit(0));
