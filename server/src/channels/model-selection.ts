import { and, eq, isNull } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { enterpriseControls } from "../admin/controls";
import {
  type ConversationModel,
  directModelConnection,
  ModelSelectionError,
  modelOptions,
  resolveChoice,
  type SavedModelSelection,
  unavailableModel,
} from "../agents/model-selection";
import type { AgentActor } from "../agents/profile-types";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { LoadAgentsForActor, RuntimeModel } from "../copilot";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";

function allowedModels(): readonly string[] | undefined {
  const controls = enterpriseControls();
  if (!controls) return undefined;
  const snapshot = controls.snapshot();
  if (!snapshot)
    throw new ModelSelectionError(
      "Couldn't check model access. Try again.",
      503,
    );
  return snapshot.settings.modelAllowlist.enabled
    ? snapshot.settings.modelAllowlist.models
    : undefined;
}
export function modelSelectionEnabled(): boolean {
  const controls = enterpriseControls();
  if (!controls) return true;
  const snapshot = controls.snapshot();
  if (!snapshot)
    throw new ModelSelectionError(
      "Couldn't check model access. Try again.",
      503,
    );
  return snapshot.settings.modelSelectionEnabled;
}
export function createChannelModelStore(deps: {
  database: Database;
  model: RuntimeModel;
  loadAgents: LoadAgentsForActor;
  resolveApiKey: () => Promise<string | null>;
}) {
  const { database, model } = deps;
  async function authorized(
    db: Pick<Database, "select">,
    actor: AgentActor,
    channelId: string,
    agentId: string,
    lock = false,
  ) {
    const query = db
      .select({
        agentId: channelAgents.agentId,
        deletedAt: agentProfiles.deletedAt,
        saved: intelligenceChannelMappings.modelSelection,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, actor.id),
        ),
      )
      .innerJoin(
        intelligenceChannelMappings,
        and(
          eq(intelligenceChannelMappings.channelId, channels.id),
          eq(intelligenceChannelMappings.userId, actor.id),
        ),
      )
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, channelAgents.agentId),
      )
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
    const rows = await (lock ? query.for("update") : query);
    const registered = await deps.loadAgents(actor);
    const agent = registered.find((a) => a.id === agentId);
    const row = rows.find((r) => r.agentId === agentId && r.deletedAt === null);
    if (!row || !agent)
      throw new ModelSelectionError("Couldn't find that conversation.", 404);
    const selectable =
      modelSelectionEnabled() &&
      rows.length === 1 &&
      agent.type === "built_in" &&
      directModelConnection(model, await deps.resolveApiKey());
    return { saved: row.saved, selectable };
  }
  function representation(
    state: { saved: SavedModelSelection | null; selectable: boolean },
    agentId: string,
  ): ConversationModel {
    if (!modelSelectionEnabled()) state = { saved: null, selectable: false };
    const options = state.selectable
      ? modelOptions(model, allowedModels())
      : [];
    const selectionUnavailable =
      !!state.saved &&
      (!state.selectable ||
        state.saved.agentId !== agentId ||
        state.saved.provider !== model.provider ||
        !options.some((m) => m.id === state.saved?.model));
    return {
      selectable: state.selectable,
      provider: state.selectable ? model.provider : null,
      defaultModel: state.selectable ? model.defaultModel : null,
      selectedModel: state.saved?.model ?? null,
      options,
      selectionUnavailable,
    };
  }
  const store = {
    async readOptions(actor: AgentActor, agentId: string) {
      const agent = (await deps.loadAgents(actor)).find(
        (a) => a.id === agentId,
      );
      if (!agent) throw new ModelSelectionError("Couldn't find that Bot.", 404);
      return representation(
        {
          saved: null,
          selectable:
            modelSelectionEnabled() &&
            agent.type === "built_in" &&
            directModelConnection(model, await deps.resolveApiKey()),
        },
        agentId,
      );
    },
    async read(actor: AgentActor, channelId: string, agentId: string) {
      return representation(
        await authorized(database, actor, channelId, agentId),
        agentId,
      );
    },
    async write(
      actor: AgentActor,
      channelId: string,
      agentId: string,
      selected: string | null,
    ) {
      return database.transaction(async (tx) => {
        // Serialize preference writes with channel membership/lifecycle changes.
        await tx
          .select({ id: channels.id })
          .from(channels)
          .where(eq(channels.id, channelId))
          .for("update");
        const state = await authorized(tx, actor, channelId, agentId, true);
        if (selected !== null) {
          if (!modelSelectionEnabled())
            throw new ModelSelectionError(
              "Model selection is disabled by your admin.",
              403,
            );
          if (!state.selectable)
            throw new ModelSelectionError(unavailableModel, 409);
          if (!modelOptions(model).some((m) => m.id === selected))
            throw new ModelSelectionError(unavailableModel, 400);
          if (
            !modelOptions(model, allowedModels()).some((m) => m.id === selected)
          )
            throw new ModelSelectionError(unavailableModel, 403);
        }
        const saved: SavedModelSelection | null =
          selected === null
            ? null
            : { agentId, provider: model.provider, model: selected };
        const result = await tx
          .update(intelligenceChannelMappings)
          .set({ modelSelection: saved, updatedAt: new Date() })
          .where(
            and(
              eq(intelligenceChannelMappings.userId, actor.id),
              eq(intelligenceChannelMappings.channelId, channelId),
            ),
          )
          .returning();
        if (!result.length)
          throw new ModelSelectionError(
            "Couldn't find that conversation.",
            404,
          );
        return representation({ ...state, saved }, agentId);
      });
    },
    async readForRun(
      actor: AgentActor,
      agentId: string,
      threadId: string,
    ): Promise<RuntimeModel> {
      const [mapping] = await database
        .select()
        .from(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.threadId, threadId))
        .limit(1);
      if (!mapping) return model;
      if (mapping.userId !== actor.id)
        throw new ModelSelectionError("Couldn't find that conversation.", 404);
      const state = await authorized(
        database,
        actor,
        mapping.channelId,
        agentId,
      );
      if (!modelSelectionEnabled() || !state.saved) return model;
      if (!state.selectable || state.saved.agentId !== agentId)
        throw new ModelSelectionError(unavailableModel, 409);
      // Policy is enforced below against the effective model, with one usage record.
      return resolveChoice(
        model,
        state.saved,
        modelOptions(model).map((m) => m.id),
      );
    },
  };
  return store;
}
export type ChannelModelStore = ReturnType<typeof createChannelModelStore>;

export async function governResolvedModel(
  actor: AgentActor,
  agentId: string,
  input: { threadId: string; runId: string },
  model: RuntimeModel,
) {
  const controls = enterpriseControls();
  if (!controls) return;
  const allowed = allowedModels();
  const name = `${model.provider}/${model.defaultModel}`;
  const permitted = !allowed || allowed.includes(name);
  await controls.store.recordModelUsage({
    userId: actor.id,
    agentId,
    threadId: input.threadId,
    runId: input.runId,
    model: name,
    source: "configured",
    allowed: permitted,
  });
  if (!permitted) {
    await recordAuditEvent(controls.deps.auditStore, {
      eventType: "model.refused",
      targetType: "agent",
      targetId: agentId,
      actorUserId: actor.id,
      payload: { model: name, source: "configured" },
    });
    throw new ModelSelectionError(unavailableModel, 403);
  }
}
const selectionInput = z.strictObject({
  model: z.string().trim().min(1).max(200).nullable(),
});
export function createChannelModelRoutes(
  store: ChannelModelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/model-options/:agentId", requireUser, async (c) => {
    try {
      return c.json({
        model: await store.readOptions(c.var.actor, c.req.param("agentId")),
      });
    } catch (error) {
      if (error instanceof ModelSelectionError)
        return c.json({ error: error.message }, error.status);
      console.error({ error: "model_options_request_failed" });
      return c.json({ error: "Couldn't load models. Try again." }, 503);
    }
  });
  routes.on(
    ["GET", "PUT"],
    "/:channelId/agents/:agentId/model",
    requireUser,
    async (c) => {
      try {
        const actor = c.var.actor;
        const channelId = c.req.param("channelId");
        const agentId = c.req.param("agentId");
        if (c.req.method === "GET")
          return c.json({ model: await store.read(actor, channelId, agentId) });
        const parsed = selectionInput.safeParse(
          await c.req.json().catch(() => null),
        );
        if (!parsed.success)
          return c.json({ error: "Choose a valid model." }, 400);
        return c.json({
          model: await store.write(
            actor,
            channelId,
            agentId,
            parsed.data.model,
          ),
        });
      } catch (error) {
        if (error instanceof ModelSelectionError)
          return c.json({ error: error.message }, error.status);
        console.error({
          error: "conversation_model_request_failed",
          operation: c.req.method,
        });
        return c.json({ error: "Couldn't load models. Try again." }, 503);
      }
    },
  );
  return routes;
}
