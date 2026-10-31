import type { Message } from "@ag-ui/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { BotOrbState } from "@/components/agents/orb/bot-orb";
import { ChannelAvatar } from "@/components/channels/avatar";
import { approvalInboxOptions } from "@/lib/approvals";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  type BrowserStep,
  browserSteps,
  type StepApproval,
  stepFor,
  turnWaitsOnPerson,
} from "@/lib/channels/step";
import { cn } from "@/lib/utils";

/**
 * What one conversation is doing, for its header: the Bot's orb works while the Bot has the turn,
 * listens while the person types and lands an answer, and the line under the conversation's name
 * says which step the Bot is on, or that it needs the person.
 *
 * The conversation route provides it and the conversation writes into it (`useReportConversation`),
 * so everything on the route reads one conversation and never another's. Readers:
 *
 * - `useConversationOrb()`: the Bot's orb state. `ConversationOrb` draws it.
 * - `useConversationStatus()`: resting, working (with the step, or null for work the server is doing
 *   that this tab did not start), or needs you. `ConversationStatusLine` draws it.
 * - `useConversationSteps()`: the browser steps the Bot took, for the computer pane's step log.
 *
 * The conversation's reports live in a store outside React, and each reader subscribes to the
 * fields it uses, so a keystroke reaches the orb and nothing else, and a new step reaches the line
 * and not the orb. What the server says (the conversation list's busy flag, an approval waiting in
 * this thread) is read here from the queries the app already keeps.
 */

/** How long the orb holds "done": its smile springs up and settles away. */
export const LANDING_MS = 2600;

/** What the conversation last reported. */
type Reported = {
  /**
   * The conversation reporting, null when none is mounted. Readers count a report only from the
   * conversation on screen: on the way to another one, the last one's report is still here for a
   * moment, until it unmounts and takes it away.
   */
  channelId: string | null;
  /** The Bot has the turn: asked and not answered yet, browser actions in the middle included. */
  working: boolean;
  /** What `stepFor` says about the turn, null when there is none. */
  step: string | null;
  /** The composer has something typed in it. */
  drafting: boolean;
  /** Counts the turns that ended in an answer, rather than a failure or a Stop. */
  answers: number;
  /** The browser steps in the conversation, oldest first. */
  steps: readonly ConversationStep[];
};

/** A browser step, and when this tab first saw it, which is where it sits among the commands. */
export type ConversationStep = BrowserStep & { at: number };

const NO_STEPS: readonly ConversationStep[] = [];

const AT_REST: Reported = {
  channelId: null,
  working: false,
  step: null,
  drafting: false,
  answers: 0,
  steps: NO_STEPS,
};

/**
 * When this tab first saw each browser step, by its call.
 *
 * MODULE SCOPE, SO A STEP KEEPS ITS PLACE. The command log beside these steps lives for the session,
 * and a conversation opened again would otherwise stamp every step it already showed with the moment
 * it came back, after commands that ran later. A step from before this tab opened is stamped when
 * the conversation first showed it. Bounded, oldest out.
 */
const FIRST_SEEN = new Map<string, number>();
const MAX_FIRST_SEEN = 1000;

function firstSeen(callId: string, now: number): number {
  const seen = FIRST_SEEN.get(callId);
  if (seen !== undefined) return seen;
  FIRST_SEEN.set(callId, now);
  while (FIRST_SEEN.size > MAX_FIRST_SEEN) {
    const oldest = FIRST_SEEN.keys().next().value;
    if (oldest === undefined) break;
    FIRST_SEEN.delete(oldest);
  }
  return now;
}

/** The same steps, unchanged: a streamed token rewrites the array and usually nothing in it. */
function sameSteps(
  current: readonly ConversationStep[],
  next: readonly BrowserStep[],
): boolean {
  return (
    current.length === next.length &&
    current.every((step, index) => {
      const other = next[index];
      return (
        other !== undefined &&
        step.item.id === other.item.id &&
        step.item.result === other.item.result &&
        step.item.toolCall.function.arguments ===
          other.item.toolCall.function.arguments &&
        step.latest === other.latest
      );
    })
  );
}

type Store = {
  read: () => Reported;
  write: (next: (current: Reported) => Reported) => void;
  subscribe: (listener: () => void) => () => void;
};

function createStore(): Store {
  let current = AT_REST;
  const listeners = new Set<() => void>();
  return {
    read: () => current,
    write(next) {
      const value = next(current);
      if (value === current) return;
      current = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What the server says about this conversation. */
type ServerFacts = {
  /** The server has a turn running here that this tab did not start. */
  working: boolean;
  /** An approval in this conversation is waiting on the person. */
  waiting: boolean;
  /** This conversation's approvals, so a declined step stops being named before its result. */
  approvals: readonly StepApproval[];
};

const NOTHING_ON_SERVER: ServerFacts = {
  working: false,
  waiting: false,
  approvals: [],
};

/** The store, and the conversation on screen. */
type Presence = { store: Store; channelId: string };

const StoreContext = createContext<Presence | null>(null);
const ServerContext = createContext<ServerFacts>(NOTHING_ON_SERVER);

const unsubscribed = () => () => {};

/**
 * One field of what the conversation on screen reported, at rest if it has not. Re-renders only
 * when that field changes.
 */
function useReported<K extends keyof Reported>(
  presence: Presence | null,
  key: K,
): Reported[K] {
  return useSyncExternalStore(presence?.store.subscribe ?? unsubscribed, () => {
    const reported = presence?.store.read();
    return reported && reported.channelId === presence?.channelId
      ? reported[key]
      : AT_REST[key];
  });
}

/**
 * `threadId` is the conversation's thread, for the approvals waiting in it; undefined while the
 * conversation loads. The route stays mounted from one conversation to the next, and so does this:
 * the conversation leaving takes its reports with it, and `channelId` moves what the server says.
 */
export function ConversationPresenceProvider({
  channelId,
  threadId,
  children,
}: {
  channelId: string;
  threadId: string | undefined;
  children: ReactNode;
}) {
  const [store] = useState(createStore);
  const presence = useMemo(() => ({ store, channelId }), [store, channelId]);
  const channels = useInfiniteQuery(channelListQueryOptions());
  // The conversation's one poll of the inbox. Its rows and cards read the cache this keeps fresh.
  const inbox = useQuery(approvalInboxOptions());
  const row = channels.data?.find((channel) => channel.id === channelId);
  // The sidebar's rule (`ChannelRow`), so the header and the conversation's row agree.
  const busy = (row?.busy ?? false) || (row?.work?.length ?? 0) > 0;
  const working = useUnownedBusy(
    channelId,
    busy,
    useReported(presence, "working"),
  );
  const approvals = useMemo(
    () =>
      threadId === undefined
        ? []
        : (inbox.data?.requests ?? []).filter(
            (request) => request.action.threadId === threadId,
          ),
    [inbox.data, threadId],
  );
  const waiting = approvals.some((request) => request.status === "pending");
  const facts = useMemo(
    () => ({ working, waiting, approvals }),
    [working, waiting, approvals],
  );
  return (
    <StoreContext.Provider value={presence}>
      <ServerContext.Provider value={facts}>{children}</ServerContext.Provider>
    </StoreContext.Provider>
  );
}

/**
 * The busy flag for work this tab did not start: false while the conversation's own turn runs, and
 * for the rest of that busy spell. The server's flag comes down a moment after the tab's own turn
 * ends, and without this every answer would end on "Working" as the flag caught up. A run the server
 * starts on its own afterwards, such as the one after Allow once, raises a new spell, and shows.
 * A spell belongs to one conversation, so opening another starts again.
 */
function useUnownedBusy(
  channelId: string,
  busy: boolean,
  ownTurn: boolean,
): boolean {
  const spell = useRef({ channelId, owned: false });
  if (spell.current.channelId !== channelId)
    spell.current = { channelId, owned: false };
  if (!busy) spell.current.owned = false;
  else if (ownTurn) spell.current.owned = true;
  return busy && !spell.current.owned;
}

/**
 * The Bot's orb state for what the conversation is doing. The Bot working outranks the person
 * typing, since a correction typed mid-answer waits for the turn to end; typing cuts a landing
 * short, and so does an approval waiting here, since the line then says "Needs you". Resting
 * outside a conversation route.
 */
export function useConversationOrb(): BotOrbState {
  const presence = useContext(StoreContext);
  const server = useContext(ServerContext);
  const present = useReported(presence, "channelId") !== null;
  const working = useReported(presence, "working");
  const drafting = useReported(presence, "drafting");
  // Read whatever conversation it came from: it only counts, and a count from before is landed.
  const answers = useSyncExternalStore(
    presence?.store.subscribe ?? unsubscribed,
    () => presence?.store.read().answers ?? 0,
  );
  // The answer whose landing has played out. Behind `answers` while the orb holds "done".
  const [landed, setLanded] = useState(answers);
  useEffect(() => {
    if (answers === landed) return;
    // With the conversation gone the landing is over, so coming straight back does not replay it.
    if (!present) {
      setLanded(answers);
      return;
    }
    const timer = setTimeout(() => setLanded(answers), LANDING_MS);
    return () => clearTimeout(timer);
  }, [answers, present, landed]);
  if (working || server.working) return "thinking";
  if (drafting) return "listening";
  if (server.waiting) return "idle";
  return present && answers !== landed ? "done" : "idle";
}

/** How the conversation stands, for the line under its name. */
export type ConversationStatus =
  | { kind: "resting" }
  /** `step` is what the Bot is on, or null for a turn the server is running that this tab did not start. */
  | { kind: "working"; step: string | null }
  | { kind: "needs-you" };

/**
 * How the conversation stands. An approval waiting comes first, since the Bot cannot go on with it
 * until the person decides. Keystrokes don't reach it.
 */
export function useConversationStatus(): ConversationStatus {
  const presence = useContext(StoreContext);
  const server = useContext(ServerContext);
  const working = useReported(presence, "working");
  const step = useReported(presence, "step");
  if (server.waiting) return { kind: "needs-you" };
  if (working) return { kind: "working", step };
  if (server.working) return { kind: "working", step: null };
  return { kind: "resting" };
}

/**
 * Whether an approval in this conversation is waiting on the person. A call the server did not ask
 * about again, because the same request was already waiting, waits with it while this is true.
 * False outside a conversation route.
 */
export function useConversationWaiting(): boolean {
  return useContext(ServerContext).waiting;
}

/**
 * The browser steps the conversation's Bot took, oldest first, each with when this tab first saw it.
 * None outside a conversation route.
 */
export function useConversationSteps(): readonly ConversationStep[] {
  return useReported(useContext(StoreContext), "steps");
}

/**
 * Report a conversation's turn, draft and browser steps, for as long as it is mounted. Outside a
 * conversation route there is nothing to report to, and it returns undefined.
 *
 * `working` is the turn, not the run, for the reason `ConversationView` gives: a browser action ends
 * one run and starts another, and the orb would land in the gap. `failed` is the turn having ended
 * without an answer. The step is read off `messages` on every render, as the transcript reads them,
 * because the agent grows the same array in place. Hand the composer `onTextChange`, and call
 * `onStop` when somebody presses Stop, so a stopped answer does not land either. Nor does a turn
 * that ended on a call held for the person, which has no answer yet.
 */
export function useReportConversation({
  working,
  failed,
  messages,
}: {
  working: boolean;
  failed: boolean;
  messages: readonly Message[];
}): { onTextChange: (text: string) => void; onStop: () => void } | undefined {
  const presence = useContext(StoreContext);
  const { approvals } = useContext(ServerContext);
  const step = presence ? stepFor(messages, working, approvals) : null;
  // Read on every render for the same reason as the step.
  const steps = presence ? browserSteps(messages) : NO_STEPS;
  // Asked only as the turn ends, so it is not read again on every token of the answer.
  const waitsOnPerson =
    presence && !working ? turnWaitsOnPerson(messages) : false;
  const wasWorking = useRef(false);
  const stopped = useRef(false);
  /*
   * Every report is this conversation's, by the channel on screen when it mounted. The route keys
   * the conversation on its channel, so that is the channel it stays.
   */
  const store = presence?.store;
  const mine = presence?.channelId ?? null;
  const report = useCallback(
    (change: (current: Reported) => Partial<Reported> | null) =>
      store?.write((current) => {
        // What another conversation reported is not this one's, apart from the count of answers.
        const own =
          current.channelId === mine
            ? current
            : { ...AT_REST, answers: current.answers, channelId: mine };
        const changed = change(own);
        return changed ? { ...own, ...changed } : own;
      }),
    [store, mine],
  );

  // First, so leaving takes everything with it: an answer nobody is there to see does not land.
  useEffect(() => {
    if (!store) return;
    report(() => null);
    return () =>
      store.write((current) =>
        current.channelId === mine
          ? { ...AT_REST, answers: current.answers }
          : current,
      );
  }, [store, mine, report]);

  useEffect(() => {
    if (working && !wasWorking.current) stopped.current = false;
    const answered =
      wasWorking.current &&
      !working &&
      !failed &&
      !stopped.current &&
      !waitsOnPerson;
    wasWorking.current = working;
    report((current) =>
      current.working === working && !answered
        ? null
        : { working, answers: current.answers + (answered ? 1 : 0) },
    );
  }, [report, working, failed, waitsOnPerson]);

  useEffect(() => {
    report((current) => (current.step === step ? null : { step }));
  }, [report, step]);

  useEffect(() => {
    report((current) => {
      if (sameSteps(current.steps, steps)) return null;
      const now = Date.now();
      return {
        steps: steps.map((browser) => ({
          ...browser,
          at: firstSeen(browser.item.id, now),
        })),
      };
    });
  }, [report, steps]);

  const onTextChange = useCallback(
    (text: string) => {
      const drafting = text.trim() !== "";
      report((current) =>
        current.drafting === drafting ? null : { drafting },
      );
    },
    [report],
  );
  const onStop = useCallback(() => {
    stopped.current = true;
  }, []);

  return store ? { onTextChange, onStop } : undefined;
}

/**
 * The Bot's orb, in the state its conversation is in. Its own component, so a keystroke redraws
 * the orb and nothing around it.
 */
export function ConversationOrb({
  participantIds,
  size,
}: {
  participantIds: string[];
  size: number;
}) {
  return (
    <ChannelAvatar
      participantIds={participantIds}
      size={size}
      state={useConversationOrb()}
    />
  );
}

/**
 * The line under the conversation's name: "Working · Searching the web" while the Bot works,
 * "Working" alone for a run the server resumed, "Needs you" while an approval waits here, and
 * nothing at rest. Empty, it takes no height, so the name sits level with the orb.
 *
 * Always mounted, so the live region is there before the first step arrives: a region added with
 * its text already in it is not announced. The step shimmers as a running tool line does, and stops
 * for somebody who asked for less motion.
 */
export function ConversationStatusLine({ className }: { className?: string }) {
  const status = useConversationStatus();
  return (
    <p
      aria-atomic
      aria-live="polite"
      className={cn("type-caption truncate text-muted-foreground", className)}
    >
      {status.kind === "needs-you" ? (
        <span className="font-medium text-status-needs">Needs you</span>
      ) : status.kind === "working" ? (
        <>
          <span className="font-medium text-status-working">Working</span>
          {status.step ? (
            <>
              {" · "}
              <span className="tool-line-running">{status.step}</span>
            </>
          ) : null}
        </>
      ) : null}
    </p>
  );
}
