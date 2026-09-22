import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { VoiceSessionRecord } from "../../../shared/voice-session";
import type { AgentActor } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { ChannelStore } from "../channels/routes";
import {
  parseVoiceSessionInput,
  VoiceSessionError,
  type VoiceSessionStore,
} from "./sessions";
import type { VoiceSummarizer } from "./summary";

export type VoiceSessionServices = {
  store: VoiceSessionStore;
  summarize: VoiceSummarizer;
  channels: Pick<ChannelStore, "recordActivity">;
};

/** Mounted beneath the voice router's authentication middleware, independently of live voice config. */
export function createVoiceSessionRoutes(services?: VoiceSessionServices) {
  const app = new Hono<{ Variables: AppVariables }>();
  const pending = new Map<string, Promise<VoiceSessionRecord>>();
  const activeUsers = new Set<string>();
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/", async (context) => {
    if (!services)
      return context.json({ error: "Voice history is not configured." }, 503);
    const channelId = context.req.query("channelId");
    const cursor = context.req.query("cursor");
    if (!channelId || channelId.length > 256 || (cursor?.length ?? 0) > 2048)
      return context.json({ error: "A valid channel is required." }, 400);
    try {
      return context.json(
        await services.store.list(context.var.actor, channelId, cursor),
      );
    } catch (error) {
      return respondError(context, error);
    }
  });
  app.post(
    "/",
    bodyLimit({
      maxSize: 512 * 1024,
      onError: (context) =>
        context.json({ error: "Voice transcript is too large." }, 413),
    }),
    async (context) => {
      if (context.req.header("x-openbot-voice") !== "1")
        return context.json({ error: "Invalid voice request." }, 403);
      if (!services)
        return context.json({ error: "Voice history is not configured." }, 503);
      if (
        context.req.header("content-type")?.split(";")[0]?.trim() !==
        "application/json"
      )
        return context.json(
          { error: "A JSON voice session is required." },
          400,
        );
      try {
        const input = parseVoiceSessionInput(
          await context.req.json().catch(() => null),
        );
        const actor = context.var.actor;
        // Validate ownership and persist before any model request, including concurrent retries.
        const saved = await services.store.save(actor, input);
        const key = JSON.stringify([actor.id, saved.id]);
        let work = pending.get(key);
        if (!work) {
          if (activeUsers.has(actor.id) || pending.size >= 8) {
            context.header("Retry-After", "20");
            return context.json(
              {
                error:
                  "Voice transcript saved; summary service is busy. Retry shortly.",
                session: saved,
              },
              429,
            );
          }
          activeUsers.add(actor.id);
          work = finish(saved, actor, services).finally(() => {
            pending.delete(key);
            activeUsers.delete(actor.id);
          });
          pending.set(key, work);
        }
        return context.json({ session: await work });
      } catch (error) {
        return respondError(context, error);
      }
    },
  );
  return app;
}

async function finish(
  saved: VoiceSessionRecord,
  actor: AgentActor,
  services: VoiceSessionServices,
) {
  let session = saved;
  if (session.summaryStatus === "failed") {
    let summary: string | undefined;
    try {
      summary = await services.summarize(session.transcript);
    } catch {
      // The transcript is already durable. The explicit status makes this recoverable by retry.
      console.warn(
        JSON.stringify({ type: "voice-summary-failed", sessionId: session.id }),
      );
    }
    if (summary)
      session = await services.store.summarize(actor, session.id, summary);
  }
  await services.channels.recordActivity(actor, session.channelId, {
    text: `Voice chat${session.summary ? `: ${session.summary}` : ""}`,
    agentId: null,
    at: new Date(session.endedAt),
  });
  return session;
}

function respondError(
  context: import("hono").Context<{ Variables: AppVariables }>,
  error: unknown,
) {
  if (error instanceof VoiceSessionError)
    return context.json({ error: error.message }, error.status);
  console.error(JSON.stringify({ type: "voice-history-failed" }));
  return context.json(
    { error: "Voice history could not be saved or loaded. Please retry." },
    503,
  );
}
