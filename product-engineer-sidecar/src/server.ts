import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadSidecarConfig } from "./config.js";
import { createProductEngineerRoutes } from "./routes.js";
import { createProductEngineerRunner } from "./runner.js";
import { createProductEngineerStore } from "./store.js";

const config = loadSidecarConfig();
if (!config) {
  console.error(
    "Product Engineer sidecar needs CURSOR_API_KEY, LINEAR_API_KEY, and PE_REPOS. See product-engineer-sidecar/README.md.",
  );
  process.exit(1);
}

const store = createProductEngineerStore(config.runsDir);
const runner = createProductEngineerRunner(store, config.productEngineer);

const app = new Hono();
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
  }),
);

app.get("/health", (context) =>
  context.json({ ok: true, service: "product-engineer-sidecar" }),
);

app.use("/api/product-engineer/*", async (context, next) => {
  if (!config.token) return next();
  const header = context.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1] !== config.token) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  return next();
});

app.route(
  "/api/product-engineer",
  createProductEngineerRoutes(store, runner),
);

const bunGlobal = globalThis as typeof globalThis & {
  Bun?: {
    serve: (options: {
      fetch: typeof app.fetch;
      port: number;
      hostname: string;
    }) => { port: number };
  };
};

if (bunGlobal.Bun?.serve) {
  bunGlobal.Bun.serve({
    fetch: app.fetch,
    port: config.port,
    hostname: "0.0.0.0",
  });
  console.log(
    `[product-engineer-sidecar] listening on :${config.port} (runs → ${config.runsDir}${config.token ? ", token required" : ", open local auth"})`,
  );
} else {
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, () => {
    console.log(
      `[product-engineer-sidecar] listening on :${config.port} (runs → ${config.runsDir}${config.token ? ", token required" : ", open local auth"})`,
    );
  });
}
