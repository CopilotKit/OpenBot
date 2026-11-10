/**
 * The model and thinking effort a person picked for one conversation, kept on the server and read
 * when a run starts.
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
 * What may be picked is the catalogue's to say: every model the credential lists for one person on
 * their own machine, the models an admin allowed in a team (`model-catalogue.ts`). A saved pick the
 * catalogue no longer offers (an admin withdrew it, the provider retired it, the deployment moved to
 * another provider) is not used: the run takes the default, which is also what the picker then
 * shows, and the pick is kept for when it is offered again. An effort is only ever sent to a model
 * that takes it.
 */
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { RuntimeModel } from "../copilot";
import type { Database } from "../db/client";
import { intelligenceChannelMappings } from "../db/schema";
import type { ModelCatalogueReader, RunChoice } from "../model-catalogue";

export class ModelChoiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message);
    this.name = "ModelChoiceError";
  }
}

/** One person's pick for one conversation, as the routes answer it. Null: the default. */
export type ConversationModel = { model: string | null; effort: string | null };

type Saved = {
  provider: string;
  model?: string | null;
  effort?: string | null;
} | null;

export function createModelChoices(deps: {
  database: Database;
  model: RuntimeModel;
  catalogue: ModelCatalogueReader;
  /** Injected so a test can flip it; the deployment reads the admin switch. */
  enabled?: () => boolean;
}) {
  const { database, model, catalogue } = deps;
  /*
   * Always, now that what may be picked is the catalogue's to say: everything for one person on
   * their own machine, what an admin allowed in a team. A pick of anything else is refused below.
   */
  const enabled = deps.enabled ?? (() => true);

  /** The saved pick, when it was made under this deployment's provider and picking is on. */
  const applicable = (saved: Saved | undefined) =>
    enabled() && saved && saved.provider === model.provider ? saved : null;

  /** What the pick means today: a model still offered, and an effort that model still takes. */
  async function shown(saved: Saved | undefined): Promise<ConversationModel> {
    const pick = applicable(saved);
    if (!pick) return { model: null, effort: null };
    const choice = await catalogue.choose(pick);
    const read = await catalogue.read();
    return {
      model:
        pick.model &&
        choice.model === pick.model &&
        choice.model !== read.default
          ? choice.model
          : null,
      effort: choice.effort ?? null,
    };
  }

  return {
    /**
     * What one person's conversation runs on, as they picked it: their model and effort when they
     * can be used, null for each that falls back to the default. Null too while picking is off.
     */
    async read(actorId: string, channelId: string): Promise<ConversationModel> {
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
      return shown(row.saved);
    },

    /**
     * Save a pick, or forget it with nulls. Refused while picking is off, for a model not offered,
     * and for an effort the model does not take.
     */
    async save(
      actorId: string,
      channelId: string,
      picked: ConversationModel,
    ): Promise<ConversationModel> {
      if (!enabled())
        throw new ModelChoiceError(
          "Choosing a model is turned off. Ask an admin to turn it on.",
          403,
        );
      const current = await catalogue.read();
      const nextModel =
        picked.model === null || picked.model === current.default
          ? null
          : picked.model;
      if (nextModel !== null && !(await catalogue.allows(nextModel)))
        throw new ModelChoiceError(
          "That model isn't available. Pick another one.",
          400,
        );
      const efforts = await catalogue.effortsFor(nextModel ?? current.default);
      if (picked.effort !== null && !efforts.includes(picked.effort))
        throw new ModelChoiceError(
          "That model can't think at that level. Pick another one.",
          400,
        );
      const next: ConversationModel = {
        model: nextModel,
        effort: picked.effort,
      };
      const updated = await database
        .update(intelligenceChannelMappings)
        .set({
          modelSelection:
            next.model === null && next.effort === null
              ? null
              : { provider: model.provider, ...next },
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
     * The model and effort a run in this thread uses: the person's pick when it can be used,
     * otherwise the default, which is the middle of the provider's current line. Bound to the
     * person running it: the thread is theirs, so another person's pick is never read.
     */
    async forRun(
      actorId: string,
      threadId: string,
      /**
       * A run nobody is watching (`runModeOf`): with no effort picked, it thinks at `high` where the
       * model takes it, since early stops are more frequent at `low` and `medium`.
       */
      options: { unattended?: boolean } = {},
    ): Promise<RunChoice> {
      const [row] = enabled()
        ? await database
            .select({ saved: intelligenceChannelMappings.modelSelection })
            .from(intelligenceChannelMappings)
            .where(
              and(
                eq(intelligenceChannelMappings.userId, actorId),
                eq(intelligenceChannelMappings.threadId, threadId),
              ),
            )
            .limit(1)
        : [];
      return catalogue.choose(
        applicable(row?.saved),
        options.unattended ? "high" : undefined,
      );
    },
  };
}

export type ModelChoices = ReturnType<typeof createModelChoices>;

/**
 * `GET` and `PUT /api/channels/:channelId/model`: one person's pick for one conversation.
 *
 * Answers `{ model, effort }`, null meaning the default for each. A conversation the person is not
 * in has no mapping row for them, so it is a 404 like any conversation they cannot see.
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
    context.json(
      await choices.read(context.var.actor.id, context.req.param("channelId")),
    ),
  );

  routes.put("/:channelId/model", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      model?: unknown;
      effort?: unknown;
    } | null;
    const picked = body?.model;
    const effort = body?.effort ?? null;
    if (picked !== null && (typeof picked !== "string" || !picked.trim()))
      return context.json(
        { error: "Send a model id, or null for the default." },
        400,
      );
    if (effort !== null && (typeof effort !== "string" || !effort.trim()))
      return context.json(
        { error: "Send an effort, or null for the model's own." },
        400,
      );
    return context.json(
      await choices.save(context.var.actor.id, context.req.param("channelId"), {
        model: picked === null ? null : picked.trim(),
        effort: effort === null ? null : effort.trim().toLowerCase(),
      }),
    );
  });

  return routes;
}
