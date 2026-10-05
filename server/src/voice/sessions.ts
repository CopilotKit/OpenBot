import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import type {
  SaveVoiceSessionInput,
  VoiceSessionPage,
  VoiceSessionRecord,
  VoiceTranscriptEntry,
} from "../../../shared/voice-session";
import type { AgentActor } from "../agents/profile-types";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelAgents,
  channelMemberships,
  channels,
  voiceSessions,
} from "../db/schema";

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

function record(row: typeof voiceSessions.$inferSelect): VoiceSessionRecord {
  return {
    id: row.id,
    channelId: row.channelId,
    anchorMessageId: row.anchorMessageId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    durationSeconds: row.durationSeconds,
    transcript: row.transcript.entries,
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

export function createVoiceSessionStore(
  database: Database,
  channelStore: Pick<ChannelStore, "get">,
): VoiceSessionStore {
  type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
  async function requireWriteAccess(
    transaction: Transaction,
    actor: AgentActor,
    channelId: string,
  ) {
    // Hold membership, channel and profiles against revocation/deletion through the write.
    const rows = await transaction
      .select({ deletedAt: agentProfiles.deletedAt })
      .from(channels)
      .innerJoin(
        channelMemberships,
        eq(channelMemberships.channelId, channels.id),
      )
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, channelAgents.agentId),
      )
      .where(
        and(
          eq(channels.id, channelId),
          eq(channelMemberships.userId, actor.id),
          isNull(channels.deletedAt),
        ),
      )
      .for("share");
    if (rows.length === 0)
      throw new VoiceSessionError("Channel not found.", 404);
    if (rows.some((row) => row.deletedAt !== null))
      throw new VoiceSessionError("This channel is no longer active.", 409);
  }
  async function requireChannel(
    actor: AgentActor,
    channelId: string,
    write = false,
  ) {
    const channel = await channelStore.get(actor, channelId);
    if (!channel) throw new VoiceSessionError("Channel not found.", 404);
    if (write && !channel.active)
      throw new VoiceSessionError("This channel is no longer active.", 409);
  }

  return {
    async save(actor, unvalidated) {
      const input = parseVoiceSessionInput(unvalidated);
      await requireChannel(actor, input.channelId, true);
      return database.transaction(async (transaction) => {
        await requireWriteAccess(transaction, actor, input.channelId);
        await transaction
          .insert(voiceSessions)
          .values({
            id: input.id,
            channelId: input.channelId,
            userId: actor.id,
            anchorMessageId: input.anchorMessageId,
            startedAt: new Date(input.startedAt),
            endedAt: new Date(input.endedAt),
            durationSeconds: Math.round(
              (Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 1000,
            ),
            transcript: { entries: input.transcript },
          })
          .onConflictDoNothing();
        const [row] = await transaction
          .select()
          .from(voiceSessions)
          .where(eq(voiceSessions.id, input.id));
        if (!row || row.userId !== actor.id || !sameInput(record(row), input))
          throw new VoiceSessionError(
            "This voice session ID is already in use.",
            409,
          );
        return record(row);
      });
    },
    async list(actor, channelId, cursor) {
      await requireChannel(actor, channelId);
      let after: { at: Date; id: string } | undefined;
      if (cursor) {
        try {
          const value: unknown = JSON.parse(
            Buffer.from(cursor, "base64url").toString(),
          );
          if (
            !value ||
            typeof value !== "object" ||
            !("at" in value) ||
            typeof value.at !== "string" ||
            !("id" in value) ||
            !identifier(value.id) ||
            !Number.isFinite(Date.parse(value.at))
          )
            throw new Error("cursor");
          after = { at: new Date(value.at), id: value.id };
        } catch {
          throw new VoiceSessionError("Invalid voice history cursor.", 400);
        }
      }
      const rows = await database
        .select({ session: voiceSessions })
        .from(voiceSessions)
        .innerJoin(
          channels,
          and(
            eq(channels.id, voiceSessions.channelId),
            isNull(channels.deletedAt),
          ),
        )
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .where(
          and(
            eq(voiceSessions.channelId, channelId),
            after
              ? or(
                  gt(voiceSessions.startedAt, after.at),
                  and(
                    eq(voiceSessions.startedAt, after.at),
                    gt(voiceSessions.id, after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(voiceSessions.startedAt), asc(voiceSessions.id))
        .limit(51);
      const sessions = rows.slice(0, 50).map(({ session }) => record(session));
      const last = sessions.at(-1);
      return {
        sessions,
        nextCursor:
          rows.length > 50 && last
            ? Buffer.from(
                JSON.stringify({ at: last.startedAt, id: last.id }),
              ).toString("base64url")
            : null,
      };
    },
    async summarize(actor, id, summary) {
      if (!summary.trim() || summary.length > 4000)
        throw new VoiceSessionError("Invalid voice summary.", 400);
      const [existing] = await database
        .select()
        .from(voiceSessions)
        .where(
          and(eq(voiceSessions.id, id), eq(voiceSessions.userId, actor.id)),
        );
      if (!existing)
        throw new VoiceSessionError("Voice session not found.", 404);
      return database.transaction(async (transaction) => {
        await requireWriteAccess(transaction, actor, existing.channelId);
        const [updated] = await transaction
          .update(voiceSessions)
          .set({ summary: summary.trim(), summaryStatus: "ready" })
          .where(
            and(
              eq(voiceSessions.id, id),
              eq(voiceSessions.userId, actor.id),
              eq(voiceSessions.summaryStatus, "failed"),
            ),
          )
          .returning();
        if (updated) return record(updated);
        // A competing replica may have finished first. Return its durable summary so both
        // callers publish the same preview, and later retries never replace a ready summary.
        const [ready] = await transaction
          .select()
          .from(voiceSessions)
          .where(
            and(eq(voiceSessions.id, id), eq(voiceSessions.userId, actor.id)),
          );
        if (!ready)
          throw new VoiceSessionError("Voice session not found.", 404);
        return record(ready);
      });
    },
  };
}
