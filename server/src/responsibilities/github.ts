import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ResponsibilityEvent, ResponsibilityEventResult } from "./types";

export type GithubResponsibilityBinding = {
  ownerUserId: string;
  repository: string;
  secret: string;
};
const payloadSchema = z
  .object({
    repository: z.object({ full_name: z.string().min(1) }),
    action: z.string().max(64).optional(),
  })
  .passthrough();

/** Bindings are server-held opt-in registrations. A provider payload cannot choose its actor. */
export function createGithubResponsibilityRoutes(options: {
  bindingFor: (
    bindingId: string,
  ) => Promise<GithubResponsibilityBinding | null>;
  ingest: (event: ResponsibilityEvent) => Promise<ResponsibilityEventResult>;
}) {
  const routes = new Hono();
  routes.use("*", bodyLimit({ maxSize: 32 * 1024 }));
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "github-responsibility-event-error",
        errorType: error.name,
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "GitHub event could not be accepted." }, 503);
  });
  routes.post("/:bindingId", async (context) => {
    const binding = await options.bindingFor(context.req.param("bindingId"));
    if (!binding)
      return context.json({ error: "Webhook binding not found." }, 404);
    if (
      !binding.secret.trim() ||
      !binding.repository.trim() ||
      !binding.ownerUserId.trim()
    )
      return context.json({ error: "Webhook binding is not configured." }, 503);
    const raw = await context.req.text();
    const signature = context.req.header("x-hub-signature-256") ?? "";
    if (!/^sha256=[0-9a-f]{64}$/.test(signature))
      return context.json({ error: "Invalid GitHub signature." }, 401);
    const supplied = Buffer.from(signature.slice(7), "hex");
    const expected = createHmac("sha256", binding.secret).update(raw).digest();
    if (!timingSafeEqual(supplied, expected))
      return context.json({ error: "Invalid GitHub signature." }, 401);
    const deliveryId = context.req.header("x-github-delivery")?.trim();
    const eventType = context.req.header("x-github-event")?.trim();
    if (
      !deliveryId ||
      deliveryId.length > 256 ||
      !eventType ||
      !/^[a-z_]{1,64}$/.test(eventType)
    )
      return context.json({ error: "GitHub event identity is required." }, 400);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return context.json({ error: "GitHub event is not valid JSON." }, 400);
    }
    const payload = payloadSchema.safeParse(value);
    if (!payload.success)
      return context.json(
        { error: "GitHub repository identity is required." },
        400,
      );
    if (
      payload.data.repository.full_name.toLowerCase() !==
      binding.repository.toLowerCase()
    )
      return context.json(
        { error: "Repository is not registered for this webhook." },
        403,
      );
    const result = await options.ingest({
      ownerUserId: binding.ownerUserId,
      source: "github",
      // GitHub signs only the body; X-GitHub-Delivery is unsigned, so a captured request replayed
      // with a fresh one would run again. A redelivery resends the same body and still dedupes.
      externalId: `body-${createHash("sha256").update(raw).digest("hex")}`,
      type: payload.data.action
        ? `${eventType}.${payload.data.action}`
        : eventType,
      payload: payload.data,
    });
    return context.json(result, 202);
  });
  return routes;
}
