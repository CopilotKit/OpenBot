import type { Attachment } from "@copilotkit/react-core/v2";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/channels/attachments";
import type { ComposerDraft } from "./draft";

/**
 * What happens to a message typed while the Bot already has the turn.
 *
 * The composer used to refuse it. Enter did nothing, the words stayed in the box, and a person
 * watching their coworker head off in the wrong direction had two options: stop the turn and start
 * again, losing whatever it had already done, or wait for it to finish being wrong. Neither is the
 * thing they wanted, which was to say "no, the other one" while it was working and have that land.
 *
 * So a message typed mid-turn is parked rather than dropped, and everything parked runs as ONE
 * follow-up turn when the current one settles. One turn and not one per message, because three
 * quick corrections are usually one correction typed in three breaths: replaying them separately
 * makes the Bot answer the first, act on it, and only then read the sentence saying not to.
 *
 * Settling is not the same as succeeding. The drain is keyed on the turn ENDING and never asks how
 * it ended, which is what makes Stop a way of steering rather than a way of giving up: park a
 * correction, press Stop, and the correction is what runs next. Nothing here special-cases the stop
 * button, and that is the point — a path with its own branch is a path that can be forgotten.
 *
 * THE QUEUE IS MEMORY IN ONE MOUNT AND NOTHING HERE PRETENDS OTHERWISE. The turn is driven from the
 * browser, so the browser is the only place that knows one is in flight, and this state lives and
 * dies with the component holding it. A reload loses the intent to run these words later, and so
 * does walking to another channel: the channel view is keyed on the channel, so switching unmounts
 * the conversation and takes anything parked in it with it, after the person has watched their
 * words land on screen. Neither is worth a persistence layer for words that only mean anything
 * inside a turn that is already over by the time you come back, but both are worth saying out loud.
 * The words are the person's own and sit on screen for as long as they wait, so nothing is being
 * kept from anybody; but a queue is not an outbox and must not be read as one. It is drawn only
 * while a turn is in flight, so a reload finds no queue and shows none, which is better than a list
 * of messages quietly promising to run and never running.
 *
 * A DRAIN THAT DOES NOT LAND PUTS EVERYTHING BACK. Settling is keyed on the turn ending, not on the
 * turn succeeding, and the same is true one level down: the send the drain starts can fail, and for
 * a while what that cost was the whole queue. The messages were gone — emptied to build the draft —
 * and the files under them were deleted outright, while the transcript went on showing the message
 * the failed run had already added to it. So a run built out of this queue that never becomes a
 * message hands its messages back, whole, through `restoreIfRunFails`; they are parked again, they
 * go out with the next turn, and the only thing that deletes their rows is somebody removing one.
 * The retry waits for a turn somebody asks for rather than going again on its own — see
 * `conversation-view.tsx` — because a queue that re-sent itself would spin against a server that is
 * refusing every request.
 *
 * THE FILES UNDER THOSE WORDS ARE NOT COVERED BY THAT PARAGRAPH, and reading them into it was a
 * leak. Words a person watched land on screen can be retyped; a staged attachment is a row on the
 * server that the parked entry holds the only reference to, and letting it die with the mount left
 * it sitting with `attachedAt IS NULL` until the next day's sweep. So the mount going away releases
 * them — see `conversation-view.tsx`'s teardown, which walks the queue on the way out for exactly
 * this. A tab CLOSING is still the sweeper's, and honestly so: nothing in a page that is going can
 * be relied on to finish a request.
 */

/** One message waiting for the Bot to finish, in the words the person typed. */
export type QueuedMessage = {
  /**
   * Minted by the caller, because taking one back needs a handle that survives the list changing
   * around it and the text will not do: two identical corrections are two entries.
   */
  id: string;
  text: string;
  /**
   * The `/` chips that were in it, so a skill invoked mid-turn still applies when the message
   * eventually runs rather than being silently dropped on the way through the queue.
   */
  commandIds: string[];
  /**
   * Whatever was staged on the draft when it got parked, so a file somebody attached before the
   * Bot was ready still applies when the message eventually runs.
   */
  attachments: Attachment[];
};

export type QueueAction =
  /**
   * Somebody pressed send.
   *
   * `busy` is supplied rather than worked out here. The composer is the only thing holding both
   * halves of that answer — the parent's `pending` and its own send that has not resolved — and a
   * second opinion computed somewhere else would disagree with it exactly during the moment between
   * a send starting and the agent reporting itself as running, which is precisely when somebody
   * typing fast needs the answer to be right.
   */
  | { type: "submit"; id: string; draft: ComposerDraft; busy: boolean }
  /** The turn is over, however it ended: finished, failed, or stopped. */
  | { type: "settle" }
  /**
   * A RUN THIS QUEUE EMPTIED ITSELF TO BUILD NEVER BECAME A MESSAGE. Put its messages back.
   *
   * The caller supplies `restoreIfRunFails` from the transition that emptied the queue — see the
   * field for why that list, and not `run.attachments`, is the honest one. They go back at the
   * FRONT: they were typed before anything that has parked since, and the whole reason this queue
   * exists is that a correction must not be read after the sentence correcting it.
   *
   * It produces no run of its own. A failed send that immediately re-sent itself would spin against
   * a server that is down, so restoring is where this stops and the next turn is what carries them;
   * `conversation-view.tsx` holds the drain back until one starts.
   */
  | { type: "restore"; messages: readonly QueuedMessage[] }
  /** Second thoughts, before it has run. */
  | { type: "remove"; id: string };

export type QueueTransition = {
  /** The queue afterwards. The same array when nothing moved, so a render can be skipped. */
  queue: readonly QueuedMessage[];
  /** A turn to start now, or null when there is nothing to run. */
  run: ComposerDraft | null;
  /**
   * EVERYTHING THIS TRANSITION LET GO OF: rows that were staged server-side and that nothing on
   * any screen points at any more, in the order they were parked. Empty on a transition that let
   * go of nothing.
   *
   * Two ways in, and they are the same fact. The cap re-applied in `joinQueued` bumps the excess
   * off a drained turn; a `remove` takes back a whole parked message and everything it was
   * carrying with it. Either way the composer already dropped its own reference when the message
   * was parked, so this list is the last one, and losing it loses the rows.
   *
   * A file somebody attached and never saw again is the exact failure this feature exists to
   * avoid, so neither path can just slice the excess away and say nothing. And the cost of
   * staying quiet outlives the draft: the rows stay staged with `attachedAt IS NULL`, counting
   * against that person's per-channel limit until the 24-hour sweep, and surface as a confusing
   * 409 on their next upload with no way back to the files that caused it.
   *
   * THE CALLER IS WHAT ACTS ON IT. This is the transition naming them — so a caller can release
   * them through `DELETE /api/attachments/:id` and say so on screen — not doing either itself.
   * See `conversation-view.tsx`, which is the only caller that produces this from a real queue.
   */
  droppedAttachments: readonly Attachment[];
  /**
   * OF WHAT `run` IS CARRYING, THE PART NOTHING ELSE IS HOLDING — as the messages it came from, so
   * a caller whose run never becomes a message can put them back rather than having to decide what
   * to do with a bag of orphaned files. Empty when there is no run, and empty when everything on it
   * has somewhere to return to.
   *
   * IT USED TO BE THE ATTACHMENTS ALONE, AND THAT SHAPE ONLY ALLOWED ONE ANSWER. A list of files
   * with no words around them cannot be re-queued — nothing says which message each belonged to,
   * what was typed beside it, or which `/` skills it was invoked with — so the only thing a caller
   * could do with it was delete the rows, and that is what `conversation-view.tsx` did. Deleting
   * them is wrong for the reason the whole area keeps rediscovering: `channel-chat.tsx` adds the
   * user message to the transcript BEFORE the run, and nothing removes it when the run fails, so
   * the release destroyed the files behind a message that is still on screen. Handing back the
   * messages instead makes restoring possible, and restoring is what the caller now does.
   *
   * `droppedAttachments` is about files this transition REFUSED to carry; this is about what it DID
   * carry, named against the possibility that carrying it turns out to have been the last anybody
   * sees of it. The two never overlap: an attachment is either kept by the cap or bumped by it —
   * which is also why the messages here carry only the SURVIVORS. A restored message pointing at a
   * row the cap already gave back would be a retry of a file that no longer exists.
   *
   * WHY THE QUEUE HAS TO ANSWER THIS AND NOT THE CALLER. A drained turn is built out of messages
   * the composer let go of as they were parked, so nothing but this queue ever held them; a live
   * send joining a non-empty queue is built out of BOTH — the parked messages, held by nobody now
   * that the queue has emptied, and the draft in the box, which the composer puts back beside the
   * restored words when the send fails. Restoring the second kind would put a message back in the
   * queue whose words and chips are also sitting in the composer, and send it twice. Only the
   * transition knows which message came from where, so it is the transition that says.
   *
   * Which makes the answer per-case rather than "everything on the run":
   * - `settle` — every message in it, the whole run came out of the queue.
   * - `submit` joining a non-empty queue — the parked ones only; the live draft is the composer's
   *   to restore.
   * - `submit` with nothing waiting — none, the run IS the live draft.
   * - `remove`, a park, and a `restore` — none, there is no run.
   *
   * THE CALLER IS WHAT ACTS ON IT, and only on failure. See `conversation-view.tsx`, where both
   * paths that can produce a run answer this list from the same rule.
   */
  restoreIfRunFails: readonly QueuedMessage[];
};

/**
 * The whole rule, as one pure function, so the interesting cases can be checked without a browser
 * and a live model between the test and the behaviour.
 */
export function reduceQueue(
  queue: readonly QueuedMessage[],
  action: QueueAction,
): QueueTransition {
  switch (action.type) {
    case "submit": {
      /*
       * An idle send is not a queue of one. There is nothing to wait behind, so it goes straight
       * out exactly as it did before any of this existed.
       *
       * WITH SOMETHING ALREADY WAITING IT TAKES THAT WITH IT rather than going first. The two
       * disagreeing is not supposed to be reachable — the drain empties the queue on the same edge
       * that frees the composer — but "not supposed to be reachable" is an argument about two
       * components' timing, and this file is meant to hold the rule on its own. Jumping the line
       * would run a correction after the sentence correcting it, which is the exact reordering the
       * whole queue exists to prevent, so the safe reading of an impossible state is the one that
       * keeps what the person typed in the order they typed it.
       */
      if (!action.busy) {
        if (queue.length === 0) {
          // Nothing stranded: the run IS the draft in the box, and a send that fails hands its
          // words and its chips straight back to the composer they came from.
          return {
            queue,
            run: action.draft,
            droppedAttachments: [],
            restoreIfRunFails: [],
          };
        }
        /*
         * ADDRESSED TO WHOEVER THE LIVE DRAFT IS ADDRESSED TO. This send is going out now, from a
         * composer with a caret in it, so its `@mention` is a live routing decision and not a
         * leftover — and the branch directly above, the same send with nothing parked behind it,
         * honours it. Joining used to hardcode `null` here, which made `@Knowledge` mean one thing
         * or the other depending on whether anything happened to be waiting, a coincidence nobody
         * typing can see. The parked messages have no say: `QueuedMessage` carries no `agentId` at
         * all, for the reason `joinQueued` records.
         */
        const joined = joinQueued(
          [
            ...queue,
            {
              id: action.id,
              text: action.draft.text,
              commandIds: [...action.draft.commandIds],
              attachments: [...action.draft.attachments],
            },
          ],
          action.draft.agentId,
        );
        /*
         * THE PARKED HALF OF WHAT THIS RUN IS CARRYING, AND ONLY THAT HALF. The queue is emptied
         * here, so nothing holds the parked messages any more; the live draft's words, chips and
         * attachments are still the composer's, which puts them back beside each other when the
         * send fails. Restoring those as well would queue a second copy of a message somebody can
         * already see in their box.
         *
         * The messages that were waiting BEFORE this send joined them, rather than a slice of what
         * went out: the cap keeps the earliest, so the survivors happen to be the parked ones first
         * today, and a rule that read that off a slice would quietly go wrong the day the ordering
         * does. `carrying` filters by identity against what the join actually kept.
         */
        return {
          queue: [],
          run: joined.draft,
          droppedAttachments: joined.dropped,
          restoreIfRunFails: carrying(queue, joined.draft.attachments),
        };
      }
      /*
       * PARKED, WITH ITS FILES — AND THE FILES LEAVE ONE MORE PLACE THAN THE WORDS DO.
       *
       * The composer clears its own strip as this message is parked, which is what makes the words
       * look like they landed. It empties something else at the same time: the number the CLIENT'S
       * per-message cap is counted against. `stagedCount` in `composer.tsx` resyncs from the strip
       * on every commit, so after a park it reads zero. The SERVER'S cap counts a different set —
       * every row this person has staged in this composer's `uploadGroup` with `attachedAt IS NULL`
       * — and a parked row is exactly that until the drained turn is sent. The two therefore
       * disagree for the length of the turn: pick a ninth file behind eight parked ones and
       * `screenPickedFiles` accepts it, the upload goes out, and the server answers 409.
       *
       * WHICH IS NOT THE FAILURE `uploadGroup` WAS ADDED TO REMOVE, and the difference decides what
       * this is worth. That one was a 409 naming rows on NOBODY'S screen — a closed tab's, a
       * stopped run's — unreachable by the person holding them, with 24 hours of locked uploads in
       * that channel before the sweeper freed the count. These rows are on screen and are theirs to
       * act on: `chat-transcript.tsx` draws every parked attachment as a tile under its queued line,
       * taking the message back releases them (see `remove` below), and the drain stamps
       * `attachedAt` and frees the group. The server's sentence is true when it arrives — there
       * really are eight waiting to send. What is wrong is only WHO gets to say no, and how long it
       * takes: a refusal that should be instant and in the client's own words costs a round trip and
       * arrives in the server's.
       *
       * IT CANNOT BE CLOSED FROM THIS FILE, and the two ways it looks like it could are both worse.
       * Releasing the rows as the message parks would delete files somebody is still waiting to
       * send, which is the opposite of what every other release here is for. Re-applying the cap on
       * the way IN would bound the queue — it cannot exceed the cap anyway, because the server
       * refuses a ninth upload into one group — without changing the one number that decides
       * whether a pick is accepted, so the 409 would arrive exactly as before. That number is
       * `composer.tsx`'s, built from its own strip, and the queue is not something it can see; the
       * fix is one addend on that side, counting what is parked alongside what is staged.
       */
      return {
        queue: [
          ...queue,
          {
            id: action.id,
            text: action.draft.text,
            commandIds: [...action.draft.commandIds],
            attachments: [...action.draft.attachments],
          },
        ],
        run: null,
        droppedAttachments: [],
        restoreIfRunFails: [],
      };
    }

    case "restore": {
      if (action.messages.length === 0) {
        return {
          queue,
          run: null,
          droppedAttachments: [],
          restoreIfRunFails: [],
        };
      }
      return {
        // At the front: these were typed before anything that has parked while the failed run was
        // out, and the order somebody typed in is the order the Bot has to read.
        queue: [...action.messages, ...queue],
        run: null,
        droppedAttachments: [],
        restoreIfRunFails: [],
      };
    }

    case "settle": {
      if (queue.length === 0) {
        return {
          queue,
          run: null,
          droppedAttachments: [],
          restoreIfRunFails: [],
        };
      }
      /*
       * Nobody in particular. A drain has no live draft behind it — every message in it was parked
       * minutes ago into a conversation already pinned to one coworker — so there is no mention
       * here to honour and none is invented.
       */
      const joined = joinQueued(queue, null);
      return {
        queue: [],
        run: joined.draft,
        droppedAttachments: joined.dropped,
        /*
         * ALL OF THEM. Every message in this drain was parked, which means the composer let go of
         * its words and its attachments at the time, and the queue has just emptied itself to build
         * this. There is no box for a failed drain to put anything back into — so the queue is the
         * box, and a failure puts them back in it.
         */
        restoreIfRunFails: carrying(queue, joined.draft.attachments),
      };
    }

    case "remove": {
      const removed = queue.filter((message) => message.id === action.id);
      if (removed.length === 0) {
        // The same array, not an equal one: a removal that missed must not cost a re-render, and
        // it must not release anything either — nothing left the queue, so every row here still
        // belongs to a message sitting on screen waiting to run.
        return {
          queue,
          run: null,
          droppedAttachments: [],
          restoreIfRunFails: [],
        };
      }
      /*
       * WHATEVER IT WAS CARRYING GOES BACK, because this is the last reference to it. The composer
       * hands its staged attachments over as the message is parked and calls `removeAttachment`
       * on its own strip in the same breath, so from that moment the queue is the only thing
       * holding them. Dropping the entry without saying so left the rows staged server-side with
       * nothing on any screen pointing at them until the 24-hour sweep — counting against that
       * person's per-channel limit the whole time, and surfacing as a 409 naming files they have
       * no way back to. The composer's own strip already answers this exact gesture by releasing
       * the row behind a removed chip; this is the queue answering it the same way.
       */
      return {
        queue: queue.filter((message) => message.id !== action.id),
        run: null,
        droppedAttachments: removed.flatMap((message) => message.attachments),
        restoreIfRunFails: [],
      };
    }
  }
}

/**
 * The messages a run is carrying, carrying only the rows it actually took.
 *
 * ONE RULE FOR BOTH PATHS THAT CAN PRODUCE A RUN, which is the whole reason this is a function. A
 * drain and a live send joining a queue answer `restoreIfRunFails` from the same question — of the
 * messages the queue gave up, what is restorable — and two call sites each filtering for themselves
 * is two places for the cap's survivors and the cap's casualties to be confused with one another.
 *
 * BY IDENTITY AGAINST WHAT THE JOIN KEPT, not by count or by position. The cap keeps the earliest
 * files, so a restored message may have handed over three attachments and get one back; the other
 * two were bumped, reported through `droppedAttachments`, and released by the caller as the run was
 * built. Restoring those would put a message back pointing at rows that no longer exist.
 *
 * A MESSAGE LEFT WITH NOTHING AT ALL IS NOT RESTORED. A wordless, skill-less message whose only
 * attachments the cap bumped has nothing left to send and nothing to show: re-queueing it would
 * draw a blank row with a Remove button and no content, for a message that is genuinely gone.
 */
function carrying(
  queue: readonly QueuedMessage[],
  kept: readonly Attachment[],
): readonly QueuedMessage[] {
  const survivors = new Set(kept);
  return queue
    .map((message) => ({
      ...message,
      attachments: message.attachments.filter((attachment) =>
        survivors.has(attachment),
      ),
    }))
    .filter(
      (message) =>
        message.text.trim().length > 0 ||
        message.commandIds.length > 0 ||
        message.attachments.length > 0,
    );
}

/** The draft a drain produces, plus whatever the cap re-check would not let it keep. */
type Joined = {
  draft: ComposerDraft;
  dropped: Attachment[];
};

/**
 * Everything waiting, as the one turn it is about to become.
 *
 * Newlines rather than spaces. What the person typed were separate messages, and running them
 * together into a paragraph invents a sentence nobody wrote; keeping the line breaks keeps them as
 * lines of a single instruction, which is how a burst of corrections reads out loud anyway.
 *
 * WORDLESS MESSAGES CONTRIBUTE NO LINE. A message here is not obliged to have any text: a pasted
 * screenshot with nothing typed beside it is the whole point of `canSendDraft` unlocking on
 * attachments alone, and one parked mid-turn arrives with `text: ""`. Joining that in the way the
 * rest are joined opens the drained turn with a blank line, or splits two corrections apart with
 * one, and a blank line is an instruction nobody wrote. The message still counts for everything
 * else it carries — its files and its skills go in exactly as they would have.
 *
 * Which means the joined text CAN be empty, and `isEmpty` has to be computed rather than asserted:
 * a drain of nothing but screenshots has no words in it, and a field that claims otherwise is a
 * field no reader can trust for the case it exists to answer.
 *
 * `agentId` IS THE CALLER'S TO SUPPLY, and it is the one field of the joined draft that nothing in
 * the queue can answer. A `QueuedMessage` does not carry one: a message parked mid-turn lands in a
 * conversation already pinned to one coworker for the life of its thread, so there is nothing an
 * `@` could change, and the text of the mention stays in the words, where it was typed and where
 * it still reads as addressed. A LIVE draft joining the queue on its way out is the other case
 * entirely — it is being sent this instant and its mention routes — so which answer applies is
 * decided at each call site rather than assumed to be `null` here.
 */
function joinQueued(
  queue: readonly QueuedMessage[],
  agentId: string | null,
): Joined {
  /*
   * A parked message carries whatever the sender had staged when they parked it, in queue
   * order. Dropping them here would lose a file somebody attached before the Bot was ready.
   *
   * THE CAP HAS TO BE RE-APPLIED ON THE WAY OUT. It is checked as files are staged, against one
   * draft at a time; joining three parked messages of eight files each would produce a single
   * draft of twenty-four, which is a message this deployment does not accept and no later check
   * would catch. The earliest files win, the same order-of-arrival rule `screenPickedFiles`
   * applies within one draft, so the survivors are the ones the person picked first. That split
   * is not free, though: the excess is still staged server-side and nothing that survives this
   * function points at it any more, so `dropped` is what lets a caller give the rows back and say
   * which files went — instead of the person finding out from a 409 on their next upload with no
   * way back to what caused it.
   */
  const flattened = queue.flatMap((message) => message.attachments);
  const attachments = flattened.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const dropped = flattened.slice(MAX_ATTACHMENTS_PER_MESSAGE);

  const text = queue
    .map((message) => message.text)
    .filter((line) => line.trim().length > 0)
    .join("\n");

  return {
    draft: {
      text,
      agentId,
      // The same skill queued twice is still one instruction. Sending it twice would put the
      // same paragraph in front of the Bot two times and say nothing new by doing it.
      commandIds: [...new Set(queue.flatMap((message) => message.commandIds))],
      isEmpty: text.length === 0,
      attachments,
    },
    dropped,
  };
}
