import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { detectLocalAi } from "./detect";

/** `/api/admin/local-ai`: which AI is running on this computer, and which one is in use. Admins only. */
export function createLocalAiRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.get("/", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(await detectLocalAi(process.env));
  });
  return routes;
}
