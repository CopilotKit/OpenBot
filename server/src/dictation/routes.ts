import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  dictationExtension,
  DICTATION_TIMEOUT_MS,
  dictationMediaType,
  MAX_DICTATION_BYTES,
} from "../../../shared/dictation";
import type { AppVariables } from "../auth/guards";
import { TranscriptionError, type TranscriptionProvider } from "./provider";

export function createDictationRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  provider: TranscriptionProvider | undefined,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const active = new Set<string>();
  app.use("*", requireUser);
  app.post(
    "/transcriptions",
    async (context, next) => {
      // A cross-origin HTML form cannot set this header; this route grants no CORS access.
      if (context.req.header("x-openbot-dictation") !== "1") {
        return context.json({ error: "Invalid dictation request." }, 403);
      }
      if (!provider)
        return context.json({ error: "Dictation is not configured." }, 503);
      const actorId = context.var.actor.id;
      if (active.has(actorId) || active.size >= 8) {
        return context.json(
          {
            error:
              "A transcription is already in progress. Please retry shortly.",
          },
          429,
        );
      }
      active.add(actorId);
      try {
        await next();
      } finally {
        active.delete(actorId);
      }
    },
    bodyLimit({
      maxSize: MAX_DICTATION_BYTES + 64 * 1024,
      onError: (context) =>
        context.json({ error: "Recordings must be smaller than 10 MiB." }, 413),
    }),
    async (context) => {
      const body = await context.req.raw.formData().catch(() => null);
      const file = body?.get("file");
      if (!(file instanceof File) || !file.size) {
        return context.json({ error: "An audio recording is required." }, 400);
      }
      if (file.size > MAX_DICTATION_BYTES) {
        return context.json(
          { error: "Recordings must be smaller than 10 MiB." },
          413,
        );
      }
      const mediaType = dictationMediaType(file.type);
      const extension = dictationExtension(mediaType);
      if (!extension) {
        return context.json(
          {
            error:
              "This recording format is not supported. Use WebM, MP4, or WAV audio.",
          },
          415,
        );
      }
      if (!provider)
        return context.json({ error: "Dictation is not configured." }, 503);
      const signal = AbortSignal.any([
        context.req.raw.signal,
        AbortSignal.timeout(DICTATION_TIMEOUT_MS),
      ]);
      context.header("Cache-Control", "no-store");
      try {
        const text = await provider.transcribe(
          new File([file], `recording.${extension}`, { type: mediaType }),
          signal,
        );
        if (!text)
          return context.json(
            { error: "No speech was detected. Try recording again." },
            422,
          );
        return context.json({ text });
      } catch (error) {
        if (signal.aborted) {
          return context.json(
            {
              error: "Transcription timed out or was cancelled. Please retry.",
            },
            504,
          );
        }
        return context.json(
          {
            error:
              error instanceof TranscriptionError
                ? error.message
                : "The transcription service could not be reached. Please retry.",
          },
          502,
        );
      }
    },
  );
  return app;
}
