import type {
  SaveVoiceSessionInput,
  VoiceSessionPage,
  VoiceSessionRecord,
  VoiceTranscriptEntry,
} from "@openbot/shared/voice-session";
import type { AgentActor } from "../agents/profile-types";
import type { ChannelStore } from "../channels/routes";
import { ConversationMissingError } from "../conversations/client";
import { conversations } from "../conversations/directory";
import { IntelligenceApiError, writeKey } from "../conversations/http";
import type { VoiceSessionRow } from "../conversations/types";

export class VoiceSessionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 256
  );
}

export function parseVoiceSessionInput(body: unknown): SaveVoiceSessionInput {
  const invalid = () =>
    new VoiceSessionError(
      "A valid voice session and transcript are required.",
      400,
    );
  if (
    !body ||
    typeof body !== "object" ||
    !("id" in body) ||
    !identifier(body.id) ||
    !("channelId" in body) ||
    !identifier(body.channelId) ||
    !("anchorMessageId" in body) ||
    !(body.anchorMessageId === null || identifier(body.anchorMessageId)) ||
    !("startedAt" in body) ||
    typeof body.startedAt !== "string" ||
    !("endedAt" in body) ||
    typeof body.endedAt !== "string" ||
    !("transcript" in body) ||
    !Array.isArray(body.transcript) ||
    body.transcript.length > 300 ||
    body.transcript.length === 0
  )
    throw invalid();
  const started = Date.parse(body.startedAt);
  const ended = Date.parse(body.endedAt);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(ended) ||
    ended < started ||
    ended - started > 86_400_000 ||
    ended > Date.now() + 300_000
  )
    throw invalid();
  const ids = new Set<string>();
  let length = 0;
  const transcript = body.transcript.map(
    (entry: unknown): VoiceTranscriptEntry => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("id" in entry) ||
        !identifier(entry.id) ||
        ids.has(entry.id) ||
        !("role" in entry) ||
        (entry.role !== "user" && entry.role !== "assistant") ||
        !("text" in entry) ||
        typeof entry.text !== "string" ||
        !entry.text.trim()
      )
        throw invalid();
      ids.add(entry.id);
      length += entry.text.length;
      if (length > 60_000) throw invalid();
      return { id: entry.id, role: entry.role, text: entry.text };
    },
  );
  return {
    id: body.id,
    channelId: body.channelId,
    anchorMessageId: body.anchorMessageId,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
    transcript,
  };
}

export type VoiceSessionStore = {
  save(
    actor: AgentActor,
    input: SaveVoiceSessionInput,
  ): Promise<VoiceSessionRecord>;
  list(
    actor: AgentActor,
    channelId: string,
    cursor?: string,
  ): Promise<VoiceSessionPage>;
  summarize(
    actor: AgentActor,
    id: string,
    summary: string,
  ): Promise<VoiceSessionRecord>;
};

function record(row: VoiceSessionRow): VoiceSessionRecord {
  return {
    id: row.id,
    channelId: row.conversationId,
    anchorMessageId: row.anchorMessageId,
    // To the millisecond, as the browser sent them and as they always came back.
    startedAt: new Date(row.startedAt).toISOString(),
    endedAt: new Date(row.endedAt).toISOString(),
    durationSeconds: row.durationSeconds,
    transcript: row.transcript,
    summary: row.summary,
    summaryStatus: row.summaryStatus,
  };
}

function sameInput(row: VoiceSessionRecord, input: SaveVoiceSessionInput) {
  return (
    row.channelId === input.channelId &&
    row.anchorMessageId === input.anchorMessageId &&
    row.startedAt === input.startedAt &&
    row.endedAt === input.endedAt &&
    JSON.stringify(row.transcript) === JSON.stringify(input.transcript)
  );
}

/**
 * A person's spoken conversations, in Intelligence (voice sessions, under the conversation they were
 * held in). Intelligence checks, as it writes one, that the person is still in that conversation and
 * it is not deleted; whether its Bots are all still there is OpenBot's to check, from the Bots it
 * holds, before it writes.
 */
export function createVoiceSessionStore(
  channelStore: Pick<ChannelStore, "get">,
): VoiceSessionStore {
  async function requireChannel(
    actor: AgentActor,
    channelId: string,
    write = false,
  ) {
    const channel = await channelStore.get(actor, channelId);
    if (!channel)
      throw new VoiceSessionError("Couldn't find that conversation.", 404);
    if (write && !channel.active)
      throw new VoiceSessionError("This channel is no longer active.", 409);
  }

  return {
    async save(actor, unvalidated) {
      const input = parseVoiceSessionInput(unvalidated);
      await requireChannel(actor, input.channelId, true);
      let saved: VoiceSessionRow;
      try {
        ({ session: saved } = await conversations().client.voice.create(
          {
            id: input.id,
            conversationId: input.channelId,
            userId: actor.id,
            anchorMessageId: input.anchorMessageId,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            durationSeconds: Math.round(
              (Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 1000,
            ),
            transcript: input.transcript,
          },
          writeKey("voice.save"),
        ));
      } catch (error) {
        // Left the conversation, or it was deleted, since the check above.
        if (error instanceof ConversationMissingError)
          throw new VoiceSessionError("Couldn't find that conversation.", 404);
        throw error;
      }
      // The same save again returns the session it made; a different one under its id is refused.
      if (saved.userId !== actor.id || !sameInput(record(saved), input))
        throw new VoiceSessionError(
          "This voice session ID is already in use.",
          409,
        );
      return record(saved);
    },
    async list(actor, channelId, cursor) {
      await requireChannel(actor, channelId);
      try {
        const page = await conversations().client.voice.page(
          channelId,
          cursor ?? null,
          50,
        );
        return {
          sessions: page.sessions.map(record),
          nextCursor: page.nextCursor,
        };
      } catch (error) {
        if (error instanceof IntelligenceApiError && error.status === 400)
          throw new VoiceSessionError("Invalid voice history cursor.", 400);
        throw error;
      }
    },
    async summarize(actor, id, summary) {
      if (!summary.trim() || summary.length > 4000)
        throw new VoiceSessionError("Invalid voice summary.", 400);
      const existing = await conversations().client.voice.get(id);
      if (!existing || existing.userId !== actor.id)
        throw new VoiceSessionError("Voice session not found.", 404);
      await requireChannel(actor, existing.conversationId, true);
      // A competing replica may have finished first: Intelligence never replaces a ready summary
      // and returns it, so both callers publish the same preview.
      return record(
        await conversations().client.voice.summarise(
          id,
          summary.trim(),
          writeKey("voice.summary"),
        ),
      );
    },
  };
}
