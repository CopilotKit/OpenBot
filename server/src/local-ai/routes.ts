import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { detectLocalAi } from "./detect";
import { needleIsUp } from "./needle";

/** `/api/admin/local-ai`: which AI is running on this computer, and which one is in use. Admins only. */
export function createLocalAiRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.get("/", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const needleUrl = process.env.NEEDLE_URL?.trim() || null;
    const [report, up] = await Promise.all([
      detectLocalAi(process.env),
      needleUrl ? needleIsUp(needleUrl) : Promise.resolve(false),
    ]);
    return context.json({ ...report, needle: { on: Boolean(needleUrl), up } });
  });
  return routes;
}
