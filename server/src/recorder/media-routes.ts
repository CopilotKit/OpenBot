import {
  completeMediaSchema,
  createMediaSchema,
  RECORDER_MEDIA_CHUNK_BYTES,
} from "@openbot/shared/recorder-api";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  DemonstrationMediaConflictError,
  DemonstrationMediaRefusedError,
  type DemonstrationMediaStore,
} from "../demonstrations/media-store";
import { DemonstrationNotFoundError } from "../demonstrations/types";
import type { RecorderVariables } from "./variables";

const JSON_BODY_LIMIT_BYTES = 2 * 1024;

/** A cross-site form can only send three content types, so requiring one stops it. */
const only =
  (type: string, message: string): MiddlewareHandler =>
  async (context, next) => {
    if (!context.req.header("content-type")?.startsWith(type))
      return context.json({ error: message }, 415);
    await next();
  };
const jsonOnly = only("application/json", "Send the request as JSON.");
const bytesOnly = only(
  "application/octet-stream",
  "Send the recording chunk as bytes.",
);

const limit = (maxSize: number, message: string) =>
  bodyLimit({
    maxSize,
    onError: (context) => context.json({ error: message }, 413),
  });

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** The extension's routes for a recording's media (screen, audio, network bodies), under the recorder bearer. Mounted at `/demonstrations/:id/media` behind `requireRecorder`; there is no `GET /`. */
export function createRecorderMediaRoutes(deps: {
  media: DemonstrationMediaStore;
}) {
  const { media } = deps;
  const routes = new Hono<{ Variables: RecorderVariables }>();
  const smallJson = [
    jsonOnly,
    limit(JSON_BODY_LIMIT_BYTES, "That request is too large."),
  ] as const;

  routes.onError((error, context) => {
    if (error instanceof DemonstrationNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof DemonstrationMediaRefusedError)
      return context.json({ error: error.message }, 400);
    if (error instanceof DemonstrationMediaConflictError)
      return context.json({ error: error.message }, 409);
    console.error(
      JSON.stringify({
        type: "recorder-media-route-error",
        error: error.name,
        context: { path: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "The recording could not be saved. Try again." },
      503,
    );
  });

  routes.post("/", ...smallJson, async (context) => {
    const input = createMediaSchema.safeParse(await readJson(context.req.raw));
    if (!input.success)
      throw new DemonstrationMediaRefusedError(
        "Choose a recording kind and a matching type.",
      );
    return context.json(
      {
        media: await media.create(
          context.var.actor.id,
          context.req.param("id") ?? "",
          input.data,
        ),
      },
      201,
    );
  });

  routes.put(
    "/:mediaId/chunks/:index",
    bytesOnly,
    limit(
      RECORDER_MEDIA_CHUNK_BYTES,
      "A recording chunk must be 512 KiB or smaller.",
    ),
    async (context) => {
      const rawIndex = context.req.param("index") ?? "";
      if (!/^\d+$/.test(rawIndex))
        throw new DemonstrationMediaRefusedError(
          "A part of the recording needs a whole number position from zero.",
        );
      const bytes = new Uint8Array(await context.req.arrayBuffer());
      return context.json({
        media: await media.putChunk(
          context.var.actor.id,
          context.req.param("id") ?? "",
          context.req.param("mediaId") ?? "",
          Number(rawIndex),
          bytes,
        ),
      });
    },
  );

  routes.get("/:mediaId", async (context) =>
    context.json({
      media: await media.get(
        context.var.actor.id,
        context.req.param("id") ?? "",
        context.req.param("mediaId") ?? "",
      ),
    }),
  );

  routes.post("/:mediaId/complete", ...smallJson, async (context) => {
    const input = completeMediaSchema.safeParse(
      await readJson(context.req.raw),
    );
    if (!input.success)
      throw new DemonstrationMediaRefusedError(
        "Say how many chunks the recording has.",
      );
    return context.json({
      media: await media.complete(
        context.var.actor.id,
        context.req.param("id") ?? "",
        context.req.param("mediaId") ?? "",
        input.data.chunkCount,
      ),
    });
  });

  return routes;
}
