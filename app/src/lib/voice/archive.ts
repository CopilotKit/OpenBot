import type { ActivityMessage, Message } from "@ag-ui/core";
import type {
  SaveVoiceSessionInput,
  VoiceSessionPage,
  VoiceSessionRecord,
} from "@openbot/shared/voice-session";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { channelKeys } from "@/lib/channels/queries";
import type { VoiceSession } from "@/lib/api/generated/model";
import {
  listVoiceSessions,
  saveVoiceSession as saveVoiceSessionAtApi,
} from "@/lib/api/generated/voice/voice";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { queryClient } from "@/query-client";
import { closingOf } from "./cut";
import {
  forgetVoiceCall,
  recoverVoiceCalls,
  rememberVoiceCall,
  voiceCallOwner,
} from "./outbox";

export const VOICE_CHAT_ACTIVITY = "openbot-voice-chat";
export type VoiceChatEntry = VoiceSessionRecord & {
  saveState?: "saving" | "unsaved";
  saveError?: string;
};
const keys = {
  saved: (channelId: string) => ["voice-sessions", channelId] as const,
  pending: (channelId: string) => ["voice-session-drafts", channelId] as const,
};

/** A saved call as the API answers it, in the names the app uses: its conversation is `channelId`. */
function recordOf({
  conversationId,
  ...rest
}: VoiceSession): VoiceSessionRecord {
  return { ...rest, channelId: conversationId };
}

export function voiceSessionQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: keys.saved(channelId),
    /*
     * A channel's history waits on this (see `historyIsLoading`), so a failure is final at once:
     * retried, it held the conversation behind the placeholder for another second.
     */
    retry: false,
    queryFn: async ({ signal }): Promise<VoiceSessionRecord[]> => {
      const sessions: VoiceSessionRecord[] = [];
      let cursor: string | null = null;
      do {
        const answered = await listVoiceSessions(
          organizationId(),
          channelId,
          { limit: 50, ...(cursor ? { cursor } : {}) },
          { signal, fallback: "Could not load voice chats." },
        );
        const page: VoiceSessionPage = {
          sessions: answered.sessions.map(recordOf),
          nextCursor: answered.nextCursor,
        };
        sessions.push(...page.sessions);
        for (const session of page.sessions) forgetVoiceCall(session);
        cursor = page.nextCursor;
      } while (cursor);
      return sessions;
    },
  });
}

function upsert<T extends { id: string }>(
  entries: T[] | undefined,
  entry: T,
): T[] {
  return [...(entries ?? []).filter((item) => item.id !== entry.id), entry];
}

/** Saves independently of the call's abort signal; hangup releases audio immediately. */
export function saveVoiceSession(
  input: SaveVoiceSessionInput,
  ownerId = voiceCallOwner(),
): void {
  const pending: VoiceChatEntry = {
    ...input,
    durationSeconds: Math.max(
      0,
      Math.floor(
        (Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 1000,
      ),
    ),
    summary: null,
    summaryStatus: "failed",
    saveState: "saving",
  };
  const update = (entry: VoiceChatEntry) =>
    queryClient.setQueryData<VoiceChatEntry[]>(
      keys.pending(input.channelId),
      (entries) => upsert(entries, entry),
    );
  if (
    queryClient
      .getQueryData<VoiceChatEntry[]>(keys.pending(input.channelId))
      ?.some((entry) => entry.id === input.id && entry.saveState === "saving")
  )
    return;
  update(pending);
  const recoverable = rememberVoiceCall(input, ownerId);
  // Errors are retained on the card for retry, including after navigating away and back.
  void (async () => {
    try {
      const { channelId, ...call } = input;
      const payload = JSON.stringify(call);
      // Sent as the page closes when it is small enough to be: a call ended by leaving is still kept.
      const saved = await saveVoiceSessionAtApi(
        organizationId(),
        channelId,
        call,
        { "Idempotency-Key": idempotencyKey() },
        {
          fallback: "Could not save this voice chat.",
          signal: AbortSignal.timeout(30_000),
          keepalive: new TextEncoder().encode(payload).byteLength < 60_000,
        },
      );
      // An answer with no call in it saved nothing to show, whatever its status.
      if (!saved?.session) throw new Error("Could not save this voice chat.");
      const session = recordOf(saved.session);
      forgetVoiceCall(session, ownerId);
      queryClient.setQueryData<VoiceSessionRecord[]>(
        keys.saved(input.channelId),
        (entries) => upsert(entries, session),
      );
      // Saved, with a summary still to come: the card says so, as the server does.
      update({
        ...session,
        ...(saved.notice === undefined ? {} : { saveError: saved.notice }),
      });
      await queryClient.invalidateQueries({ queryKey: channelKeys.all });
    } catch (error) {
      update({
        ...pending,
        saveState: "unsaved",
        saveError:
          (error instanceof Error
            ? error.message
            : "Could not save this voice chat.") +
          (recoverable
            ? ""
            : " Keep this page open to retry; browser recovery is unavailable."),
      });
    }
  })();
}

export function useVoiceArchive(channelId: string) {
  const saved = useQuery(voiceSessionQueryOptions(channelId), queryClient);
  const { data: pending = [] } = useQuery(
    {
      queryKey: keys.pending(channelId),
      queryFn: (): VoiceChatEntry[] => [],
      initialData: (): VoiceChatEntry[] =>
        recoverVoiceCalls(channelId).map((call) => ({
          ...call,
          durationSeconds: Math.max(
            0,
            Math.floor(
              (Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000,
            ),
          ),
          summary: null,
          summaryStatus: "failed",
          saveState: "unsaved",
          saveError: "The page closed before saving was confirmed.",
        })),
      enabled: false,
      gcTime: Infinity,
    },
    queryClient,
  );
  const entries = new Map<string, VoiceChatEntry>(
    (saved.data ?? []).map((entry) => [entry.id, entry]),
  );
  for (const entry of pending)
    if (entry.saveState !== "unsaved" || !entries.has(entry.id))
      entries.set(entry.id, entry);
  return {
    entries: [...entries.values()].sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
    ),
    error: saved.error,
    /**
     * The saved calls have not come back yet. A channel waits on this before showing its history,
     * so a call card is never spliced into a conversation already on screen. False after a failed
     * load too: the conversation is readable without its calls, and `error` says what went wrong.
     */
    pending: saved.isPending,
  };
}

export async function loadVoiceArchive(
  channelId: string,
): Promise<VoiceChatEntry[]> {
  await queryClient.ensureQueryData(voiceSessionQueryOptions(channelId));
  return cachedVoiceArchive(channelId);
}

export function cachedVoiceArchive(channelId: string): VoiceChatEntry[] {
  const saved =
    queryClient.getQueryData<VoiceSessionRecord[]>(keys.saved(channelId)) ?? [];
  const entries = new Map<string, VoiceChatEntry>(
    saved.map((entry) => [entry.id, entry]),
  );
  for (const entry of queryClient.getQueryData<VoiceChatEntry[]>(
    keys.pending(channelId),
  ) ?? [])
    if (entry.saveState !== "unsaved" || !entries.has(entry.id))
      entries.set(entry.id, entry);
  return [...entries.values()].sort(
    (a, b) =>
      a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
  );
}

/*
 * One card message per call, kept for as long as the call object is: the transcript skips redrawing
 * a card whose message is the one it drew last time, and a fresh object on every render redrew every
 * voice-chat card on every token of a reply streaming below it.
 */
const cardMessages = new WeakMap<VoiceChatEntry, ActivityMessage>();

function cardMessageOf(call: VoiceChatEntry): ActivityMessage {
  let message = cardMessages.get(call);
  if (message === undefined) {
    message = {
      id: `voice-chat:${call.id}`,
      role: "activity",
      activityType: VOICE_CHAT_ACTIVITY,
      content: { call },
    };
    cardMessages.set(call, message);
  }
  return message;
}

/** Card position is anchored to the message preceding the call, ahead of its delegated work. */
export function withVoiceChats(
  messages: readonly Message[],
  calls: readonly VoiceChatEntry[],
): Message[] {
  const result: Message[] = [];
  const groups = new Map<string | null, ActivityMessage[]>();
  const ids = new Set(messages.map((message) => message.id));
  for (const call of calls) {
    const message = cardMessageOf(call);
    if (ids.has(message.id)) continue;
    const group = groups.get(call.anchorMessageId) ?? [];
    group.push(message);
    groups.set(call.anchorMessageId, group);
  }
  result.push(...(groups.get(null) ?? []));
  groups.delete(null);
  for (const message of messages) {
    result.push(message, ...(groups.get(message.id) ?? []));
    groups.delete(message.id);
  }
  // A missing anchor can occur while older history is unavailable; keep those calls readable.
  for (const group of groups.values()) result.push(...group);
  return result;
}

export function voiceArchiveContext(calls: readonly VoiceChatEntry[]): string {
  return closingOf(
    calls
      .slice(-6)
      .map(
        (call) =>
          `Voice chat (${call.startedAt}):\n${call.summary ?? call.transcript.map((entry) => `${entry.role}: ${entry.text}`).join("\n")}`,
      )
      .join("\n\n"),
    12000,
  );
}

export function voiceSessionInput(
  call: VoiceSessionRecord,
): SaveVoiceSessionInput {
  const { id, channelId, startedAt, endedAt, anchorMessageId, transcript } =
    call;
  return { id, channelId, startedAt, endedAt, anchorMessageId, transcript };
}
