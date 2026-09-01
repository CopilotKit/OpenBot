/**
 * Delivering a hop: running the Bot that was addressed, and putting its answer in the conversation.
 *
 * The other half of `handoff.ts`. Deciding happens inside somebody's run and has to be quick and
 * fail closed; delivering is a whole agent turn against a model, and it has to survive the pod it
 * started on. So the two are separated by the queue rather than by a function call.
 *
 * CLAIMED, NOT ASSIGNED. Any replica may take any hop, which is what makes this work on a cluster
 * where the Bot being addressed is very unlikely to be on the pod that addressed it. The lease is
 * renewed for as long as the run takes, because a run is minutes and a lease that lapses mid-answer
 * hands the same hop to a second replica and bills for it twice.
 */
import { type AuditStore, recordAuditEvent } from "../audit";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";
import { HANDOFF_KIND } from "./handoff";

/** What a hop carries, as `handoff.ts` wrote it. */
export type HandoffWork = {
  fromBotId: string;
  toBotId: string;
  actorId: string;
  threadId: string;
  runId: string;
  depth: number;
  task: string;
  constraints?: string;
  expecting?: string;
  /** The asking Bot's display name, for the line a person reads. Absent falls back to its id. */
  fromName?: string;
  /** The addressed Bot's display name, for the same reason. */
  toName?: string;
  /**
   * Where the answer belongs, when it is not the addressed Bot's own conversation.
   *
   * Set on the one kind of hop that goes backwards: telling the asking Bot, in the conversation the
   * person is actually watching, that the Bot it asked never answered. That conversation belongs to
   * the asking Bot, which is why it can speak in it at all.
   */
  answerIn?: string;
};

export type HandoffDelivery = {
  /**
   * Run the addressed Bot against the conversation, and resolve when its turn is on record.
   *
   * Rejecting means the hop did not happen and is worth another go. Resolving means it did, whatever
   * the Bot said: a Bot that answers "I could not find that" has answered, and retrying would ask it
   * the same question again and bill for the same non-answer.
   *
   * Resolves with what the Bot said, because its turn runs in a scratch thread nobody is shown:
   * the words it comes back with exist for the relay or not at all. Null means a turn of nothing
   * but tool calls, which is a turn that happened and nothing worth carrying back.
   */
  deliver: (input: {
    work: HandoffWork;
    /** The message the addressed Bot sees, already attributed by the deployment. */
    message: string;
    /**
     * The one line of it that belongs in the transcript, if any.
     *
     * TWO TEXTS, because they have two readers. The model needs the envelope: who is asking, the
     * task, its constraints, what a good answer looks like, and an instruction about who to write
     * for. A person scrolling their conversation with the addressed Bot needs to know why it
     * suddenly said something, in one sentence. Persisting the envelope puts a paragraph of
     * machine instructions in their transcript, in a bubble that looks like something they wrote.
     *
     * Absent means nothing is kept, which is right for a Bot going back to its own conversation to
     * report a failure: what it says already explains why it spoke, and the instruction that made it
     * speak is addressed to a model.
     */
    shown?: string;
    /** The signed statement of the run it is starting, carrying its depth. */
    assertion: string;
  }) => Promise<{ answer: string | null }>;
};

export type HandoffRunReport = {
  delivered: string[];
  skipped: { key: string; reason: string }[];
};

/**
 * How often a claim is refreshed while a hop is being delivered.
 *
 * Comfortably inside the lease, because a renewal that lands after it has lapsed is not a renewal:
 * the item has already gone to somebody else, and this one is now the second replica running it.
 */
const RENEW_EVERY_MS = 20_000;

/**
 * How long a hop that is over is kept before it is dropped.
 *
 * Long past the point where its key still has to stop a duplicate — that is the asking run's own
 * lifetime, minutes — and short enough that this table holds about a day of work rather than all of
 * it. Both the finished ones and the ones that ran out of attempts: the second is a terminal state
 * somebody can query, and a day is long enough to query it in.
 */
const REAP_OLDER_THAN_MS = 24 * 60 * 60 * 1_000;

export function createHandoffRunner(options: {
  queue: WorkQueue;
  /** Queue namespace. Injectable so database-backed tests cannot claim another suite's hops. */
  kind?: string;
  delivery: HandoffDelivery;
  /** Who this replica is, for the lease. */
  owner: string;
  /** How the deployment signs what the addressed Bot's run is. */
  sign: (work: HandoffWork) => string;
  auditStore: AuditStore;
  /** How long a claim lasts before anything may take it back. */
  leaseMs?: number;
  /** How many hops one sweep will take. */
  limit?: number;
  /** After how many tries a hop is given up on. Told to `claim` as well as gating the notice. */
  maxAttempts?: number;
  /**
   * How often a claim is refreshed. Comfortably inside the lease.
   *
   * Injectable so the thing it protects against can be driven in a test in milliseconds rather than
   * in minutes. What it protects against is a batch whose tail expires while its head is delivering,
   * which is a matter of one duration outrunning another and does not care about the scale.
   */
  renewEveryMs?: number;
}) {
  const {
    queue,
    kind = HANDOFF_KIND,
    delivery,
    owner,
    sign,
    auditStore,
    leaseMs = 60_000,
    limit = 5,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    renewEveryMs = RENEW_EVERY_MS,
  } = options;

  /**
   * Put the failure in front of the person, by running the Bot that asked in the conversation they
   * are watching.
   *
   * THROUGH THE SAME QUEUE, not by writing a line somewhere. The asking Bot is the only thing that
   * can speak in that conversation, and what the person needs is a sentence in its voice saying who
   * it asked and that nothing came back. A row written past the Bot would be a message from nobody.
   *
   * Marked with `answerIn`, which is also what stops this recursing: a notice that fails is not
   * itself worth a notice, and the check above skips any hop that carries one.
   */
  /**
   * Put the answer in front of the person, the same way a failure is: by running the Bot that
   * asked, in the conversation they are watching.
   *
   * THE ADDRESSED BOT NEVER SPEAKS THERE — the platform gives a thread exactly one agent — so its
   * words come home in the asking Bot's voice, attributed. The same `answerIn` marker that stops a
   * notice recursing stops a relay relaying: a hop that carries one enqueues nothing when it lands.
   *
   * The answer is clipped rather than trusted to be a paragraph. It rides inside the prompt of the
   * relaying run, and a Bot that came back with a report the length of a book would otherwise spend
   * the relay's whole context window repeating it.
   */
  const relay = (work: HandoffWork, key: string, answer: string) =>
    queue.offer({
      kind,
      // Outside the run's fan-out prefix and keyed on the hop, for the same two reasons as the
      // notice below: a relay is not a Bot this run asked for, and one run may legally ask the
      // same Bot two different things.
      key: `relay:${key}`,
      payload: {
        fromBotId: work.toBotId,
        toBotId: work.fromBotId,
        actorId: work.actorId,
        threadId: work.threadId,
        runId: work.runId,
        depth: work.depth,
        answerIn: work.threadId,
        task: `You asked ${work.toName ?? work.toBotId} to help with this: ${work.task}\n\nIt answered:\n\n${clip(answer)}\n\nGive the person the outcome. Keep what matters, drop the pleasantries, and say it came from ${work.toName ?? work.toBotId}.`,
      } as unknown as Record<string, unknown>,
    });

  const tell = (work: HandoffWork, key: string, reason: string) =>
    queue.offer({
      kind,
      /*
       * OUTSIDE THE RUN'S OWN PREFIX, and carrying the failed hop's key.
       *
       * Outside, because the fan-out cap counts every row whose key starts with `${runId}:` and a
       * notice is not one of the Bots this run asked for. A hop that failed for good while the run
       * was still going would otherwise spend a third of a three-Bot budget on the message saying
       * so, and the run's next legitimate ask would be refused with "this turn has already asked 3
       * Bots" after asking two.
       *
       * Carrying the hop's key, because one run may legally ask the same Bot two different things.
       * Keyed on the Bot alone both notices are the same work to `offer`, the second is dropped on
       * conflict, and the person hears about one of their two lost questions with the other's
       * reason — for a whole day, until `reap` drops the row that is blocking it.
       */
      key: `notice:${key}`,
      payload: {
        fromBotId: work.toBotId,
        toBotId: work.fromBotId,
        actorId: work.actorId,
        threadId: work.threadId,
        runId: work.runId,
        depth: work.depth,
        answerIn: work.threadId,
        task: `You asked ${work.toBotId} to help with this and it never answered: ${forThePerson(reason)}. Tell the person plainly that it did not come back, say what you had asked it for, and offer what you can do yourself.`,
      } as unknown as Record<string, unknown>,
    });

  return {
    /**
     * Drop hops that are over, long after they were.
     *
     * NOTHING ELSE REAPS THIS KIND. A finished hop is kept rather than deleted, because a key that
     * is still there is what makes `offer` idempotent and stops a retried delivery running the other
     * Bot twice. Kept for ever, though, the table only grows — and the fan-out cap counts rows under
     * a run's prefix with a `LIKE` that no index serves, so every offer pays for every hop the
     * deployment has ever made.
     *
     * The window is what keeps both true at once. Idempotency only has to hold while the asking run
     * could still offer the same hop again, which is minutes; a day is far past that and still short
     * enough that the table reflects roughly a day's work.
     */
    async reap(): Promise<number> {
      return queue.purge({
        kind,
        olderThanMs: REAP_OLDER_THAN_MS,
        maxAttempts,
      });
    },

    /** Deliver whatever this replica can claim. */
    async sweep(): Promise<HandoffRunReport> {
      const claimed = await queue.claim({
        kind,
        owner,
        leaseMs,
        limit,
        /*
         * The same ceiling the notice below is gated on, because two different ceilings is two
         * different ideas of when a hop is over.
         *
         * `claim` stops serving a row at its own cutoff. Set higher here than there and the row is
         * never handed out again, `attempts` never reaches this number, and the notice that exists
         * to stop a person waiting for ever is never sent: the silent stop, arriving through the
         * feature built to prevent it. Set lower and the person is told it failed for good while
         * the queue keeps handing it out, so the Bot may answer after they were told it would not.
         */
        maxAttempts,
      });
      const report: HandoffRunReport = { delivered: [], skipped: [] };

      /*
       * EVERY CLAIMED HOP IS RENEWED, not just the one being delivered.
       *
       * A claim leases the whole batch from one moment and this loop delivers them one at a time, so
       * a heartbeat started per item leaves the rest of the batch on a lease that is quietly running
       * out while the first delivery runs. A delivery is minutes and the lease is one, so the tail of
       * every batch expired, was claimed by another replica, and was delivered twice: two model
       * calls, two answers in the person's conversation, and both replicas reporting success.
       *
       * Reproduced against a real PostgreSQL with two replicas, which is the only way this shows up:
       * the item in flight is fine, and the ones waiting behind it are not.
       */
      const ours = new Set(claimed.map((item) => item.key));
      const heartbeat = setInterval(() => {
        for (const key of ours) {
          void queue
            .renew({ kind, key, owner, leaseMs })
            .then((kept) => {
              // False means it went to somebody else. Dropped rather than renewed again, so the
              // loop below knows not to spend a model call on work it no longer holds.
              if (!kept) ours.delete(key);
            })
            .catch(() => {});
        }
      }, renewEveryMs);

      try {
        for (const item of claimed) {
          const work = item.payload as unknown as HandoffWork;
          if (!work?.toBotId || !work.threadId) {
            /*
             * A hop nothing can be done with. Finished rather than released, because releasing it puts
             * the same unusable row back on the queue for ever.
             */
            await queue.finish({ kind, key: item.key, owner });
            report.skipped.push({ key: item.key, reason: "not a hop" });
            continue;
          }

          /*
           * A hop that has already been tried is not a fresh one, and the difference matters here more
           * than anywhere else this queue is used: a first attempt has certainly not run the other
           * Bot, while a second may already have run it, spent a model call and posted an answer
           * before its owner died. Recorded rather than guessed at, so somebody reading the trail can
           * tell a duplicate answer from a mystery.
           */
          if (item.attempts > 1) {
            await recordAuditEvent(auditStore, {
              eventType: "agent.handoff_retried",
              targetType: "agent",
              targetId: work.toBotId,
              ...(work.actorId ? { actorUserId: work.actorId } : {}),
              payload: {
                // See the same key on `agent.handoff_delivered` below: the Audit screen's Bot
                // column reads `payload.bot`, so a row without it names no Bot.
                bot: work.fromBotId,
                from: work.fromBotId,
                to: work.toBotId,
                run: work.runId,
                attempt: item.attempts,
                note: "A previous attempt may already have run this Bot.",
              },
            });
          }

          /*
           * How long the hop took, recorded either way. A hop is a run nobody is watching, so the
           * trail is the only place its duration is visible: "delivered in 4s" and "delivered in 4m"
           * are the same row otherwise, and the second is what a person waiting was actually shown.
           */
          const startedAt = Date.now();
          /*
           * Still ours, ASKED OF THE DATABASE, immediately before a model call rather than after it.
           *
           * Consulting the heartbeat's own set would only catch a renewal that had been attempted
           * and refused. A process paused long enough for the lease to lapse never attempted one, so
           * its set still says the hop is his, and he delivers it on top of whoever has since taken
           * it. The renewal is the question and the answer at once, and it puts a fresh lease under
           * the delivery about to start, which is the moment one is most needed.
           *
           * Running a hop that is no longer ours is the expensive half of a duplicate: a whole agent
           * turn, billed, ending in a second answer in somebody's conversation.
           */
          const stillOurs = await queue.renew({
            kind,
            key: item.key,
            owner,
            leaseMs,
          });
          if (!stillOurs) {
            ours.delete(item.key);
            report.skipped.push({
              key: item.key,
              reason: "the lease went elsewhere",
            });
            continue;
          }

          try {
            const shown = summarise(work);
            const { answer } = await delivery.deliver({
              work,
              message: attribute(work),
              ...(shown ? { shown } : {}),
              assertion: sign(work),
            });
            const kept = await queue.finish({
              kind,
              key: item.key,
              owner,
            });
            ours.delete(item.key);
            /*
             * `finish` answering false means the lease went elsewhere while this ran, so another
             * replica may have delivered the same hop. The turn happened either way and the trail has
             * to say so; what it must not say is that this replica finished the work, because it did
             * not, and a person reading two similar answers would have nothing to tell a duplicate
             * from a mystery.
             */
            if (!kept) {
              report.skipped.push({
                key: item.key,
                reason: "delivered, but the lease had gone elsewhere",
              });
              await recordAuditEvent(auditStore, {
                eventType: "agent.handoff_retried",
                targetType: "agent",
                targetId: work.toBotId,
                ...(work.actorId ? { actorUserId: work.actorId } : {}),
                payload: {
                  // See the same key on `agent.handoff_delivered` below.
                  bot: work.fromBotId,
                  from: work.fromBotId,
                  to: work.toBotId,
                  run: work.runId,
                  attempt: item.attempts,
                  note: "This replica delivered a hop whose lease had already gone elsewhere. Another may have delivered it too.",
                },
              });
              continue;
            }
            report.delivered.push(work.toBotId);
            /*
             * The answer goes home through the queue, like the turn that produced it: durable, so a
             * pod dying between the turn and the relay loses the relay to a retry rather than for
             * ever. Only for a forward hop with words to carry — a relay of a relay is the loop the
             * `answerIn` check exists to stop, and a wordless turn has nothing to say.
             */
            if (!work.answerIn && answer) {
              await relay(work, item.key, answer).catch((failure) => {
                // The turn happened and is on record; a relay that cannot be queued must not undo
                // that by failing the hop into a retry and a second turn.
                console.warn(
                  "Could not queue the relay for a delivered hop.",
                  failure,
                );
              });
            }
            await recordAuditEvent(auditStore, {
              eventType: "agent.handoff_delivered",
              targetType: "agent",
              targetId: work.toBotId,
              ...(work.actorId ? { actorUserId: work.actorId } : {}),
              payload: {
                // See the same key on `agent.handoff_offered`: the Audit screen's Bot column reads
                // `payload.bot`, so a row without it names no Bot.
                bot: work.fromBotId,
                from: work.fromBotId,
                to: work.toBotId,
                run: work.runId,
                depth: work.depth,
                ms: Date.now() - startedAt,
              },
            });
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : "could not be delivered";
            /*
             * The last try, so the person is told rather than left waiting.
             *
             * Enqueued before the release, because the release is what makes this attempt the last
             * one: after it the row will never be claimed again and nothing else will ever look at
             * this hop. A person who was told their question had been handed on, and then hears
             * nothing for ever, has no way to tell a slow Bot from a broken one.
             */
            if (item.attempts >= maxAttempts && !work.answerIn) {
              await tell(work, item.key, reason).catch((failure) => {
                // A notice that cannot be queued must not take the release with it: leaving the row
                // claimed would be worse than a hop nobody was told about.
                console.warn(
                  "Could not queue the notice for a hop that failed for good.",
                  failure,
                );
              });
            }
            /*
             * Released and pushed out rather than dropped. The work still wants doing, and whatever
             * refused it once will probably refuse it again in the next second.
             */
            await queue.release({
              kind,
              key: item.key,
              owner,
              delayMs: 60_000,
              reason,
            });
            ours.delete(item.key);
            report.skipped.push({ key: item.key, reason });
            await recordAuditEvent(auditStore, {
              eventType: "agent.handoff_failed",
              targetType: "agent",
              targetId: work.toBotId,
              ...(work.actorId ? { actorUserId: work.actorId } : {}),
              payload: {
                // See the same key on `agent.handoff_delivered` above. This row is the one a
                // person's unanswered question ends on, so a Bot column showing a dash on it is
                // the worst place in the set to have one.
                bot: work.fromBotId,
                from: work.fromBotId,
                to: work.toBotId,
                run: work.runId,
                attempt: item.attempts,
                reason,
                ms: Date.now() - startedAt,
              },
            });
          }
        }
      } finally {
        clearInterval(heartbeat);
      }

      return report;
    },
  };
}

/**
 * How much of an answer one relay will carry.
 *
 * Generous, because with the answer living nowhere a person is shown, what the relay drops is gone:
 * the scratch thread that holds the rest is never mapped to a channel. The cap exists for the Bot
 * that comes back with a book — an answer that size swamps the relaying run's prompt, and the
 * asking Bot was told what a good answer looks like precisely so this stays a paragraph.
 */
const RELAY_ANSWER_LIMIT = 12_000;

function clip(answer: string): string {
  if (answer.length <= RELAY_ANSWER_LIMIT) return answer;
  return `${answer.slice(0, RELAY_ANSWER_LIMIT)}\n\n[…the answer was cut here for length]`;
}

/**
 * The same failure, in words that can be said out loud.
 *
 * The reason on a failed hop is whatever threw, and one of the things that throws is the platform
 * client, whose message is `Intelligence platform error 409: {"error":{...}}` — a response body,
 * verbatim. That reason is interpolated into the notice a Bot then paraphrases to a person, so an
 * internal error envelope ends up in somebody's chat. The trail keeps the whole thing; the sentence
 * gets the shape of the problem.
 */
function forThePerson(reason: string): string {
  const platform = reason.match(/^Intelligence platform error (\d{3})\b/);
  if (platform) {
    return `the platform answered ${platform[1]} (the full response is in the trail)`;
  }
  return reason;
}

/**
 * What the addressed Bot is shown.
 *
 * WHO IS ASKING IS STAMPED HERE, from the row this deployment wrote, and never taken from anything a
 * model produced. A Bot able to write its own attribution is a Bot able to claim to be another one,
 * and the whole point of naming the sender is that the answer can be trusted to say who wanted it.
 *
 * The parts stay parts. The asking model was made to name the task, its constraints and what a good
 * answer looks like precisely so the receiving one does not have to infer them out of a paragraph,
 * and flattening them back into prose here would throw that away at the last step.
 */
function attribute(work: HandoffWork): string {
  /*
   * A notice is not a request for help, and must not read as one.
   *
   * This one goes to the Bot that ASKED, in the conversation it is already in, and its whole content
   * is what became of the hop. Dressed in the wording below it would tell a Bot that the Bot it
   * asked has now asked it for something, which is the beginning of a loop rather than the end of
   * one.
   */
  if (work.answerIn) {
    return `${work.task}\n\nSay this in your own words to the person in this conversation, in a sentence or two. Do not hand it to another Bot.`;
  }
  const lines = [
    `${work.fromBotId} has asked you to help with this, on behalf of the person in this conversation.`,
    "",
    `Task: ${work.task}`,
  ];
  if (work.constraints) lines.push(`Constraints: ${work.constraints}`);
  if (work.expecting)
    lines.push(`What a good answer looks like: ${work.expecting}`);
  lines.push(
    "",
    "Answer in this conversation as yourself. The person can see it, so write it for them rather than for the Bot that asked.",
  );
  return lines.join("\n");
}

/**
 * The same hop, in one line, for the person who will scroll past it.
 *
 * They did not send this and it is not addressed to them: their conversation with one Bot has a
 * message in it because a different Bot asked for something. So it says exactly that, and leaves the
 * constraints and the shape-of-answer notes out. Those are instructions to a model, and reading
 * somebody else's instructions to a model is how a transcript stops being a conversation.
 */
function summarise(work: HandoffWork): string | null {
  /*
   * Nothing, for a Bot going back to its own conversation to say a hop failed. Its own sentence is
   * the whole message; the text that prompted it is an instruction to a model, and shown here it
   * appears as something the person typed and then had read back to them.
   */
  if (work.answerIn) return null;
  return `${work.fromName ?? work.fromBotId} asked ${work.toName ?? work.toBotId} for this on your behalf: ${work.task}`;
}
