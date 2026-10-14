import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { MAX_DOCUMENT_BODY_CHARS, type KnowledgeDocumentStore } from "./store";

function parseWriteBody(body: unknown): {
  title: string;
  category: string;
  body: string;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const category =
    typeof record.category === "string" ? record.category.trim() : "";
  const text = typeof record.body === "string" ? record.body : "";
  if (!title || !category || !text.trim()) return null;
  return { title, category, body: text };
}

/**
 * Company knowledge documents: the Documents page CRUD surface.
 */
export function createDocumentRoutes(
  store: KnowledgeDocumentStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    const search = context.req.query("q") ?? undefined;
    const documents = await store.list(search);
    return context.json({ documents });
  });

  routes.get("/:id", requireUser, async (context) => {
    const document = await store.get(context.req.param("id"));
    if (!document) {
      return context.json({ error: "That document was not found." }, 404);
    }
    return context.json({ document });
  });

  routes.post("/", requireUser, async (context) => {
    const parsed = parseWriteBody(await context.req.json().catch(() => null));
    if (!parsed) {
      return context.json(
        { error: "title, category, and body are required." },
        400,
      );
    }
    if (parsed.body.length > MAX_DOCUMENT_BODY_CHARS) {
      return context.json(
        {
          error: `Document body must be at most ${MAX_DOCUMENT_BODY_CHARS} characters.`,
        },
        400,
      );
    }
    const document = await store.create({
      ...parsed,
      createdBy: context.var.actor.id,
    });
    return context.json({ document }, 201);
  });

  routes.put("/:id", requireUser, async (context) => {
    const parsed = parseWriteBody(await context.req.json().catch(() => null));
    if (!parsed) {
      return context.json(
        { error: "title, category, and body are required." },
        400,
      );
    }
    if (parsed.body.length > MAX_DOCUMENT_BODY_CHARS) {
      return context.json(
        {
          error: `Document body must be at most ${MAX_DOCUMENT_BODY_CHARS} characters.`,
        },
        400,
      );
    }
    const document = await store.update(context.req.param("id"), parsed);
    if (!document) {
      return context.json({ error: "That document was not found." }, 404);
    }
    return context.json({ document });
  });

  routes.delete("/:id", requireUser, async (context) => {
    const removed = await store.remove(context.req.param("id"));
    if (!removed) {
      return context.json({ error: "That document was not found." }, 404);
    }
    return context.body(null, 204);
  });

  return routes;
}
