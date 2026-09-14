import type { Message } from "@ag-ui/core";
import type { Attachment } from "@copilotkit/react-core/v2";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  type AgentOption,
  type CommandOption,
  Composer,
  type ComposerDraft,
  type DroppedAttachments,
  type QueueAction,
  type QueuedMessage,
  reduceQueue,
} from "@/components/channels/composer";
import { attachmentUrl } from "@/lib/channels/attachments";
import { newId } from "../../lib/new-id";

export function ConversationView({
  messages,
  busy = false,
  notice,
  agents = [],
  commands,
  channelId,
  disabled = false,
  pending = false,
  autoFocus = false,
  stopped,
  stoppable,
  queueWhileBusy = false,
  restoring = false,
  onSubmit,
  onStop,
}: {
  messages: readonly Message[];
  busy?: boolean;
  /** Shown above the composer. An error, or why this conversation is read-only. */
  notice?: ReactNode;
  agents?: readonly AgentOption[];
  /**
   * The `/` menu for this Bot's granted skills, supplied by the route that owns grant loading.
   */
  commands?: readonly CommandOption[];
  /**
   * The channel this conversation belongs to, forwarded to the composer so it can upload
   * attachments to it. Omitted by a caller with no channel yet — `/channel/new` creates one on
   * first send — which leaves the composer exactly as it behaved before attachments existed.
   */
  channelId?: string;
  disabled?: boolean;
  /**
   * A turn is in flight: the Bot has been asked something and has not come back yet.
   *
   * It has to mean the TURN and not the run underneath it. A turn that uses the browser is several
   * runs in a row with the agent reporting itself idle between them, and a caller that passes its
   * agent's run status straight through will tell this component the conversation is free in the
   * middle of an answer. `queueWhileBusy` is the part that cannot survive that, because the queue
   * drains on this falling.
   */
  pending?: boolean;
  /** Focus the composer the moment it can take a caret; forwarded to the composer. */
  autoFocus?: boolean;
  /** Why the last turn ended without an answer. Drawn at the end of the transcript, not here. */
  stopped?: string;
  /**
   * There is a run for Stop to abort, which is a narrower fact than `pending` and is the honest one
   * to draw a Stop button from. Defaults to `pending` for a caller with no gap between the two.
   */
  stoppable?: boolean;
  /**
   * Let somebody type at a Bot that is already working, and run what they typed when it finishes.
   *
   * Off by default, and asked for rather than assumed, because it is only true of a conversation
   * that will still be here when the turn ends. The compose screen creates the channel on send and
   * navigates away; a message parked there would go down with the unmount, and a message that
   * silently disappears is a worse answer than a send button that will not go.
   *
   * The other place somebody talks to a Bot, the direct `/bot` chat, does not get this either, and
   * not by a decision made here: that screen draws CopilotKit's own chat rather than this composer,
   * so there is nothing on it for this flag to reach. Giving it the same affordance means either
   * moving it onto this composer or asking for it upstream, and neither is a queue.
   */
  queueWhileBusy?: boolean;
  /** History has been asked for and has not arrived. Drawn as placeholder rows; see `ChatTranscript`. */
  restoring?: boolean;
  onSubmit: (draft: ComposerDraft) => void | Promise<void>;
  /** Stop the Bot mid-answer; forwarded to turn the send button into a stop button. */
  onStop?: () => void;
}) {
  /*
   * THE QUEUE LIVES HERE BECAUSE BOTH HALVES OF IT DO.
   *
   * The composer is what knows a turn is in flight and is where a message is typed; the transcript
   * is where the person has to be able to see that it landed. This is the nearest thing that owns
   * them both, and putting the list in either one would mean handing it straight back out again.
   *
   * See `composer/queue.ts` for what this state is worth: it is memory in one tab, it does not
   * survive a reload, and it is not an outbox.
   */
  const [queued, setQueued] = useState<readonly QueuedMessage[]>([]);
  const queuedRef = useRef<readonly QueuedMessage[]>(queued);

  /**
   * Files the queue left behind AND the reason it did, forwarded to the composer so it can say so
   * rather than leaving somebody to notice on their own that a file they attached is not going to
   * be sent. See `reduceQueue`'s `droppedAttachments` for the two ways a row gets here.
   *
   * Saying so is only half of it, and `releaseStagedAttachment` below is the other half: these rows
   * are still staged server-side, and telling somebody about them without giving them back is a
   * warning shipped alongside its own cause.
   *
   * The cause travels with them because `reduceQueue` cannot supply it — it reports the same
   * `Attachment[]` whether the files were bumped off a merged draft by the cap or carried out of the
   * queue by a message somebody removed, and the composer's sentence for one is false about the
   * other.
   *
   * Only ever set, never appended to: each transition is its own event, and the composer is what
   * turns a new object here into new rejection lines, one batch per event, rather than this file
   * accumulating a list nobody here has any other use for.
   */
  const [droppedAttachments, setDroppedAttachments] =
    useState<DroppedAttachments>();

  /**
   * A turn this screen started and has not seen finish.
   *
   * It is a backstop under `pending` rather than the thing that makes `pending` usable. A caller
   * that reports the turn honestly already covers the gap between `onSubmit` being called and the
   * turn showing up in its own state; one that does not leaves a gap in which a person typing
   * quickly would have their second message read as the start of a second turn, two runs at once on
   * one thread racing each other's history.
   *
   * It cannot be the whole answer, and it was a mistake to let it look like one. This only knows
   * about turns that came in through the composer. A channel starts turns by other routes — the
   * first message of a new channel, a button inside a rendered component — and for those the only
   * thing standing between a parked correction and a mid-answer drain is what the caller passes as
   * `pending`.
   *
   * The composer tracks the same await for its own send button. Two trackers of one promise, which
   * is duplication, and they cannot drift: they rise in the same tick and fall on the same resolve.
   * The alternative is a callback out of the composer announcing an edge, which is a larger surface
   * for the same fact.
   */
  const [running, setRunning] = useState(false);
  const inFlight = pending || running;

  /**
   * Every change to the queue goes through here, so the ref and the state can never disagree.
   *
   * The ref is what the decisions read. React state is a render behind, and both callers below have
   * to know what is actually queued at the moment they are called rather than at the moment they
   * were last rendered — one of them is an effect firing on the same commit that emptied the list.
   *
   * THE WHOLE TRANSITION COMES BACK, NOT JUST THE RUN. It used to hand back `next.run` alone, which
   * was every caller's whole interest until a failed run became something either of them had to
   * answer for: a run can only be put back if you know which of the messages in it the queue
   * contributed, and that is on the transition beside it. Recomputing it out here would mean
   * re-deriving from a queue this function has already emptied.
   */
  const apply = useCallback((action: QueueAction) => {
    const next = reduceQueue(queuedRef.current, action);
    queuedRef.current = next.queue;
    setQueued(next.queue);
    // Only on an actual drop, so a settle or a remove that let go of nothing does not hand the
    // composer a fresh empty array it has no reason to react to.
    if (next.droppedAttachments.length > 0) {
      /*
       * THE ACTION IS WHAT SAYS WHICH OF THE TWO CAUSES THIS WAS, and this is the only place that
       * has both halves. `reduceQueue` reports the same `Attachment[]` whether the files were
       * bumped off a merged draft by the cap or carried out of the queue by a message somebody
       * removed, so the cause cannot be recovered downstream — and the composer's sentence for one
       * of them is false about the other.
       */
      for (const attachment of next.droppedAttachments) {
        releaseStagedAttachment(attachment);
      }
      setDroppedAttachments({
        attachments: next.droppedAttachments,
        cause:
          action.type === "remove"
            ? "queued-message-removed"
            : "merged-over-cap",
      });
    }
    return next;
  }, []);

  /**
   * WALKING AWAY WITH SOMETHING STILL PARKED IS THE THIRD WAY A ROW LOSES ITS LAST REFERENCE, and
   * until this it was the one way that said nothing and gave nothing back.
   *
   * IT USED TO BE THE FOURTH, and the one that went was a way a row should never have lost its last
   * reference at all: a drained turn whose send failed used to release everything it was carrying.
   * That one is now a restore — the messages go back in the queue, still holding their rows — so
   * the ways out are the two in `apply` above, a removal and the cap's excess, and this.
   *
   * The other two go through `apply` above. This one goes through React:
   * `queue.ts` is candid that the queue "lives and dies with the component holding it" and that
   * switching channels "takes anything parked in it with it" — but that paragraph is about the
   * person's WORDS, which they watched land on screen and can retype. It was never a statement
   * about the staged rows underneath them, and `releaseStagedAttachment` is explicit that a parked
   * entry holds the only reference anything has to those.
   *
   * WHAT IT COSTS TO SKIP, stated because it is smaller than the other two and the fix should be
   * priced honestly: the upload cap is scoped by `uploadGroup`, minted per composer mount, so this
   * orphan does not refuse anybody's next pick the way a removal's would — the composer that staged
   * it is gone and its group with it. It is storage held for up to a day by
   * `cull-staged-attachments.ts`, not a 409. Worth releasing anyway, because the row is bytes in a
   * table nobody will ever ask for again and the release is two lines.
   *
   * BEST-EFFORT IN THE STRICTEST SENSE. This runs during teardown, so the requests go out into a
   * component that is already gone and nothing here could act on an answer even in principle —
   * which is exactly what `releaseStagedAttachment` already is. A tab CLOSING is not this path at
   * all and is not chased: the page is going, `fetch` on the way out is not reliable, and the
   * sweeper is the honest answer for that one.
   *
   * The ref rather than the state, for the reason `apply` records: on an unmount that follows a
   * transition in the same commit, the state is a render behind and the ref is not. Empty on
   * StrictMode's development double-mount, which makes that pass a no-op.
   */
  useEffect(
    () => () => {
      for (const message of queuedRef.current) {
        for (const attachment of message.attachments) {
          releaseStagedAttachment(attachment);
        }
      }
    },
    [],
  );

  /**
   * A RUN BUILT OUT OF THIS QUEUE FAILED, SO THE DRAIN WAITS FOR A TURN BEFORE TRYING AGAIN.
   *
   * Without it the restore below is a spin. The drain effect reads `queuedRef` rather than the
   * state, so the restored messages are visible to it the instant `apply` writes them — and the
   * commit that clears `running` schedules that effect with no ordering guarantee against the
   * rejection that restores. The two land in either order, so on a server that is refusing every
   * request the queue could be re-sent immediately, fail, restore, and be re-sent again, as fast as
   * the round trip allows. A retry the person did not ask for is not a retry, it is a loop.
   *
   * A REF AND NOT STATE, for the reason `queuedRef` is one: the effect that reads this runs on the
   * commit that clears `running`, and a state update made in the rejection is a render behind. It
   * also must not itself cause a render — nothing on screen changes when a queue is held back; the
   * entries are drawn as parked either way.
   */
  const heldBack = useRef(false);

  /**
   * PUT A FAILED RUN'S MESSAGES BACK WHERE THEY CAME FROM, and hold the drain until somebody asks.
   *
   * The one answer to a failed send, used by both paths that can produce a run. See the drain's
   * `catch` for why restoring rather than releasing, and `heldBack` for why the hold.
   */
  const restoreFailedRun = useCallback(
    (messages: readonly QueuedMessage[]) => {
      if (messages.length === 0) {
        return;
      }
      // Before the restore, not after: the effect reads both off refs, and the guard has to be
      // true by the moment the queue is non-empty again rather than one statement later.
      heldBack.current = true;
      apply({ messages, type: "restore" });
    },
    [apply],
  );

  const start = async (draft: ComposerDraft) => {
    setRunning(true);
    try {
      await onSubmit(draft);
    } finally {
      setRunning(false);
    }
  };
  /** Read through a ref so an inline `onSubmit` from the route does not re-run the drain effect. */
  const startRef = useRef(start);
  startRef.current = start;

  /**
   * Send now, or park it. Which one is the composer's call: it holds the only accurate view of
   * whether a turn is in flight, and `reduceQueue` holds what follows from the answer.
   */
  const submit = useCallback(
    (draft: ComposerDraft, whileBusy: boolean) => {
      const next = apply({
        busy: whileBusy,
        draft,
        id: newId(),
        type: "submit",
      });
      if (!next.run) {
        return undefined;
      }
      const started = startRef.current(next.run);
      /*
       * A SEND THAT TOOK THE QUEUE WITH IT AND THEN FAILED LEAVES THE PARKED HALF HELD BY NOBODY,
       * which is the same shape the drain effect below answers, and with the same line.
       *
       * The ordinary send is not this. Its run IS the draft in the box, and the composer's `catch`
       * puts those words and those chips straight back — so `restoreIfRunFails` is empty for it and
       * this branch never runs. It is only the join, where `reduceQueue` empties the queue into an
       * outgoing draft, that produces a run carrying messages the composer never had.
       *
       * WHICH MESSAGES IS THE QUEUE'S ANSWER AND NOT ONE COMPUTED HERE. By the time this rejects,
       * the queue that knew where each message came from is empty; `restoreIfRunFails` was decided
       * on the transition that emptied it. Restoring the composer's own as well would queue a
       * second copy of the words that are back in somebody's box.
       *
       * `started` IS WHAT GOES BACK TO THE COMPOSER, not the promise this `catch` derives from it.
       * The composer needs the rejection to restore the words, so the failure must still be its to
       * handle; the derived promise exists only to hang the restore off, is settled by the `catch`
       * itself, and is deliberately dropped.
       */
      if (next.restoreIfRunFails.length > 0) {
        const carried = next.restoreIfRunFails;
        void started.catch(() => {
          restoreFailedRun(carried);
        });
      }
      return started;
    },
    [apply, restoreFailedRun],
  );

  /**
   * The turn ended. Whatever was waiting for it goes now, as one message.
   *
   * KEYED ON THE TURN BEING OVER AND NOT ON HOW IT ENDED, which is what makes Stop useful rather
   * than final: a person who parks a correction and then presses Stop has said "not that, this",
   * and this is the line that hears the second half of it. A finished run, a failed one and a
   * stopped one all arrive here the same way, so there is no stop path to forget.
   *
   * The one edge it watches is `inFlight` falling, and it does not watch the queue. Nothing can be
   * parked while the conversation is idle: the composer only parks when it believes a turn is in
   * flight, and it believes that from the same value this effect reads. A queue that grew here
   * without a turn to wait for would be a queue that never drains, so if that ever becomes possible
   * this dependency list is where it will show up.
   *
   * IT REFUSES WHILE THE CONVERSATION IS DISABLED, which is the one thing "however it ended" must
   * not be read to cover. A coworker deleted mid-turn takes the channel with it: the composer stops
   * accepting messages and the notice under it says the conversation can no longer reply, and a
   * queue that drained anyway would post one more user turn into a channel the screen has already
   * said is finished. The cost is that anything parked when that happens stays on screen unrun,
   * under a notice that explains why, which is the honest half of the trade.
   *
   * AND IT REFUSES ONCE A DRAIN HAS FAILED, until a turn starts. See `heldBack`.
   */
  useEffect(() => {
    if (inFlight) {
      /*
       * A TURN STARTING IS WHAT LETS A HELD-BACK QUEUE GO AGAIN, and it is the only thing that
       * does. Every way a turn starts is somebody asking for one — a send, a parked message joined
       * to it, a button inside a rendered card — so the retry is always something a person did,
       * never this effect trying again on its own.
       */
      heldBack.current = false;
      return;
    }
    if (disabled || heldBack.current || queuedRef.current.length === 0) {
      return;
    }
    const next = apply({ type: "settle" });
    if (!next.run) {
      return;
    }
    const carried = next.restoreIfRunFails;
    void startRef.current(next.run).catch(() => {
      /*
       * Swallowed on purpose, and only here. A failed send from the composer throws so the composer
       * can put the words back in the box; the box for these is the queue they came out of, and the
       * screen already reports the failed turn through its own notice.
       *
       * IT USED TO DELETE THE STAGED ROWS INSTEAD, AND THAT WAS DATA LOSS. The reasoning was that
       * the queue had emptied to build this draft and nothing retried it, so the rows behind
       * `run.attachments` were referenced by nothing and might as well be given back rather than
       * waiting for the sweep. The second half of that sentence was never true: `channel-chat.tsx`
       * adds the user message to the transcript BEFORE the run and leaves it there when the run
       * fails, so the files were referenced by a message the person is looking at. Releasing them
       * emptied the tiles under a message that stayed on screen, with nothing said and no way back.
       *
       * SO THE MESSAGES GO BACK IN THE QUEUE, WHOLE. Their words, their `/` chips and the rows the
       * run actually carried return as parked entries — visible in the transcript, carried by the
       * next turn, and released only if somebody takes one back by hand. Deleting on an explicit
       * removal is the one gesture that has ever justified it; a run that failed is not that.
       *
       * `restoreIfRunFails` RATHER THAN THE QUEUE THIS DRAINED, WHICH FOR A DRAIN IS NEARLY THE
       * SAME LIST AND IS NOT THE SAME CLAIM. The cap may have bumped attachments off the joined
       * draft on the way out, and `apply` released those as the run was built; restoring the
       * original entries would re-queue messages pointing at rows that are gone. Spelling it as the
       * queue's own answer is also what lets `submit` — where the two are further apart still — use
       * the identical line.
       *
       * NOT INSIDE `start`, AND THAT IS LOAD-BEARING. `start` is also called from `submit`, where
       * the promise goes back to the composer and the composer restores its own draft. Restoring
       * everything a run carries from inside `start` would queue a second copy of the words that
       * are back in the box, so the decision belongs to the call sites — this one, and the join in
       * `submit`, which answers the same question from the same list.
       */
      restoreFailedRun(carried);
    });
  }, [apply, disabled, inFlight, restoreFailedRun]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-1 min-h-0">
        {/*
         * The command NAMES, joined, rather than the option objects.
         *
         * The transcript needs them only to tell a real skill chip from a message that happens to
         * begin with a slash, and its message rows are memoised on primitives — handing them an
         * array would give every message a new prop identity on each refetch and re-render the whole
         * conversation to change nothing.
         */}
        <ChatTranscript
          busy={busy}
          commandNames={(commands ?? [])
            .map((command) => command.name)
            .join(",")}
          messages={messages}
          onRemoveQueued={(id) => {
            apply({ id, type: "remove" });
          }}
          queued={queued}
          restoring={restoring}
          {...(stopped ? { stopped } : {})}
        />
      </div>
      <div className="max-w-2xl mx-auto w-full px-0 pb-4 shrink-0">
        {notice}
        <Composer
          agents={agents}
          autoFocus={autoFocus}
          {...(channelId ? { channelId } : {})}
          {...(commands ? { commands } : {})}
          className="w-full mt-auto"
          compact
          disabled={disabled}
          droppedAttachments={droppedAttachments}
          onQueue={
            queueWhileBusy
              ? (draft) => {
                  submit(draft, true);
                }
              : undefined
          }
          onStop={onStop}
          onSubmit={(draft) => submit(draft, false)}
          /*
           * `inFlight` rather than the `pending` this was given. A drained turn is started from the
           * effect above rather than from the composer, so the composer's own send tracking knows
           * nothing about it — told only `pending`, it would believe the conversation was idle for
           * as long as the drained run took to start, and the next thing typed would open a third
           * turn instead of joining the queue.
           */
          pending={inFlight}
          /*
           * THE HALF OF THE PER-MESSAGE CAP THE COMPOSER CANNOT SEE.
           *
           * The composer counts what is on its own strip, and parking a message empties it. The
           * server counts every row this person has staged in that composer's `uploadGroup` that
           * has not been sent, and parking a message changes nothing about those: `attachedAt` is
           * written when the message really goes. So without this the two disagree by exactly the
           * size of the queue, and a ninth pick behind eight parked files is accepted here and
           * refused on arrival — a 409 the person was given no chance to avoid, phrased as a count
           * against a strip they can see is empty.
           *
           * READ OFF THE QUEUE ON EVERY RENDER RATHER THAN ACCUMULATED, which is what makes it fall
           * as well as rise. A running total would be right until somebody took a parked message
           * back, and then it would hold slots that nothing occupies — the same refusal, now issued
           * by their own client with no round trip to blame it on.
           *
           * `queued` and not `queuedRef`: this is a render, so the state is the value React is
           * drawing from, and the ref exists for the callbacks that cannot wait a render. They
           * agree here anyway — `apply` writes both on the same line.
           */
          queuedAttachmentCount={queued.reduce(
            (total, message) => total + message.attachments.length,
            0,
          )}
          /*
           * The caller's answer, not `inFlight`. `running` is true from the instant `start` is
           * entered, which is before `onSubmit` has done anything at all, so a Stop drawn from
           * `inFlight` appears while there is still nothing to stop — the press is swallowed and the
           * message goes anyway.
           */
          stoppable={stoppable ?? pending}
        />
      </div>
    </div>
  );
}

/**
 * GIVE BACK THE STAGED ROW BEHIND AN ATTACHMENT THE QUEUE HAS LET GO OF.
 *
 * The composer hands its staged attachments to the queue as a message is parked and clears its own
 * strip in the same breath, so a parked entry holds the only reference anything has to those rows.
 * When `reduceQueue` reports one in `droppedAttachments` — a message taken back before it ran, or
 * the excess the cap re-check bumped off a drained turn — this is the last chance to release it.
 *
 * WHAT NOT DOING THIS COSTS. The row stays with `attachedAt IS NULL` until `cull-staged-
 * attachments.ts` sweeps it a day later. Until then the upload handler counts it against this
 * person's per-channel limit and refuses their ninth pick by naming files that are on nobody's
 * screen, with no way back to them. For the cap case that is the exact 409 the on-screen notice
 * exists to pre-empt, so leaving the row behind shipped the warning together with its cause.
 *
 * ONLY A ROW THAT EXISTS. `metadata.attachmentId` is written by `attachmentsConfigFor` from the
 * upload response, so an attachment that never finished uploading carries none and there is
 * nothing to delete — the same test `composer.tsx` applies before its own DELETE.
 *
 * BEST-EFFORT, AND DELIBERATELY UNINSPECTED, for the reason `composer.tsx` records against the
 * same request: the person did not ask for this, so neither of the two answers it can fail with —
 * 404 for a non-uploader, 409 for an attachment already sent — is anything they could act on.
 *
 * THE SECOND CALLER OF THIS ENDPOINT, and deliberately not shared with the first. `composer.tsx`
 * owns the identical two lines for its own strip; a common helper is the right end state and is a
 * change to a file this one does not own, so the duplication is written down here rather than
 * reached across for.
 */
function releaseStagedAttachment(attachment: Attachment): void {
  const metadata = attachment.metadata as
    | { attachmentId?: unknown }
    | undefined;
  if (typeof metadata?.attachmentId !== "string") {
    return;
  }
  void fetch(attachmentUrl(metadata.attachmentId), {
    method: "DELETE",
    credentials: "include",
  }).catch(() => undefined);
}
