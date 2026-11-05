/**
 * The model a person picked for one conversation, kept on the server and read when a run starts.
 *
 * WHY THE SERVER HOLDS IT. A run is the server's own decision about which model to pay for, so the
 * browser never names the model on the run itself: it saves a pick here, through a route that checks
 * the switch, the conversation and the catalogue, and every later run of that conversation reads it
 * back by its thread. A pick therefore follows the person to another browser, applies to runs the
 * browser does not start, and cannot be forged on the wire.
 *
 * Per person, on the row that already maps a person and a conversation to their thread
 * (`intelligence_channel_mappings`), so a run finds its pick by the thread it is answering in.
 *
 * Read only while an admin lets people pick (`modelSelection`, always on in the personal edition).
 * Off, every run uses the configured model and the saved picks are left alone, so turning it back
 * on brings them back. A saved pick the catalogue no longer offers (the allowlist narrowed, the
 * provider retired it, the deployment moved to another provider) is not used either: the run takes
 * the configured model, which is also what the picker then shows.
 */
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { enterpriseControls } from "../admin/controls";
import type { AppVariables } from "../auth/guards";
import type { RuntimeModel } from "../copilot";
import type { Database } from "../db/client";
import { intelligenceChannelMappings } from "../db/schema";
import { currentEdition } from "../edition";
import type { ModelCatalogueReader } from "../model-catalogue";

/** Whether people may pick a model right now. From the controls' snapshot, so a run pays no query. */
export function modelSelectionOn(): boolean {
  const settings = enterpriseControls()?.snapshot()?.settings;
  if (settings) return settings.modelSelection;
  // No controls installed yet: only the personal edition, which fixes it on, may pick.
  return currentEdition() === "personal";
}

export class ModelChoiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message);
    this.name = "ModelChoiceError";
  }
}

export function createModelChoices(deps: {
  database: Database;
  model: RuntimeModel;
  catalogue: ModelCatalogueReader;
  /** Injected so a test can flip it; the deployment reads the admin switch. */
  enabled?: () => boolean;
}) {
  const { database, model, catalogue } = deps;
  const enabled = deps.enabled ?? modelSelectionOn;

  /** The saved pick for one person's conversation, when it is one this deployment can use. */
  async function usable(
    saved: { provider: string; model: string } | null | undefined,
  ): Promise<string | undefined> {
    if (!saved || saved.provider !== model.provider) return undefined;
    return (await catalogue.allows(saved.model)) ? saved.model : undefined;
  }

  return {
    /**
     * What one person's conversation runs on: their pick when it can be used, or null for the
     * configured model. Null too while picking is off.
     */
    async read(actorId: string, channelId: string): Promise<string | null> {
      const [row] = await database
        .select({ saved: intelligenceChannelMappings.modelSelection })
        .from(intelligenceChannelMappings)
        .where(
          and(
            eq(intelligenceChannelMappings.userId, actorId),
            eq(intelligenceChannelMappings.channelId, channelId),
          ),
        )
        .limit(1);
      if (!row)
        throw new ModelChoiceError("Couldn't find that conversation.", 404);
      if (!enabled()) return null;
      return (await usable(row.saved)) ?? null;
    },

    /** Save a pick, or forget it with null. Refused while picking is off or for a model not offered. */
    async save(
      actorId: string,
      channelId: string,
      picked: string | null,
    ): Promise<string | null> {
      if (!enabled())
        throw new ModelChoiceError(
          "Choosing a model is turned off. Ask an admin to turn it on.",
          403,
        );
      const next =
        picked === null || picked === model.defaultModel ? null : picked;
      if (next !== null && !(await catalogue.allows(next)))
        throw new ModelChoiceError(
          "That model isn't available. Pick another one.",
          400,
        );
      const updated = await database
        .update(intelligenceChannelMappings)
        .set({
          modelSelection:
            next === null ? null : { provider: model.provider, model: next },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(intelligenceChannelMappings.userId, actorId),
            eq(intelligenceChannelMappings.channelId, channelId),
          ),
        )
        .returning({ channelId: intelligenceChannelMappings.channelId });
      if (updated.length === 0)
        throw new ModelChoiceError("Couldn't find that conversation.", 404);
      return next;
    },

    /**
     * The model a run in this thread should use, or undefined for the configured one. Bound to the
     * person running it: the thread is theirs, so another person's pick is never read.
     */
    async forRun(
      actorId: string,
      threadId: string,
    ): Promise<string | undefined> {
      if (!enabled() || model.plan) return undefined;
      const [row] = await database
        .select({ saved: intelligenceChannelMappings.modelSelection })
        .from(intelligenceChannelMappings)
        .where(
          and(
            eq(intelligenceChannelMappings.userId, actorId),
            eq(intelligenceChannelMappings.threadId, threadId),
          ),
        )
        .limit(1);
      return usable(row?.saved);
    },
  };
}

export type ModelChoices = ReturnType<typeof createModelChoices>;

/**
 * `GET` and `PUT /api/channels/:channelId/model`: one person's pick for one conversation.
 *
 * Answers `{ model }`, null meaning the configured model. A conversation the person is not in has no
 * mapping row for them, so it is a 404 like any conversation they cannot see.
 */
export function createModelChoiceRoutes(
  choices: ModelChoices,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof ModelChoiceError)
      return context.json({ error: error.message }, error.status);
    console.error(
      JSON.stringify({ type: "model-choice-route-error", error: error.name }),
    );
    return context.json({ error: "Couldn't save the model. Try again." }, 500);
  });

  routes.get("/:channelId/model", async (context) =>
    context.json({
      model: await choices.read(
        context.var.actor.id,
        context.req.param("channelId"),
      ),
    }),
  );

  routes.put("/:channelId/model", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      model?: unknown;
    } | null;
    const picked = body?.model;
    if (picked !== null && (typeof picked !== "string" || !picked.trim()))
      return context.json(
        { error: "Send a model id, or null for the default." },
        400,
      );
    return context.json({
      model: await choices.save(
        context.var.actor.id,
        context.req.param("channelId"),
        picked === null ? null : picked.trim(),
      ),
    });
  });

  return routes;
}
