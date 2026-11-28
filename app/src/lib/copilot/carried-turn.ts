import { EventType, type Message } from "@ag-ui/core";
import type { AbstractAgent } from "@copilotkit/react-core/v2";
import { client } from "@/lib/client";
import {
  currentOrganizationId,
  organizationHeaders,
} from "@/lib/organizations/current";
import { withoutWaitingPlaceholders } from "./approval-context";
import { joinWithin } from "./join-thread";
import {
  askRunGoing,
  askRunLiveness,
  type RunLiveness,
  watchQuietRun,
} from "./quiet-run";
import { followLastRun } from "./stopped-turn";

/**
 * A turn the server carries on by itself.
 *
 * The server runs a Bot's computer steps in the run, as it does for routines and tasks, and it can
 * carry a person's turn on in a run of its own: past the most steps one run takes, past a run's
 * deadline, or on another server after the one running it stopped. That run is the server's, started
 * with nobody's browser asking, so the stream of the run this browser started ends before it, and the
 * conversation used to stop where that stream did: no working dot, no steps after it, and on a page
 * that slept through the end, "The Bot stopped before it finished" under a turn that went on to its
 * answer. A browser that hears its run end before the Bot has answered asks the server whether a run
 * is still going in the conversation, and when one is, joins the thread and follows it to its end, as
 * opening the conversation mid-turn does.
 */

/**
 * Whether the Bot has answered the person's latest message: the last thing it said since is words,
 * with no step after them. A turn that ends on a step's answer, or on a step, has not.
 */
export function turnAnswered(messages: readonly Message[]): boolean {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at];
    if (!message) continue;
    if (message.role === "user" || message.role === "tool") return false;
    if (message.role !== "assistant") continue;
    if (message.toolCalls?.length) return false;
    const content = message.content;
    return typeof content === "string" ? content.trim().length > 0 : !!content;
  }
  return false;
}

/**
 * Stop the person's turn in a thread wherever it is: in a run, or carried on by the server between
 * one run and the next, where no run is going for a Stop to reach. The runtime's own stop route,
 * which the server answers before the runtime does by taking the person's carried turn off its
 * queue, and which reaches a run going too. Only the person's own turn is stopped. A Stop the server
 * did not take is said as a failure (`ClientError`), never taken as done.
 */
export async function stopCarriedTurn(
  agentId: string,
  threadId: string,
): Promise<void> {
  await client(
    `/api/copilotkit/agent/${encodeURIComponent(agentId)}/stop/${encodeURIComponent(threadId)}`,
    {
      method: "POST",
      // Stopped in the organization this tab works in, as its runs are (copilot/provider.tsx).
      headers: organizationHeaders(currentOrganizationId()),
      fallback: "Couldn't stop the Bot. Try again.",
    },
  );
}

/**
 * Whether a conversation's work names the person's own turn, which the server is carrying on with no
 * page open (`turn`), between one run and the next too. Sent only to an app that says it understands
 * it (`conversation-work-turn`, `lib/client.ts`).
 */
export function isTurnWork(entry: { kind: string }): boolean {
  return entry.kind === "turn";
}

/** Whether a conversation's work says the server is carrying the person's turn on. */
export function serverCarriesTurn(
  work: readonly { kind: string }[] | undefined,
): boolean {
  return work?.some(isTurnWork) ?? false;
}

/**
 * Whether a turn's messages end on a step's answer. A run the server ends to carry the turn on ends
 * on one, past the last step it answered.
 */
export function endsOnStep(messages: readonly Message[]): boolean {
  return messages.at(-1)?.role === "tool";
}

/**
 * Whether the turn is waiting on the person: a run that ended to ask them something, or a step held
 * for their approval here. Its next run starts when they answer, not before.
 */
export function waitsOnPerson(agent: {
  messages: readonly Message[];
  pendingInterrupts?: readonly unknown[];
}): boolean {
  if ((agent.pendingInterrupts?.length ?? 0) > 0) return true;
  const since = agent.messages.slice(
    agent.messages.findLastIndex((message) => message.role === "user") + 1,
  );
  return withoutWaitingPlaceholders(since).length !== since.length;
}

/**
 * The run the server is carrying this conversation's turn on in: the run going there now, when it is
 * not `heard`, the run this browser is already hearing. Null when no run is going, or when the server
 * can't say.
 */
export async function carriedRun(
  conversationId: string,
  heard: string | null,
  ask: typeof askRunGoing = askRunGoing,
): Promise<string | null> {
  const going = await ask(conversationId);
  if (going.liveness !== "live" || !going.runId) return null;
  return going.runId === heard ? null : going.runId;
}

/**
 * Join the thread and follow the run going in it to its end, as a page that comes back mid-turn
 * does: what ran while this browser was not hearing it is replayed, and the rest streams in.
 *
 * Watched as a run this browser started is (`watchQuietRun`): gone quiet, the server is asked whether
 * the conversation still has a run, and a run that is over, or a server that can't say, ends the
 * join. Says which run it last heard start, to ask how it ended, and how the join ended: `joined`
 * when the run's end came down the join.
 */
export async function followCarriedRun({
  agent,
  join,
  conversationId,
  quietMs,
  ask = (id) => askRunLiveness(id),
}: {
  agent: Pick<AbstractAgent, "subscribe" | "detachActiveRun">;
  /** The join itself: the SDK's connect for this agent. */
  join: () => Promise<unknown>;
  conversationId: string;
  quietMs: number;
  ask?: (conversationId: string) => Promise<RunLiveness>;
}): Promise<{
  runId: string | null;
  ended: "joined" | "over" | "unreachable";
}> {
  const last = followLastRun(agent);
  let ended: "joined" | "over" | "unreachable" = "joined";
  let stopKept = () => {};
  try {
    await joinWithin({
      connect: join(),
      // Kept from the start: there is a run to follow, which is why this was asked for.
      deadline: Promise.resolve(),
      detach: () => agent.detachActiveRun(),
      answering: () => true,
      keptUntil: () => {
        const quiet = watchQuietRun({
          ask: () => ask(conversationId),
          quietMs,
        });
        const hearing = agent.subscribe({
          onEvent: ({ event }) => {
            if (
              event.type === EventType.RUN_FINISHED ||
              event.type === EventType.RUN_ERROR
            )
              quiet.rest();
            else quiet.heard();
          },
        });
        stopKept = () => {
          quiet.stop();
          hearing.unsubscribe();
        };
        return quiet.over.then((outcome) => {
          ended = outcome;
          hearing.unsubscribe();
        });
      },
    });
  } catch {
    // A join that throws is a join that is over; the thread is read back by the caller either way.
  } finally {
    stopKept();
    last.stop();
  }
  return { runId: last.runId(), ended };
}

/**
 * Follow the turn for as long as the server carries it on in runs of its own, one after another, and
 * say which run it was last in: null when the server carried nothing on. Stops at the Bot's answer, at
 * a join that ended without hearing its run end, or when `stopped` says the turn is no longer this
 * browser's to follow.
 */
export async function followServerTurn({
  agent,
  conversationId,
  heard,
  join,
  quietMs,
  stopped,
  ask = askRunGoing,
}: {
  agent: Pick<AbstractAgent, "subscribe" | "detachActiveRun" | "messages">;
  conversationId: string;
  /** The run this browser is already hearing, or last heard, which is not the server's next one. */
  heard: string | null;
  join: () => Promise<unknown>;
  quietMs: number;
  stopped: () => boolean;
  ask?: typeof askRunGoing;
}): Promise<string | null> {
  let last: string | null = null;
  let known = heard;
  for (;;) {
    if (stopped()) return last;
    const next = await carriedRun(conversationId, known, ask);
    if (next === null) return last;
    const followed = await followCarriedRun({
      agent,
      join,
      conversationId,
      quietMs,
    });
    last = followed.runId ?? next;
    known = last;
    if (followed.ended !== "joined" || turnAnswered(agent.messages))
      return last;
  }
}
