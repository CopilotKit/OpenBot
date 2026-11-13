import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import {
  type ProductTelemetry,
  parseConsumption,
  parseStarPrompt,
} from "./product";

export function createProductTelemetryRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  telemetry: Pick<ProductTelemetry, "consume" | "starPrompt">,
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
      // One of two strict shapes: a result viewed or copied, or an answer to the star prompt.
      const event = parseConsumption(raw);
      if (event) {
        await telemetry.consume(c.var.actor.id, event);
        return c.body(null, 204);
      }
      const star = parseStarPrompt(raw);
      if (!star) return c.json({ error: "Invalid event" }, 400);
      await telemetry.starPrompt(c.var.actor.id, star);
      return c.body(null, 204);
    },
  );
  return routes;
}
