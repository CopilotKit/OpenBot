/**
 * Project folders: the HTTP half.
 *
 * Two routers, because the feature sits under two prefixes: the folders themselves, and the filing
 * of one conversation. Keeping them here rather than in `channels/routes.ts` leaves every existing
 * channel route resolving its caller in `channel_memberships` exactly as it did — the move route
 * does the same check against the same table in `store.moveChannel`.
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  MAX_PROJECT_NAME_LENGTH,
  ProjectChannelNotFoundError,
  ProjectNotFoundError as ProjectMissing,
  type ProjectStore,
  type ProjectSummary,
} from "./store";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A folder name, from what the browser sent.
 *
 * Trimmed and collapsed to one line: the name is drawn in a sidebar row and used nowhere else, so
 * a newline in it is a rendering bug rather than a feature. 60 is the ceiling because the row
 * truncates anyway and a name nobody can read back in full is worse than a refusal.
 */
export function parseProjectName(input: unknown): Parsed<{ name: string }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Project input must be a JSON object." };
  }
  const { name } = input as { name?: unknown };
  if (typeof name !== "string") {
    return { ok: false, error: "A project name is required." };
  }
  const cleaned = name.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) {
    return { ok: false, error: "A project name is required." };
  }
  if (cleaned.length > MAX_PROJECT_NAME_LENGTH) {
    return {
      ok: false,
      error: `A project name can be at most ${MAX_PROJECT_NAME_LENGTH} characters.`,
    };
  }
  return { ok: true, value: { name: cleaned } };
}

/** `{ projectId: string | null }`, which is what "move" and "remove from project" both send. */
export function parseProjectMove(input: unknown): Parsed<{ projectId: string | null }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Move input must be a JSON object." };
  }
  const body = input as { projectId?: unknown };
  if (!("projectId" in body)) {
    return {
      ok: false,
      error: "projectId must be a project id, or null to take the conversation out.",
    };
  }
  if (body.projectId === null) return { ok: true, value: { projectId: null } };
  if (typeof body.projectId !== "string" || body.projectId.trim() === "") {
    return {
      ok: false,
      error: "projectId must be a project id, or null to take the conversation out.",
    };
  }
  return { ok: true, value: { projectId: body.projectId.trim() } };
}

/** A folder as the browser sees it: dates as ISO-8601, like every other channel payload. */
function projectDto(project: ProjectSummary) {
  return {
    id: project.id,
    name: project.name,
    sortOrder: project.sortOrder,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    channelIds: project.channelIds,
  };
}

function mapProjectError(context: Context, error: unknown): Response {
  if (error instanceof ProjectMissing) {
    return context.json({ error: "Couldn't find that project." }, 404);
  }
  if (error instanceof ProjectChannelNotFoundError) {
    return context.json({ error: "Couldn't find that conversation." }, 404);
  }
  throw error;
}

/** `/api/projects`: this person's folders. Owner-scoped from the session, never from the path. */
export function createProjectRoutes(
  store: ProjectStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    const projects = await store.list(context.var.actor);
    return context.json({ projects: projects.map(projectDto) });
  });

  routes.post("/", requireUser, async (context) => {
    const parsed = parseProjectName(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const project = await store.create(context.var.actor, parsed.value.name);
    return context.json({ project: projectDto(project) }, 201);
  });

  routes.patch("/:projectId", requireUser, async (context) => {
    const parsed = parseProjectName(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      const project = await store.rename(
        context.var.actor,
        context.req.param("projectId"),
        parsed.value.name,
      );
      return context.json({ project: projectDto(project) });
    } catch (error) {
      return mapProjectError(context, error);
    }
  });

  routes.delete("/:projectId", requireUser, async (context) => {
    try {
      await store.remove(context.var.actor, context.req.param("projectId"));
      return context.body(null, 204);
    } catch (error) {
      return mapProjectError(context, error);
    }
  });

  return routes;
}

/**
 * `/api/channels/:channelId/project`: file one conversation, or take it back out.
 *
 * Returns 204 because nothing about the conversation changes except where its owner's sidebar draws
 * it; the browser refetches the roster and the folders, both of which it already holds.
 */
export function createChannelProjectRoutes(
  store: ProjectStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.patch("/:channelId/project", requireUser, async (context) => {
    const parsed = parseProjectMove(await context.req.json().catch(() => null));
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const channelId = context.req.param("channelId");
    if (!channelId.trim()) {
      return context.json({ error: "A channel id is required." }, 400);
    }
    try {
      await store.moveChannel(
        context.var.actor,
        channelId,
        parsed.value.projectId,
      );
      return context.body(null, 204);
    } catch (error) {
      return mapProjectError(context, error);
    }
  });

  return routes;
}