import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import { type ProductTelemetry, parseConsumption } from "./product";

export function createProductTelemetryRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  telemetry: Pick<ProductTelemetry, "consume">,
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
      await telemetry.consume(c.var.actor.id, event);
      return c.body(null, 204);
    },
  );
  return routes;
}
