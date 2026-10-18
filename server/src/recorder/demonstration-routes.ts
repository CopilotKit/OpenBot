import {
  actionBatchSchema,
  RECORDER_ACTION_BATCH_BYTES,
  RECORDER_OPEN_RECORDING,
  registerTrajectorySchema,
  startExtensionDemonstrationSchema,
} from "@openbot/shared/recorder-api";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { DemonstrationRecorder } from "../demonstrations/recording";
import type { DemonstrationStore } from "../demonstrations/store";
import {
  DemonstrationGapError,
  DemonstrationNotFoundError,
  DemonstrationOpenError,
  DemonstrationRefusedError,
} from "../demonstrations/types";
import type { RecorderVariables } from "./variables";

export type RecorderDemonstrationDeps = {
  store: DemonstrationStore;
  recorder: DemonstrationRecorder;
};

const JSON_BODY_LIMIT_BYTES = 2 * 1024;

/** A cross-site form can only send three content types, so requiring JSON stops one. */
const jsonOnly: MiddlewareHandler = async (context, next) => {
  if (!context.req.header("content-type")?.startsWith("application/json")) {
    return context.json({ error: "Send the request as JSON." }, 415);
  }
  await next();
};

const limit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (context) =>
      context.json({ error: "That request is too large." }, 413),
  });

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** The extension's routes for the recordings it makes, under the recorder bearer. Mounted behind `requireRecorder`. */
export function createRecorderDemonstrationRoutes(
  deps: RecorderDemonstrationDeps,
) {
  const { store, recorder } = deps;
  const routes = new Hono<{ Variables: RecorderVariables }>();
  const smallJson = [jsonOnly, limit(JSON_BODY_LIMIT_BYTES)] as const;
  const noBody = limit(JSON_BODY_LIMIT_BYTES);

  routes.onError((error, context) => {
    if (error instanceof DemonstrationNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof DemonstrationRefusedError)
      return context.json({ error: error.message }, 400);
    if (error instanceof DemonstrationGapError)
      return context.json({ error: error.message, count: error.count }, 409);
    if (error instanceof DemonstrationOpenError)
      return context.json(
        {
          error: error.message,
          code: RECORDER_OPEN_RECORDING,
          demonstrationId: error.demonstrationId,
        },
        409,
      );
    console.error(
      JSON.stringify({
        type: "recorder-demonstration-route-error",
        error: error.name,
        context: { path: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "The demonstration could not be saved. Try again." },
      503,
    );
  });

  routes.post("/", ...smallJson, async (context) => {
    const input = startExtensionDemonstrationSchema.safeParse(
      await readJson(context.req.raw),
    );
    if (!input.success)
      throw new DemonstrationRefusedError(
        "Choose a Bot and name this recording.",
      );
    const owner = context.var.actor.id;
    const started = await recorder.start(
      owner,
      input.data.botId,
      input.data.title,
      "extension",
    );
    return context.json(
      { demonstration: await store.presentExtension(owner, started.id) },
      201,
    );
  });

  routes.get("/open", async (context) => {
    const owner = context.var.actor.id;
    const open = await store.openExtension(
      owner,
      context.req.query("botId") ?? "",
    );
    return context.json({
      demonstration: open ? await store.presentExtension(owner, open.id) : null,
    });
  });

  routes.post(
    "/:id/actions",
    jsonOnly,
    limit(RECORDER_ACTION_BATCH_BYTES),
    async (context) => {
      const input = actionBatchSchema.safeParse(
        await readJson(context.req.raw),
      );
      if (!input.success)
        throw new DemonstrationRefusedError(
          "The steps could not be read. Send up to 200 steps from a known index.",
        );
      const count = await store.appendBatch(
        context.var.actor.id,
        context.req.param("id"),
        input.data.fromIndex,
        input.data.actions,
      );
      return context.json({ count });
    },
  );

  routes.post("/:id/trajectories", ...smallJson, async (context) => {
    const input = registerTrajectorySchema.safeParse(
      await readJson(context.req.raw),
    );
    if (!input.success)
      throw new DemonstrationRefusedError("The trajectory ID must be a UUID.");
    await store.registerTrajectory(
      context.var.actor.id,
      context.req.param("id"),
      input.data.trajectoryId,
    );
    return context.body(null, 204);
  });

  routes.post(
    "/:id/trajectories/:trajectoryId/close",
    noBody,
    async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      const trajectoryId = context.req.param("trajectoryId");
      const found = await store.trajectoryOwner(owner, trajectoryId);
      if (found?.demonstrationId !== id) throw new DemonstrationNotFoundError();
      await store.closeTrajectory(owner, id, trajectoryId);
      return context.body(null, 204);
    },
  );

  // The extension sends Stop with no body, so no content type is required here.
  routes.post("/:id/stop", noBody, async (context) => {
    const owner = context.var.actor.id;
    const id = context.req.param("id");
    await store.presentExtension(owner, id);
    await recorder.stop(owner, id);
    return context.json({
      demonstration: await store.presentExtension(owner, id),
    });
  });

  routes.delete("/:id", noBody, async (context) => {
    await store.removeExtension(context.var.actor.id, context.req.param("id"));
    return context.body(null, 204);
  });

  return routes;
}
