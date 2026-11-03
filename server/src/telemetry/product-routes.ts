import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireAdmin, type AppVariables } from "../auth/guards";
import { parseConsumption, type ProductTelemetry } from "./product";

export function createProductTelemetryRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  telemetry: Pick<ProductTelemetry, "consume" | "health">,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.post(
    "/product-events",
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: "Event too large" }, 413),
    }),
    async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "Invalid event" }, 400);
      }
      const event = parseConsumption(raw);
      if (!event) return c.json({ error: "Invalid event" }, 400);
      const result = await telemetry.consume(c.var.actor.id, event);
      if (result === "missing")
        return c.json({ error: "Result unavailable" }, 404);
      return c.body(null, result === "recorded" ? 204 : 202);
    },
  );
  routes.get("/health", async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    return c.json(telemetry.health());
  });
  return routes;
}
