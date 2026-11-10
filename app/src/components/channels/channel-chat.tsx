import type { Message } from "@ag-ui/core";
import {
  type Attachment,
  CopilotChatConfigurationProvider,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { ConversationAllowances } from "@/components/approvals/conversation-allowances";
import {
  answerMessage,
  askedSinceLastMessage,
  conversationQuestion,
  QuestionNotice,
  shownAnswer,
  useConversationQuestion,
} from "@/components/approvals/question-notice";
import { ChannelWorkRows } from "@/components/channels/channel-work";
import { attachmentModality } from "@/components/channels/chat-messages";
import { toAgentOptions } from "@/components/channels/composer";
import { ModelPicker } from "@/components/channels/composer/model-picker";
import { ConversationIntro } from "@/components/channels/conversation-intro";
import { ConversationView } from "@/components/channels/conversation-view";
import { ProgressRow } from "@/components/channels/progress-row";
import {
  seedMessage,
  takeFirstMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { VoiceCallWidget } from "@/components/channels/voice-call-widget";
import { HandoffResumeNotice } from "@/components/computer/handoff-resume-notice";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  carryingOnAfterApproval,
} from "@/lib/approvals";
import { attachmentUrl } from "@/lib/channels/attachments";
import {
  recordChannelActivityMutationOptions,
  setChannelBusy,
} from "@/lib/channels/mutations";
import {
  type AgentChannel,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import { runReply } from "@/lib/channels/run-reply";
import {
  onTurnFinishedAway,
  turnFinishedAway,
} from "@/lib/channels/turns-finished-away";
import { useConversationActivity } from "@/lib/computers/activity";
import { channelAgentId, useActiveBot } from "@/lib/copilot/active-bot";
import {
  observeApprovalAgent,
  whileObserved,
} from "@/lib/copilot/approval-context";
import { offerItsOwnTools } from "@/lib/copilot/bot-offer";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { afterMs, joinWithin } from "@/lib/copilot/join-thread";
import {
  repairUnansweredToolCalls,
  unansweredToolCalls,
  withStoredAnswers,
} from "@/lib/copilot/repair-history";
import { releaseServerOwnedInterrupts } from "@/lib/copilot/server-owned-interrupts";
import { followLastRun, stoppedReason } from "@/lib/copilot/stopped-turn";
import {
  readThreadMessages,
  withCurrentA2uiVersions,
} from "@/lib/copilot/thread-messages";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { useConversationModel } from "@/lib/models/run-model";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { publishedSandboxedQueryOptions } from "@/lib/sandboxed/queries";
import {
  askChannelAgent,
  messageText,
  voiceContext,
  withVoiceContext,
} from "@/lib/voice/agent-bridge";
import {
  cachedVoiceArchive,
  loadVoiceArchive,
  useVoiceArchive,
  voiceArchiveContext,
  withVoiceChats,
} from "@/lib/voice/archive";
import { useVoiceCall } from "@/lib/voice/use-voice-call";
import { queryClient } from "@/query-client";
import { newId } from "../../lib/new-id";

/**
 * How long a stalled thread join is worth waiting for before it is ended.
 *
 * Ended, not outrun. See `lib/copilot/join-thread.ts` for what a connect left in flight does to the
 * next message sent.
 */
const JOIN_DEADLINE_MS = 1500;

/**
 * Whether the roster says a turn is running in this conversation now: one this tab started from a
 * chat it has since left, or work the server runs with no browser attached.
 */
function rosterSaysWorking(channelId: string): boolean {
  const row = queryClient
    .getQueryData<{ pages: { channels: ChannelSummary[] }[] }>(
      channelKeys.list(),
    )
    ?.pages.flatMap((page) => page.channels)
    .find((channel) => channel.id === channelId);
  return (row?.busy ?? false) || (row?.work?.length ?? 0) > 0;
}

/**
 * Backstop for a message typed before the runtime agent exists; it must not be discarded.
 */
const SEND_WITHOUT_RUNTIME_AFTER_MS = 1500;

/** What a turn that never left the browser says, with the person's words back in the box. */
const NOT_SENT = "Your message wasn't sent. Try again.";

type ChannelActivitySignature = {
  agentId: string;
  at: string;
  text: string;
};

function sameActivity(
  left: ChannelActivitySignature | null,
  right: ChannelActivitySignature | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.agentId === right.agentId &&
    left.at === right.at &&
    left.text === right.text
  );
}

/**
 * Whether the transcript still waits behind the placeholder.
 *
 * A channel opened from the roster waits for its whole history: the stored thread (`restoring`) and
 * its voice chats. A channel just started from the compose screen has no history; its first message
 * is already in hand and shows at once, not after a voice-chat request with nothing in it.
 *
 * Exported for its tests.
 */
export function historyIsLoading({
  restoring,
  seeded,
  voicePending,
  voiceWaitedOut = false,
}: {
  restoring: boolean;
  seeded: boolean;
  voicePending: boolean;
  /** The voice chats have had their `VOICE_WAIT_MS` since the thread came in. */
  voiceWaitedOut?: boolean;
}): boolean {
  return restoring || (!seeded && voicePending && !voiceWaitedOut);
}

/**
 * How long, once the thread is in, the conversation waits for its voice chats before showing
 * without them. A slow or failing voice service must not hold up text chat; cards that arrive after
 * this join the transcript where they belong.
 */
export const VOICE_WAIT_MS = 1500;

/** Whether `VOICE_WAIT_MS` has passed since `waiting` became true. Reset whenever it is false. */
function useWaitedOut(waiting: boolean, key: string): boolean {
  const [waitedOut, setWaitedOut] = useState<string | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setWaitedOut(key), VOICE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, key]);
  return waiting && waitedOut === key;
}

export function channelHistoryNotice({
  restoring,
  messageCount,
  lastMessageAt,
  historyAvailability,
  historyReadFailed = false,
  unreadable,
}: {
  restoring: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  historyAvailability: "ready" | "unavailable";
  historyReadFailed?: boolean;
  unreadable: number;
}): string | null {
  if (restoring) return null;

  if (
    historyAvailability === "unavailable" &&
    (historyReadFailed || (messageCount === 0 && lastMessageAt !== null))
  ) {
    return "Couldn't load earlier messages. You can keep using this conversation.";
  }

  if (unreadable > 0) {
    return unreadable === 1
      ? "One earlier message couldn't be read, so it isn't shown. Everything else is here."
      : `${unreadable} earlier messages couldn't be read, so they aren't shown. Everything else is here.`;
  }

  return null;
}

/**
 * Insert missing durable messages before their next shared ID, keeping local content and order.
 * A shorter read can still contain missing turns after unreadable rows are filtered out. Without a
 * following shared anchor, append the missing tail: the store cannot place it among local-only rows.
 * Return the original array when nothing was added so refreshes can wait for the store to catch up.
 *
 * ONE KIND OF LOCAL CONTENT GIVES WAY: a Bot's words that the store holds more of. A reply this tab
 * never streamed (a turn the server carried on) is known here only from a read, and a read taken
 * while the platform was still catching up holds it half written. Kept as it was, "...shared with"
 * stayed the reply until the conversation was opened again. Only a reply the stored copy carries on
 * from is replaced, so a read can lengthen what is on screen and never cut it short or change it.
 *
 * Exported for its tests.
 */
export function mergeStoredMessages(
  local: Message[],
  stored: Message[],
): Message[] {
  const localIds = new Set(local.map((message) => message.id));
  /*
   * The store can name a tool call's message differently from the live turn — `assistant-call_1`
   * where the stream said `call_1` — so a stored message whose every call the live turn already
   * holds is that live message, not a missing one. Added as missing, its card was drawn twice.
   */
  const localByCall = new Map<string, string>();
  for (const message of local) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? [])
      localByCall.set(call.id, message.id);
  }
  const heldAs = (message: Message): string | undefined => {
    if (localIds.has(message.id)) return message.id;
    if (message.role !== "assistant" || !message.toolCalls?.length) return;
    const holders = new Set(
      message.toolCalls.map((call) => localByCall.get(call.id)),
    );
    const [holder] = holders;
    return holders.size === 1 ? holder : undefined;
  };
  const seenStored = new Set<string>();
  const before = new Map<string, Message[]>();
  let pending: Message[] = [];
  for (const message of stored) {
    if (seenStored.has(message.id)) continue;
    seenStored.add(message.id);
    const held = heldAs(message);
    if (held !== undefined) {
      if (pending.length > 0) before.set(held, pending);
      pending = [];
    } else {
      pending.push(message);
    }
  }
  const storedById = new Map(stored.map((message) => [message.id, message]));
  let lengthened = false;
  const current = local.map((message) => {
    const later = storedById.get(message.id);
    if (
      message.role !== "assistant" ||
      later?.role !== "assistant" ||
      typeof message.content !== "string" ||
      typeof later.content !== "string" ||
      later.content.length <= message.content.length ||
      !later.content.startsWith(message.content)
    )
      return message;
    lengthened = true;
    return { ...message, content: later.content };
  });
  if (!lengthened && before.size === 0 && pending.length === 0) return local;
  return [
    ...current.flatMap((message) => [
      ...(before.get(message.id) ?? []),
      message,
    ]),
    ...pending,
  ];
}

/**
 * The uploaded id and filename an `Attachment` carries once it is `ready`, read from the
 * `metadata` the composer's `onUpload` stamped on it — see `composer/attachments.ts`. Not the
 * SDK's own `attachment.id`, which is a client-side handle for the upload placeholder rather than
 * the id this deployment stored the file under.
 */
function uploadedAttachment(attachment: Attachment): {
  attachmentId: string;
  filename?: string;
} {
  const metadata = attachment.metadata as
    | { attachmentId?: unknown; filename?: unknown }
    | undefined;
  const attachmentId = metadata?.attachmentId;
  if (typeof attachmentId !== "string") {
    throw new Error("Attachment is missing its uploaded id.");
  }
  const filename =
    typeof metadata?.filename === "string" ? metadata.filename : undefined;
  return filename ? { attachmentId, filename } : { attachmentId };
}

/**
 * One attachment, turned into the part shape a stored message carries.
 *
 * THE MODALITY COMES FROM THE BYTES, NOT FROM `attachment.type`, AND THIS IS THE ONLY PLACE IT CAN.
 *
 * `attachment.type` is the browser's claim, fixed before the upload and never reconciled with what
 * the file turned out to be. The server stopped trusting it — `resolvePart` decides an attachment's
 * modality with `classifyAttachment` on its own sniffed `mimeType` — but that correction lives on
 * the server and never comes back here. What this function writes IS the stored message, so a
 * `document` written here is what every later render of that message reads, for ever: a screenshot
 * whose part the browser mislabelled drew a grey file card over the picture, and the transcript's
 * document probe then paid a whole-file read per render for the privilege.
 *
 * Narrowed through the source union rather than read straight off, for the reason `parkedTiles` in
 * `chat-transcript.tsx` narrows the same field: a `data` source's `mimeType` is `file.type`, the
 * very claim being refused, and only a `url` source has been past the server. `attachmentModality`
 * falls back to the declared type when there is no corroborated one, so an attachment that somehow
 * arrives unuploaded is written exactly as it used to be.
 *
 * The comment this replaces said only "image" and "document" reach here because the composer's
 * upload config accepts no other kind of file. That reason is no longer true — the config's
 * `accept` is now the wildcard, and it is `screenPickedFiles` that holds the line. The conclusion still
 * holds; the justification had rotted, which is why the modality is now derived rather than cast.
 */
function toAttachmentPart(attachment: Attachment) {
  const { attachmentId, filename } = uploadedAttachment(attachment);
  const { source } = attachment;
  const mimeType =
    source.type === "url" && source.mimeType ? source.mimeType : undefined;
  return {
    type: attachmentModality(attachment.type, mimeType),
    source: { type: "url" as const, value: attachmentUrl(attachmentId) },
    metadata: filename ? { attachmentId, filename } : { attachmentId },
  };
}

/**
 * A plain string when there is nothing attached, exactly as every message in every channel has
 * always been sent — never a single-element array wrapping the same text, which every existing
 * reader would take a different path for no gain. With attachments, the text goes first as its
 * own part and is left out entirely when empty, since an empty text part is noise the model has
 * to read past.
 *
 * Exported for the test that pins this wire format. Reaching it through `deliver`/`say` would mean
 * standing up `useAgent`'s runtime, the thread join and the ready/join gates around it just to
 * observe a pure string-in-object-out mapping — none of that machinery bears on what this function
 * decides, so a narrow export is the honest way to test the contract without restructuring the
 * module around a test.
 */
export function toMessageContent(
  trimmed: string,
  attachments: readonly Attachment[],
) {
  if (attachments.length === 0) return trimmed;
  const refs = attachments.map(toAttachmentPart);
  return trimmed ? [{ type: "text" as const, text: trimmed }, ...refs] : refs;
}

/** What the roster's "last thing said" reads when a message carried no caption. */
function describeAttachments(attachments: readonly Attachment[]): string {
  if (attachments.length === 1) {
    const { filename } = uploadedAttachment(attachments[0]);
    return filename ? `Sent ${filename}` : "Sent an attachment";
  }
  return `Sent ${attachments.length} attachments`;
}

/** The components this deployment's people wrote, which a Bot draws as tools of those names. */
function authoredComponents(): ReadonlySet<string> {
  return new Set(
    (
      queryClient.getQueryData(publishedSandboxedQueryOptions().queryKey) ?? []
    ).map((component) => component.name),
  );
}

/**
 * One channel's conversation with one coworker.
 *
 * The local agent id is channel-scoped so two channels with the same coworker keep separate
 * durable threads.
 */
export function ChannelChat({
  channel,
  runtimeAgentId,
}: {
  channel: AgentChannel;
  runtimeAgentId: string;
}) {
  // The core attaches the frontend tool registry; direct agent runs do not.
  const { copilotkit } = useCopilotKit();
  // Mentions are scoped to the channel's permitted agents.
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  const botProfile = agentProfiles?.find(
    (profile) => profile.id === runtimeAgentId,
  );
  const localAgentId = channelAgentId(channel.id);
  const { agent, isReady } = useAgent({
    agentId: localAgentId,
    runtimeAgentId,
    threadId: channel.threadId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });
  /*
   * FOR THE AGENT'S TURNS, NOT THE SCREEN'S. A turn goes on after the person leaves this
   * conversation, and a step a rule asks about is still sent to the gate with this conversation,
   * which needs the run's input captured. Leaving lets the observer go, and it stops once the last
   * turn started here (`whileObserved`, below) is over. It used to stop on leaving, and a run that
   * started after that went to the gate under the previous run's id.
   *
   * And the agent is given its own Bot's offer as it is made, so its runs, here or after the person
   * has left, are offered this Bot's tools and never the screen's (`bot-offer.ts`).
   */
  const queries = useQueryClient();
  useEffect(() => {
    offerItsOwnTools(agent, runtimeAgentId, queries);
    return observeApprovalAgent(agent);
  }, [agent, runtimeAgentId, queries]);

  /**
   * First-message seed from the compose screen. It is taken once per mount and retained until the
   * agent has its own messages because joining a fresh thread can temporarily empty the agent.
   */
  const [first] = useState(() => {
    const pending = takeFirstMessage(channel.id);
    return pending ? { seed: seedMessage(pending.text, newId()) } : null;
  });
  const seed = first?.seed ?? null;

  /** Cleared by the send-on-mount effect without restarting it. */
  const seedRef = useRef(first);

  /** Promise gate for ordering the first message after the thread join when possible. */
  const openJoinGate = useRef<() => void>(() => {});
  const joinGate = useRef<Promise<void> | null>(null);
  if (joinGate.current === null) {
    joinGate.current = new Promise<void>((resolve) => {
      openJoinGate.current = resolve;
    });
  }
  const joinGatePromise = joinGate.current;

  /**
   * Opened once the join has replayed the thread, or given up, and before history is read. Every
   * read of the store waits for it; see `pull` below.
   */
  const openJoined = useRef<() => void>(() => {});
  const joinedGate = useRef<Promise<void> | null>(null);
  if (joinedGate.current === null) {
    joinedGate.current = new Promise<void>((resolve) => {
      openJoined.current = resolve;
    });
  }
  const joinedPromise = joinedGate.current;

  /** Promise gate so messages typed before runtime readiness wait instead of being discarded. */
  const openReadyGate = useRef<() => void>(() => {});
  const readyGate = useRef<Promise<void> | null>(null);
  if (readyGate.current === null) {
    readyGate.current = new Promise<void>((resolve) => {
      openReadyGate.current = resolve;
    });
  }
  const readyGatePromise = readyGate.current;
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;

  /*
   * THE AGENT IS READ WHEN IT IS USED, NEVER CAPTURED BEFORE A WAIT. `useAgent` hands back a
   * provisional agent until the proxied one is registered, and a different object afterwards. The
   * stale one still runs and still reaches the thread, so the answer is stored and shows up on the
   * next reload while the rendered agent sits empty. `say` waits, so it spans that swap.
   */
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const voiceArchive = useVoiceArchive(channel.id);
  const [voiceContextNotice, setVoiceContextNotice] = useState<string | null>(
    null,
  );

  /**
   * History has been asked for and has not arrived. True for a channel opened from the roster, where
   * an empty transcript is also a real answer; false for one started from the compose screen, which
   * already has the message that started it.
   */
  const [restoring, setRestoring] = useState(seed === null);
  /**
   * How many stored turns this app could not read.
   *
   * Held rather than derived, because the transcript is the running agent's once history is handed
   * over: `agent.messages` is what was restored, and what was dropped on the way in is not
   * recoverable from it.
   */
  const [unreadable, setUnreadable] = useState(0);
  const [historyAvailability, setHistoryAvailability] = useState<
    "ready" | "unavailable"
  >("ready");
  const [historyReadFailed, setHistoryReadFailed] = useState(false);
  /**
   * Why the last run ended without an answer, drawn under the transcript.
   *
   * Set by a turn of this mount that fails, and on joining the thread when the history it replays
   * ends in a failed run (`followLastRun`), so the failure is still there after a reload. Cleared by
   * the next turn.
   */
  const [runError, setRunError] = useState<string | null>(null);
  // Mount reads and Bot refreshes share one ordering: only the newest read owns the notice.
  const historyReadVersion = useRef(0);
  useEffect(() => {
    if (isReady) openReadyGate.current();
  }, [isReady]);

  // Join the gateway socket, restore durable history, then release the first-message gate.
  useEffect(() => {
    if (!isReady) return;
    let current = true;
    const version = ++historyReadVersion.current;
    // Before the connect: it is handed the subscribers the agent has when it starts.
    const lastRun = followLastRun(agent);

    void (async () => {
      let joined: "connected" | "deadline" = "deadline";
      try {
        // Bounded, and finished when it returns; `join-thread.ts` has why that matters.
        joined = await joinWithin({
          // A turn too: restoring a thread can run the calls it left unanswered.
          connect: whileObserved(agent, () =>
            copilotkit.connectAgent({ agent }),
          ),
          deadline: afterMs(JOIN_DEADLINE_MS),
          detach: () => agent.detachActiveRun(),
          /*
           * A Bot still answering keeps the join, which streams the rest of its reply in. Heard from
           * the replay, or from the roster when the replay is slower than the deadline: a step of
           * 20 lookups replays its calls and the answers so far, and ended at the deadline, the 9
           * still running never reached this screen, the composer sent the next message at once,
           * and it went out saying those 9 had been interrupted. The gateway ends the join itself
           * once the thread's run is over, so a roster that is late to clear cannot hold it open.
           */
          answering: () => lastRun.running() || rosterSaysWorking(channel.id),
          onAnswering: () => {
            if (current) setRestoring(false);
          },
        });
      } catch {
        /*
         * A join that throws is a join that is over. It must not take the gate with it: everything
         * typed afterwards waits on that gate, so a throw here would silence the conversation
         * rather than degrade it. History is restored below either way.
         */
      } finally {
        lastRun.stop();
        openJoined.current();
      }
      /*
       * The last run failed, so say so again, as the turn did when it failed. Only from a replay
       * that finished: one ended at the deadline may stop short of the run that answered. Not over
       * a turn already waiting to go, which clears it the moment it starts.
       */
      const failed = joined === "connected" ? lastRun.failure() : null;
      if (failed !== null && current && turnsRef.current === 0) {
        setRunError((shown) => shown ?? failed);
      }

      try {
        const stored = await readThreadMessages(
          channel.threadId,
          runtimeAgentId,
        );
        const isCurrent = current && version === historyReadVersion.current;
        if (isCurrent) {
          // The gateway snapshot can lag the store. Keep its valid local rows even when the
          // corresponding stored row is unreadable, while restoring other readable additions.
          // The snapshot's interfaces are read in the A2UI version CopilotKit reads now, as the
          // store's are (thread-messages.ts), or the local copy kept here would not draw.
          const messages = mergeStoredMessages(
            withCurrentA2uiVersions(agent.messages),
            stored.messages,
          );
          if (messages !== agent.messages) agent.setMessages(messages);
        }
        /*
         * Said on screen rather than only counted. A turn the history store holds and this app cannot
         * parse is left out of the transcript, and a record people read back must not have a hole in
         * it that nothing accounts for. Set even when nothing was restored: a thread whose every turn
         * is unreadable is exactly the case where silence would read as "this conversation is empty".
         */
        if (isCurrent) {
          setUnreadable(stored.unreadable);
          setHistoryAvailability(stored.availability);
          // A gateway snapshot may be partial; neither it nor a later send proves this read succeeded.
          setHistoryReadFailed(stored.availability === "unavailable");
        }
      } finally {
        // Cleared on failure too: placeholders over an empty transcript promise messages that are
        // never coming.
        if (current) setRestoring(false);
        // Release even on join/restore failure; the gate orders messages, not withholds them.
        openJoinGate.current();
      }
    })();

    return () => {
      current = false;
    };
  }, [
    copilotkit,
    agent,
    isReady,
    channel.id,
    channel.threadId,
    runtimeAgentId,
  ]);

  /*
   * A turn nobody here streamed, surfaced while the channel is open.
   *
   * A relayed handoff answer runs on the server and lands in this thread with no browser attached.
   * The roster hears about it — the activity socket patches the channel-list cache — but this
   * transcript restores history once, on mount, and would show the new turn only after leaving and
   * coming back. So it watches that same cache: when this channel's `lastMessageAt` advances to a
   * moment a Bot authored, the durable history is read again. Riding the roster's own cache rather
   * than a second subscription means "the sidebar updated" and "the transcript refreshes" are the
   * one signal, and cannot drift apart.
   *
   * The same merge as mount places a recovered durable prefix before its shared local anchors,
   * preserving current content and local-only messages in both the transcript and the next run.
   *
   * Retried briefly, because the roster is patched when the turn is on record with the runner and
   * the platform's read of the thread can be a beat behind it.
   */
  /* The read below, for a turn that ends without the roster saying so: see `carryingOn`. */
  const pullHistoryRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const authoredActivity = (): ChannelActivitySignature | null => {
      const cache = queryClient.getQueryData<{
        pages: { channels: ChannelSummary[] }[];
      }>(channelKeys.list());
      const summary = cache?.pages
        .flatMap((page) => page.channels)
        .find((row) => row.id === channel.id);
      // Only a Bot's turn is news here; a person's own line arrives through the run that sent it.
      if (
        !summary ||
        summary.lastMessageAgentId === null ||
        summary.lastMessageAt === null ||
        summary.lastMessage === null
      ) {
        return null;
      }
      return {
        agentId: summary.lastMessageAgentId,
        at: summary.lastMessageAt,
        text: summary.lastMessage,
      };
    };

    const initialActivity = authoredActivity();
    let lastSeen = initialActivity;
    let cancelled = false;

    const pull = () => {
      const version = ++historyReadVersion.current;
      const isCurrent = () =>
        !cancelled && version === historyReadVersion.current;
      void (async () => {
        /*
         * NOT BEFORE THE JOIN HAS REPLAYED THE THREAD. The join (above) rebuilds the transcript by
         * replaying the thread's events onto the messages the agent holds when it starts, and a Bot's
         * reply is built there by adding each piece of text to the message of its id. A read merged in
         * first put that reply on the agent whole, so the replay added it again behind itself: "...
         * I'll wait for your answer.I've asked: ... I'll wait for your answer." in one bubble, until a
         * reload. The roster can announce a Bot's turn at any moment, the moment the conversation
         * opens included, so every read waits for the join to be over.
         */
        await joinedPromise;
        if (!isCurrent()) return;
        let sawReady = false;
        for (const delayMs of [0, 750, 1500]) {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (!isCurrent()) return;
          const stored = await readThreadMessages(
            channel.threadId,
            runtimeAgentId,
          );
          if (!isCurrent()) return;
          if (stored.availability === "unavailable") {
            // Only an exhausted refresh with no successful read is a failure to announce. Keep the
            // last known ready notice when the store already answered this refresh cycle.
            if (delayMs === 1500 && !sawReady) {
              setHistoryAvailability("unavailable");
              setHistoryReadFailed(true);
            }
            continue;
          }
          sawReady = true;
          // A ready read owns the notice even when every readable id is already on screen.
          setUnreadable(stored.unreadable);
          setHistoryAvailability("ready");
          setHistoryReadFailed(false);
          const current = agentRef.current;
          const messages = mergeStoredMessages(
            withCurrentA2uiVersions(current.messages),
            stored.messages,
          );
          if (messages === current.messages) continue;
          current.setMessages(messages);
          return;
        }
      })();
    };

    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      const activity = authoredActivity();
      if (activity && !sameActivity(activity, lastSeen)) {
        lastSeen = activity;
        if (sameActivity(selfReportedBotActivity.current, activity)) return;
        pull();
      }
    });
    /*
     * A turn of this channel that outlived the chat it was started in, finished now. Its reply was stored and never
     * streamed here, so it is read: see `turns-finished-away.ts`.
     */
    const offFinishedAway = onTurnFinishedAway(channel.id, pull);
    pullHistoryRef.current = pull;
    void (async () => {
      await joinGatePromise;
      if (
        !cancelled &&
        initialActivity &&
        !sameActivity(selfReportedBotActivity.current, initialActivity)
      ) {
        pull();
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      offFinishedAway();
      pullHistoryRef.current = null;
    };
  }, [
    channel.id,
    channel.threadId,
    joinGatePromise,
    joinedPromise,
    runtimeAgentId,
  ]);

  // Tool calls from this conversation act on this coworker's own computer.
  useActiveBot(runtimeAgentId);
  // And what they did there is what the Activity pane beside its screen lists, whichever way they ran.
  useConversationActivity(runtimeAgentId, agent.messages);

  const skillCommands = useSkillCommands(runtimeAgentId);
  /*
   * The model this conversation's Bot answers on. Only a Bot that runs inside OpenBot uses OpenBot's
   * model, so only it gets a picker; a Bot on its own framework picks its own model.
   */
  const models = useQuery({
    ...modelCatalogueQueryOptions(),
    enabled: botProfile?.runsOnOpenBotModel === true,
  });
  const runModel = useConversationModel(
    channel.id,
    botProfile?.runsOnOpenBotModel ? models.data : undefined,
  );
  /*
   * History is the snapshot, the stored thread AND the voice archive. The transcript shows none of
   * it until all three are in, so it lands once at the bottom instead of drawing the conversation
   * and then splicing call cards into it; the notice waits for the same moment, so it appears in
   * the commit that shows the history rather than a render later, shrinking the view under it.
   */
  const voiceWaitedOut = useWaitedOut(
    !restoring && seed === null && voiceArchive.pending,
    channel.id,
  );
  const historyLoading = historyIsLoading({
    restoring,
    seeded: seed !== null,
    voicePending: voiceArchive.pending,
    voiceWaitedOut,
  });
  const historyNotice = channelHistoryNotice({
    restoring: historyLoading,
    messageCount: agent.messages.length,
    lastMessageAt: channel.lastMessageAt,
    historyAvailability,
    historyReadFailed,
    unreadable,
  });

  const awaitingReply = useRef(false);
  /**
   * WHY THIS TURN ENDED WITHOUT AN ANSWER, KEPT WHERE `deliver` CAN STILL SEE IT — because the one
   * thing that knows is a subscriber, and the one thing that has to act on it is an `await`.
   *
   * `copilotkit.runAgent` DOES NOT REJECT ON A FAILED RUN. `CopilotKitCore.runAgent` catches
   * everything the agent throws, reports it through `emitError` as `AGENT_RUN_FAILED`, and returns
   * `{ result: undefined, newMessages: [] }` — a value indistinguishable from a run that finished
   * with nothing to say. So a gateway 503, a stream that dies, a model that refuses the request:
   * every one of them arrived here as a resolved promise, and `say` reported success for a turn
   * that never reached the server.
   *
   * WHAT THAT COST, WHICH IS THE REASON THIS EXISTS. `say` resolving is what every caller reads as
   * "it went". The composer clears the box and gives up the chips it was riding; the queue empties
   * into a draft nothing retries; `conversation-view.tsx` never runs either of the failure paths it
   * has written for exactly this. The person is left with the failed turn in the transcript and a
   * notice under it, the words unretryable, and the files behind them staged rows that nothing on
   * any screen points at any more. The notice is honest and everything under it was not.
   *
   * READ OFF THE SAME `fail` THE NOTICE IS, and deliberately not from a second subscription of its
   * own. `fail` already answers the one question a separate subscriber would get wrong: a turn the
   * PERSON stopped also reaches `onRunFailed`, with an abort, and `onStop` clears `awaitingReply`
   * before it — so Stop is not a failure here and nothing restores a draft somebody chose to end.
   *
   * ONE SLOT FOR ONE TURN AT A TIME, the same assumption `awaitingReply` beside it already makes.
   * Two overlapping turns — a component button pressed during a composer send — would have the
   * second clear the first's reason, which reports the earlier turn as successful. That is the
   * pre-existing shape of `awaitingReply`, not a new one, and narrowing it means giving a run a
   * handle that `copilotkit.runAgent` does not hand back.
   */
  const turnFailure = useRef<string | null>(null);
  const assistantMessagesBeforeRun = useRef<Set<string>>(new Set());
  /** The reply this turn last told the roster about, so a later run of the turn says only what's new. */
  const reportedReply = useRef<string | null>(null);

  /*
   * TWO DIFFERENT FACTS ABOUT ONE TURN, AND NEITHER OF THEM IS `agent.isRunning`.
   *
   * `turnsInFlight` counts what a person would call the Bot having the turn: from the moment `say`
   * is entered until the whole thing has come back, browser actions in the middle included. It is
   * what decides whether the next thing typed is sent or parked, and what tells the queue its wait
   * is over.
   *
   * `runsInFlight` counts what Stop can actually reach: the run `copilotkit.runAgent` opens, and
   * nothing before it. A turn can be in flight for a second and a half before that, while `say`
   * waits for the runtime agent, and a Stop drawn in that window aborts a controller nobody has
   * made yet.
   *
   * `agent.isRunning` looks like both and is neither. It reports the run on the wire, and a turn
   * that touches the browser is several runs in a row: the Bot asks for a click, the run ENDS so
   * the browser can answer it, and another run starts carrying the answer. The agent reports itself
   * idle in every one of those gaps — the truth about the wire and a lie about the turn. OpenBot
   * registers every computer tool as a frontend tool, so the gaps open on ordinary work rather than
   * on some edge case, and anything keyed on the turn ending fires in the middle of one instead.
   *
   * Counters rather than booleans because nothing stops a second turn being started from a
   * component button while the first is still going, and two overlapping turns must not have the
   * first one to finish declare the conversation idle.
   */
  const [turnsInFlight, setTurnsInFlight] = useState(0);
  /* Authoritative once this screen unmounts, where `setTurnsInFlight` becomes a no-op. */
  const turnsRef = useRef(0);
  /** Whether this chat is still on screen, for a turn that finishes after it closed. */
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);
  const [runsInFlight, setRunsInFlight] = useState(0);

  /*
   * THE THIRD FACT: THE SERVER HAS THE TURN. When the person answers an approval, the run that asked
   * has already ended here (it stopped on the interrupt), and the server runs the action and carries
   * the conversation on in a turn no browser streams. Neither counter above sees it and neither does
   * `agent.isRunning`, so the conversation sat idle, with no "Thinking" and no Stop, for as long as
   * the Bot went on working: found on the Mac, after Allow once on a Google Maps step.
   *
   * Read from the approval itself, which the server marks `completed` only once that turn has ended,
   * so it is the same record whichever tab or device decided it. Polled faster while it is going, so
   * the conversation stops saying it is working soon after it is done.
   */
  const carryingOn =
    useQuery({
      ...approvalInboxOptions(),
      select: (inbox) => carryingOnAfterApproval(inbox, channel.threadId),
      refetchInterval: (query) =>
        carryingOnAfterApproval(query.state.data, channel.threadId)
          ? 2_000
          : 10_000,
    }).data === true;
  /*
   * When the server's turn ends, what it wrote is read, whether or not the roster says the Bot
   * replied. A turn the person stopped has no reply to announce, and what it said before the Stop
   * would otherwise appear only when the conversation was opened again.
   */
  const wasCarryingOn = useRef(false);
  useEffect(() => {
    if (wasCarryingOn.current && !carryingOn) pullHistoryRef.current?.();
    wasCarryingOn.current = carryingOn;
  }, [carryingOn]);

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const selfReportedBotActivity = useRef<ChannelActivitySignature | null>(null);

  const report = (text: string, agentId: string | null) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const at = new Date().toISOString();
    if (agentId !== null) {
      selfReportedBotActivity.current = { agentId, at, text: trimmed };
    }
    recordActivity.mutate({
      agentId,
      at,
      channelId: channel.id,
      text: trimmed,
    });
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  /**
   * Everything `say` does once it has something worth sending, split out so the counter it is
   * wrapped in covers every way out of here, a throw included.
   */
  const deliver = async (
    trimmed: string,
    attachments: Attachment[],
    sent?: Message,
  ) => {
    // Wait briefly for the runtime agent instance before adding the message.
    if (!isReadyRef.current) {
      await Promise.race([
        readyGatePromise,
        afterMs(SEND_WITHOUT_RUNTIME_AFTER_MS),
      ]);
    }

    /*
     * EVERY TURN WAITS FOR THE JOIN, not just the first of a new channel: a message added while the
     * connect is in flight is erased by it either way. Unbounded only in appearance — the join
     * effect bounds itself and opens this gate from a `finally`. If that effect never ran there is
     * no runtime agent, and no connect in flight to wait on.
     */
    if (isReadyRef.current) {
      await joinGatePromise;
    }

    // Every wait is behind us, so this is the agent the screen is actually rendering. Read once and
    // used throughout, so the message, the repair and the run cannot land on two different agents.
    // Give initial voice history time to restore, while keeping ordinary chat usable on failure.
    setVoiceContextNotice(null);
    let voiceHistoryTimer: ReturnType<typeof setTimeout> | undefined;
    const priorCalls = await Promise.race([
      loadVoiceArchive(channel.id),
      new Promise<never>((_resolve, reject) => {
        voiceHistoryTimer = setTimeout(
          () => reject(new Error("Voice history timed out")),
          2000,
        );
      }),
    ])
      .catch(() => {
        setVoiceContextNotice(
          "Couldn’t bring in what was said on the call. You may need to repeat it.",
        );
        return cachedVoiceArchive(channel.id);
      })
      .finally(() => clearTimeout(voiceHistoryTimer));
    const target = agentRef.current;
    /*
     * A call this screen holds no answer for is answered from the stored thread first, so the repair
     * further down only ever explains a call nothing answered. Before this message is added, so each
     * answer goes in beside its call rather than after the person's words. See `withStoredAnswers`.
     */
    if (unansweredToolCalls(target.messages).size > 0) {
      const stored = await readThreadMessages(
        channel.threadId,
        runtimeAgentId,
      ).catch(() => null);
      if (stored?.availability === "ready") {
        const answered = withStoredAnswers(target.messages, stored.messages);
        if (answered !== target.messages) target.setMessages(answered);
      }
    }
    const existingMessageIds = new Set(
      target.messages.map((message) => message.id),
    );

    setRunError(null);
    turnFailure.current = null;
    reportedReply.current = null;
    assistantMessagesBeforeRun.current = new Set(
      target.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id),
    );
    awaitingReply.current = true;

    /*
     * NO SKILL ROW. A `/` skill stays at the start of the person's words as `/<command>`, and the
     * server gives the Bot that skill's stored instructions in the instructions it writes for the run
     * (server/src/plugins/picked-skill.ts). A system row added here never reached a Bot as an
     * instruction: a built-in Bot's runtime drops it, and every harness reads one the browser wrote
     * as conversation data.
     */

    const voiceHistory = voiceArchiveContext(priorCalls);
    // Older development calls used a system row, which built-in agents discard.
    const previousVoiceContextId = `voice-history:${channel.id}`;
    if (
      target.messages.some((message) => message.id === previousVoiceContextId)
    )
      target.setMessages(
        target.messages.filter(
          (message) => message.id !== previousVoiceContextId,
        ),
      );

    target.addMessage(
      sent ?? {
        content: toMessageContent(trimmed, attachments),
        id: newId(),
        role: "user",
      },
    );
    report(trimmed || describeAttachments(attachments), null);

    // Providers reject later turns if prior tool calls have no result; repair before sending.
    const repaired = repairUnansweredToolCalls(target.messages);
    if (repaired !== target.messages) {
      target.setMessages(repaired as typeof target.messages);
    }

    // A wait the server already answered must not hold this message back. See the module.
    releaseServerOwnedInterrupts(target);
    /*
     * Whether the run got past the agent's own checks and left the browser. One refused there (an
     * interrupt something else still waits on) never reaches a subscriber's `onRunFailed`, and
     * `copilotkit.runAgent` resolves as if it had answered, so without this the message was counted
     * as sent: the box emptied, and the words were gone on the next reload.
     */
    let started = false;
    const watching = target.subscribe({
      onRunInitialized: () => {
        started = true;
      },
    });
    setRunsInFlight((count) => count + 1);
    try {
      await withVoiceContext(copilotkit, target.agentId, voiceHistory, () =>
        whileObserved(target, () => copilotkit.runAgent({ agent: target })),
      );
    } finally {
      watching.unsubscribe();
      setRunsInFlight((count) => count - 1);
    }
    if (!started && turnFailure.current === null && awaitingReply.current) {
      awaitingReply.current = false;
      // It never left this browser, so it is not part of the conversation: the words go back in the box.
      target.setMessages(
        target.messages.filter((message) => existingMessageIds.has(message.id)),
      );
      turnFailure.current = NOT_SENT;
      setRunError(NOT_SENT);
    }

    /*
     * A TURN THAT DID NOT HAPPEN FAILS THE SEND, which is the only way anything upstream can tell.
     * See `turnFailure` for why the resolved promise above says nothing about that.
     *
     * AFTER the `finally`, not inside the `try`: the run is over either way, so the counter that
     * draws the Stop button must come down before this throws. Throwing from inside would leave
     * `runsInFlight` high for a run that has already ended.
     *
     * WHAT THE THROW REACHES, so it is clear this is a message and not a crash. The composer's
     * `catch` puts the words and the chips back; `conversation-view.tsx` puts a drained queue back
     * as retryable entries carrying their files. Nothing here reports the failure — `runError` was
     * already set from the same `fail` that set this, and the transcript already draws it — so this
     * adds a retry, not a second sentence.
     *
     * THE MESSAGE STAYS ON SCREEN. `deliver` added it above and nothing takes it away: it is what
     * the failed turn WAS, it is what the notice under it is about, and removing it would delete a
     * partial answer that a mid-stream failure had already produced. The restored draft beside it
     * is the retry, the same way a failed composer send has always put its words back while the
     * transcript kept the turn.
     */
    if (turnFailure.current !== null) {
      throw new Error(turnFailure.current);
    }
    return target.messages
      .filter(
        (message) =>
          message.role === "assistant" && !existingMessageIds.has(message.id),
      )
      .map(messageText)
      .filter(Boolean)
      .join("\n\n");
  };

  /**
   * Send a user turn through the channel, including activity reporting and history repair.
   *
   * Every user turn in this channel goes through here — what the composer sends, the seed from the
   * compose screen, and a button inside a rendered component. That is what makes the counter worth
   * keeping here rather than in the view: the view sees only the turns it started itself, and a
   * queue that drains on the wrong one of those posts a correction into the middle of an answer.
   */
  const say = async (
    text: string,
    attachments: Attachment[] = [],
    /** The message to send for `text`, when it is more than the words: an answer to a question. */
    sent?: Message,
  ) => {
    const trimmed = text.trim();
    // A pasted screenshot with no caption is still a message to send: `canSendDraft` already
    // unlocks the button for exactly this case, so refusing it here would leave the button
    // enabled and inert.
    if (!trimmed && attachments.length === 0) return "";

    // Voice and typed requests share this turn boundary, including gaps between frontend tools.
    if (turnsRef.current > 0 || agentRef.current.isRunning) {
      throw new Error(
        "This Bot is still working on something. Wait for it, or stop it first.",
      );
    }

    turnsRef.current += 1;
    setTurnsInFlight(turnsRef.current);
    if (turnsRef.current === 1) {
      void setChannelBusy({ channelId: channel.id, busy: true });
    }
    try {
      const reply = await deliver(trimmed, attachments, sent);
      /*
       * The person left while this turn was running (holding control of the Bot's browser, say) and the turn went on
       * without this screen. The run-finished subscription that tells the roster what the Bot said went with it, so the
       * reply is reported here.
       */
      if (!onScreen.current) {
        // A turn that said nothing and drew its answer is reported by what it drew.
        const drawn = runReply(
          agentRef.current.messages,
          assistantMessagesBeforeRun.current,
          authoredComponents(),
        );
        reportRef.current(reply || (drawn?.text ?? ""), runtimeAgentId);
      }
      return reply;
    } finally {
      turnsRef.current -= 1;
      setTurnsInFlight(turnsRef.current);
      // Sent from here rather than from an effect on `turnsInFlight`: this runs after unmount, that
      // does not, and the last turn out is what takes the roster's working indicator down.
      if (turnsRef.current === 0) {
        void setChannelBusy({ channelId: channel.id, busy: false });
      }
      // And the conversation open now, if the person came back, reads what this turn stored.
      if (!onScreen.current) turnFinishedAway(channel.id);
    }
  };

  useEffect(() => {
    /*
     * `laterRun` is a RUN_ERROR from a run of a turn still going here after its first run has
     * finished. A turn that touches the browser is several runs, and `awaitingReply` comes down when
     * the first one ends on its browser step, so a Bot that failed in the run after it (out of time
     * nine steps into a form) ended the turn with its steps on screen and nothing said. Only a
     * RUN_ERROR counts there: the Bot said it failed, where a Stop ends a run as finished, cancelled.
     */
    const fail = (message: string, laterRun = false) => {
      if (!awaitingReply.current && !(laterRun && turnsRef.current > 0)) return;
      awaitingReply.current = false;
      // Both halves of one fact: the sentence the transcript shows, and the reason `deliver` throws
      // so the draft behind the turn is restored rather than counted as sent. See `turnFailure`.
      turnFailure.current = message;
      setRunError(message);
    };
    const subscription = agent.subscribe?.({
      // Both surfaces fall back to the same sentence, from the same place, so a person who uses
      // both is not told two different things about the same silence.
      onRunErrorEvent: ({ event }) => fail(stoppedReason(event?.message), true),
      onRunFailed: ({ error }) => fail(stoppedReason(error)),
      onRunFinishedEvent: ({ event }) => {
        /*
         * A run the server stopped to ask the person (an app's call OpenBot asks about) draws its
         * card now, not on the inbox's next poll, as a computer step's does.
         */
        if (
          (event as { outcome?: { type?: unknown } } | undefined)?.outcome
            ?.type === "interrupt" ||
          // And a run that ended on a question to the person, the same way.
          askedSinceLastMessage(agent.messages)
        )
          void queryClient.invalidateQueries({ queryKey: ["approvals"] });
        const wasOurs = awaitingReply.current;
        awaitingReply.current = false;
        /*
         * EVERY RUN OF A TURN STILL GOING HERE, not only its first. A turn that touches the browser
         * is several runs: the first ends on the call the browser answers (a click, a card waiting on
         * the person) and has said nothing yet, and the answer comes in a later run of the same turn.
         * Told only about the first, the roster kept the person's message as the last thing said, and
         * a task's list read their own words as its outcome.
         */
        if (!wasOurs && turnsRef.current === 0) return;

        // Its words, or what it drew when it said nothing: a drawn answer is a reply too.
        const reply = runReply(
          agent.messages,
          assistantMessagesBeforeRun.current,
          authoredComponents(),
        );
        if (!reply || reply.id === reportedReply.current) return;
        reportedReply.current = reply.id;
        reportRef.current(reply.text, runtimeAgentId);
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, runtimeAgentId]);

  /** Stable reference for effects and component callbacks. */
  /*
   * A question the Bot is waiting on in this conversation. While there is one, what the person sends
   * is their answer to it: it goes through the answer path, which closes the question rather than
   * starting a new turn that leaves it open.
   *
   * A question this conversation's own turn asked is answered by its next turn, run HERE like any
   * other: its steps stream as they happen and Stop stops it. It used to be resumed on the server
   * with nothing here attached to it, so the screen said "reading your answer" with no steps and no
   * Stop until the whole turn was over, and then drew every step at once.
   *
   * A question a routine or a goal asked still goes back to the server, which resumes that run's work
   * with its own tools. Then their words are drawn at once under the id the server stores them under,
   * and the Bot's reply arrives as any turn run away from this tab does, through the history read
   * above. So does an answer given while a turn is still going here, which a turn of its own would
   * race.
   */
  const question = useConversationQuestion(channel.id, channel.threadId);
  /*
   * The question a message sent now answers. The inbox above is polled, so a person who answers the
   * moment the Bot asks can be ahead of it: their answer went as a plain message, the question stayed
   * open, and its card and badge came back after the turn it should have closed. So when the
   * transcript shows the Bot asked since the person last spoke, the inbox is read again first.
   */
  const waitingQuestion = async () => {
    if (question || !askedSinceLastMessage(agentRef.current.messages))
      return question;
    const inbox = await queryClient
      .fetchQuery({ ...approvalInboxOptions(), staleTime: 0 })
      .catch(() => undefined);
    return conversationQuestion(inbox, channel.id, channel.threadId);
  };
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const [answeredId, setAnsweredId] = useState<string | null>(null);
  const answerTo = async (text: string, asked = question) => {
    if (!asked) return;
    const sent = answerMessage(asked, text);
    const idle = turnsRef.current === 0 && !agentRef.current.isRunning;
    const continueHere = await answer.mutateAsync({
      id: asked.id,
      response: text,
      inConversation: idle,
    });
    if (continueHere) {
      await say(text, [], sent);
      return;
    }
    setAnsweredId(sent.id);
    agent.setMessages([...agent.messages, sent]);
  };
  // Until a Bot message lands after the answer, the Bot is reading it.
  const answeredAt = answeredId
    ? agent.messages.findIndex((message) => message.id === answeredId)
    : -1;
  const readingAnswer =
    answeredAt !== -1 &&
    !agent.messages
      .slice(answeredAt + 1)
      .some((message) => message.role === "assistant");
  const botName = botProfile?.name ?? channel.name;
  const botSeed = botProfile?.avatarSeed || runtimeAgentId;

  const sayRef = useRef(say);
  sayRef.current = say;
  const stopEpoch = useRef(0);

  const call = useVoiceCall({
    channelId: channel.id,
    disabled: !channel.active,
    context: async () =>
      [
        voiceArchiveContext(await loadVoiceArchive(channel.id)).slice(-6000),
        voiceContext(agentRef.current.messages).slice(-6000),
      ]
        .filter(Boolean)
        .join("\n\n"),
    anchorMessageId: () => agentRef.current.messages.at(-1)?.id ?? null,
    askAgent: async (request, signal) => {
      const started = stopEpoch.current;
      const answer = await askChannelAgent(request, signal, {
        busy: () => turnsRef.current > 0 || agentRef.current.isRunning,
        send: (text) => sayRef.current(text),
      });
      if (started !== stopEpoch.current)
        throw new Error("The user stopped this task before it completed.");
      return answer;
    },
  });
  const stopTask = () => {
    awaitingReply.current = false;
    stopEpoch.current++;
    copilotkit.stopAgent({ agent });
  };

  /**
   * Component buttons speak as user turns without forcing every transcript card to re-render.
   *
   * The rejection is swallowed HERE rather than left to the void, and that is not a style choice:
   * `say` throws on a failed turn now (see `turnFailure`), and a voided promise with nothing on the
   * end of it is an unhandled rejection — in this repository's test runner, a failure attributed to
   * whichever test happened to be running when it surfaced. There is nothing to restore for this
   * caller either way: the words came from a button inside a rendered card, not from a box somebody
   * is still holding, and the failed turn is already reported by `runError` under the transcript.
   */
  const askFromComponent = useCallback((text: string) => {
    void sayRef.current(text).catch(() => undefined);
  }, []);

  /**
   * Send the create-channel seed once. No waiting of its own: `say` owns that for every turn, and a
   * second copy of the ordering here was the one that could disagree with it.
   */
  useEffect(() => {
    const pending = seedRef.current;
    if (!pending) return;
    seedRef.current = null;

    // Swallowed for the reason `askFromComponent` above records: `say` throws on a failed turn, and
    // the seed has no box to go back into — it was typed on a screen that has already navigated
    // away. The transcript keeps the seeded message and the notice under it says what happened.
    // A `/` skill is still at the start of its words, where the server finds it.
    void sayRef
      .current(
        typeof pending.seed.content === "string" ? pending.seed.content : "",
      )
      .catch(() => undefined);

    // Keep `seed` in state; transcriptMessages gives it up once the agent holds a user turn.
  }, []);

  return (
    // Activity renderers resolve their agent through this SDK context. It must match useAgent's
    // channel instance so an action continues this thread instead of looking for a default agent.
    <CopilotChatConfigurationProvider
      agentId={localAgentId}
      threadId={channel.threadId}
    >
      <ConversationProvider ask={askFromComponent}>
        <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col">
          <VoiceCallWidget
            call={call}
            name={
              agentProfiles?.find((profile) => profile.id === runtimeAgentId)
                ?.name ?? channel.name
            }
            avatarSeed={
              agentProfiles?.find((profile) => profile.id === runtimeAgentId)
                ?.avatarSeed ?? runtimeAgentId
            }
            taskRunning={agent.isRunning || runsInFlight > 0}
          />
          <ConversationView
            // Remounted per conversation, so opening one puts the caret in its composer once.
            autoFocus
            threadId={channel.threadId}
            // The clock beside `+`: a routine for the Bot this conversation talks to, posting here.
            routine={
              channel.active
                ? { agentId: runtimeAgentId, channelId: channel.id }
                : undefined
            }
            voiceCall={
              call.available
                ? {
                    active: call.active,
                    supported: call.supported,
                    onStart: call.open,
                  }
                : undefined
            }
            agents={toAgentOptions(agentProfiles, channel.agentIds)}
            channelId={channel.id}
            starterSuggestions={
              channel.agentIds.length === 1 ? (
                <StarterSuggestions
                  agentId={runtimeAgentId}
                  channelId={channel.id}
                  disabled={
                    !channel.active ||
                    historyLoading ||
                    agent.isRunning ||
                    turnsInFlight > 0 ||
                    carryingOn ||
                    Boolean(question) ||
                    call.active ||
                    runModel.saving
                  }
                  onSelect={async (text) => {
                    await runModel.beforeSend();
                    // The transcript already reports a failed turn through runError.
                    await sayRef.current(text).catch(() => undefined);
                  }}
                />
              ) : undefined
            }
            intro={
              /* From the roster this screen already reads; nothing while it loads. */
              botProfile ? <ConversationIntro agent={botProfile} /> : undefined
            }
            /*
             * THE TURN, not the run. `say` waits for the runtime agent and the join before a run starts,
             * and `agent.isRunning` alone leaves that gap unmarked — which is the one moment the
             * "Thinking" line exists for. Same value as `pending`, deliberately.
             */
            busy={agent.isRunning || turnsInFlight > 0 || carryingOn}
            // The `/` menu exposes only skills granted to this Bot.
            commands={skillCommands}
            modelPicker={
              <ModelPicker
                catalogue={
                  botProfile?.runsOnOpenBotModel ? models.data : undefined
                }
                disabled={!channel.active}
                onChange={runModel.choose}
                saving={runModel.saving}
                value={runModel.value}
              />
            }
            // Readiness is handled by `say`; deletion is the only disabled-chat state.
            disabled={!channel.active}
            messages={withVoiceChats(
              transcriptMessages(agent.messages, seed).map(shownAnswer),
              voiceArchive.entries,
            )}
            attached={
              question && channel.active ? (
                <QuestionNotice
                  avatarSeed={botSeed}
                  botName={botName}
                  onAnswered={answerTo}
                  question={question}
                />
              ) : undefined
            }
            notice={
              /*
               * Two things can be worth saying at once — a deleted coworker and a history with holes in
               * it — and they are independent, so neither is an `else` for the other.
               */
              <>
                {/* What the person allowed for this conversation, each with Turn off. */}
                {channel.active ? (
                  <ConversationAllowances threadId={channel.threadId} />
                ) : null}
                <HandoffResumeNotice
                  botId={runtimeAgentId}
                  agent={agent}
                  ready={isReady && !restoring && channel.active}
                  run={async () => {
                    setRunsInFlight((count) => count + 1);
                    try {
                      await whileObserved(agent, () =>
                        copilotkit.runAgent({ agent }),
                      );
                    } finally {
                      setRunsInFlight((count) => count - 1);
                    }
                  }}
                />
                {voiceArchive.error && (
                  <p className="pb-2 text-sm text-destructive" role="alert">
                    Couldn’t load voice chats. Reload the page.
                  </p>
                )}
                {voiceContextNotice && (
                  <p
                    className="pb-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    {voiceContextNotice}
                  </p>
                )}
                {historyNotice ? (
                  <p
                    className="pb-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    {historyNotice}
                  </p>
                ) : null}
                {answer.error ? (
                  <p className="pb-2 text-sm text-destructive" role="alert">
                    {answer.error.message}
                  </p>
                ) : null}
                {channel.active ? null : (
                  <p
                    className="pb-2 text-sm text-muted-foreground"
                    role="status"
                  >
                    This Bot was deleted. You can still read this conversation,
                    but the Bot can't reply.
                  </p>
                )}
              </>
            }
            onSubmit={async (draft) => {
              await runModel.beforeSend();
              // `draft.agentId` carries the @mentioned coworker, but nothing routes on it yet: this
              // channel is pinned to one `runtimeAgentId` for the life of its thread, so honouring a
              // per-message mention is a change to that binding, not to the composer.
              //
              // An answer is words only: a draft carrying files or a `/` skill is sent as a turn. The
              // skill stays at the start of the words as `/<command>`, where the server finds it and
              // gives the Bot its instructions (server/src/plugins/picked-skill.ts).
              const asked =
                draft.attachments.length === 0 && draft.commandIds.length === 0
                  ? await waitingQuestion()
                  : undefined;
              if (asked) {
                await answerTo(draft.text, asked);
                return;
              }
              await say(draft.text, draft.attachments);
            }}
            /**
             * Stop through the core so the abort signal reaches frontend tools; `say` repairs any
             * unanswered tool call before the next turn.
             */
            onStop={stopTask}
            /*
             * The turn, not the run. A browser action ends one run and starts another, and telling the
             * conversation it is idle in between is what would drain a parked correction into the
             * middle of an answer: a second turn racing the first on one thread, with a fabricated
             * result stitched over a tool call that is still executing.
             */
            pending={agent.isRunning || turnsInFlight > 0 || carryingOn}
            /*
             * A channel outlives its turns, so it is the screen where waiting is worth offering. A
             * correction typed mid-answer is held here, in this tab, and runs as one follow-up turn the
             * moment this one is over — including when it is over because somebody pressed the button
             * above.
             */
            queueWhileBusy
            restoring={historyLoading}
            /*
             * The run, not the turn. Stop reaches a run through the core's abort controller, and that
             * controller does not exist until `say` has finished waiting for the runtime agent — so
             * this is the one place the narrower fact is the honest one to draw a button from.
             */
            /*
             * Not while the server carries the conversation on after an approval: this tab has no
             * run of its own for Stop to reach then, and a Stop that does nothing is worse than none.
             */
            stoppable={agent.isRunning || runsInFlight > 0}
            /*
             * At the END OF THE TRANSCRIPT rather than above the composer, which is where this used to
             * be. A turn that ends without an answer leaves a gap exactly where the reply was going to
             * appear, and the person is already looking at it; an explanation in the composer area is a
             * different part of the screen from the thing it explains.
             *
             * `runError` carries whatever ended the turn, in that thing's own words. A Bot that stopped
             * streaming says so, because the deployment's stall watchdog writes that sentence into the
             * run before closing it; see server/src/channels/stall-guard.ts.
             */
            stopped={runError ?? undefined}
            /*
             * What the server says this conversation waits on: a Bot its Bot asked, a routine.
             * Hidden while this tab's own turn is going, which already shows itself and would
             * otherwise draw "Asking Ana…" under the sentence saying it had asked. The composer
             * stays open either way: a person may keep talking while a hop runs, and a relay that
             * finds them mid-turn waits and is tried again.
             */
            working={
              agent.isRunning || turnsInFlight > 0 ? null : (
                <>
                  {readingAnswer ? (
                    <ProgressRow
                      label={`${botName} is reading your answer…`}
                      media={<BotOrb name={botName} seed={botSeed} size={20} />}
                    />
                  ) : null}
                  <ChannelWorkRows
                    botOf={(botId) =>
                      agentProfiles?.find((profile) => profile.id === botId)
                    }
                    work={channel.work}
                  />
                </>
              )
            }
          />
        </div>
      </ConversationProvider>
    </CopilotChatConfigurationProvider>
  );
}
