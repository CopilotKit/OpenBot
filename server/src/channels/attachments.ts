import {
  classifyAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  namesNoFormat,
} from "@openbot/shared/attachments";
import { sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  CommitIncompleteError,
  FileVersionConflictError,
  filesClient,
  filesIdempotencyKey,
  PendingLimitError,
  type StoredFile,
} from "../files/client";
import { sniffMimeType } from "./attachment-mime";
import type { StoredAttachment } from "./attachment-parts";

/**
 * Where an attachment lives: Intelligence's file store, as a file of this purpose whose
 * `collection` is the channel it was uploaded into, whose `ownerUserId` is the uploader and whose
 * `batch` is the composer session that staged it. A staged attachment is a PENDING file, and a
 * sent one is COMMITTED: `committedAt` is what this module used to call `attachedAt`.
 *
 * Who may see a file is still decided HERE, against this deployment's own `channels` and
 * `channel_memberships` tables, exactly as before. Intelligence holds the bytes and the facts about
 * the file; it knows nothing of channels or members, and the project key that reaches it never
 * leaves this server.
 */
export const ATTACHMENT_PURPOSE = "chat_attachment";

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value even has the shape of an attachment id.
 *
 * An attachment's id is the UUID Intelligence's file store keys it on, and every id in this file
 * arrives as text somebody else chose: a path param off a URL, or a slice of a message part. Text
 * that is not uuid-shaped names no file; it used to raise Postgres `22P02` against the old `uuid`
 * column and throw before any row could fail to match, and Intelligence refuses it as a malformed
 * id. So each of the entry points below asks this first and answers "no such attachment" itself.
 */
function isUuidShaped(value: string): boolean {
  return UUID_SHAPE.test(value);
}

/**
 * The channel a turn's thread belongs to, or null when it belongs to none.
 *
 * What a turn running in one conversation may touch: files that belong to THAT conversation's
 * channel. The thread-to-channel mapping is this deployment's (`intelligence_channel_mappings`) and
 * the file is Intelligence's, so this is now a lookup the caller does, read once per question and
 * compared against the file's `collection`. It used to be a correlated subquery in the same
 * statement that read the row, which is not possible across two stores. What that shape protected
 * is kept the other way it was protected: the two callers take `threadId` in a NAMED FIELD. `actorId`
 * and `threadId` are both `string`, adjacent, and positionally swappable with no type error and no
 * test failure — the swap would simply widen the scope back to what it was. An object parameter
 * cannot be transposed.
 *
 * AND IT DEGRADES WHEN THE THREAD MAPS TO NO CHANNEL, which is the half that took evidence to get
 * right rather than reasoning. The tempting shape is "no mapping, no attachment". That is wrong,
 * because three real surfaces run turns on threads this deployment deliberately keeps no channel
 * for:
 *
 *  - A FORWARD AGENT HOP. `handoff-delivery.ts` mints a scratch thread of the addressed Bot's own
 *    (an Intelligence thread has exactly one agent, so a second Bot cannot answer inside the
 *    first's conversation) and then seeds it with the ASKING channel's history, attachment parts
 *    and all. Refusing on a missing mapping, every one of those files would resolve to null on a
 *    thread that maps to nothing, and because history is resolved with `onMissing: "note"` the
 *    addressed Bot would be told `[attachment "x" is no longer available]` about files that exist
 *    and that the same person may read. It would not even fail loudly: a hop's last user message is
 *    the synthetic instruction `handoff-delivery.ts` appends, so the `"fail"` branch that exists to
 *    catch exactly this never covers a hop's history.
 *  - THE DIRECT `/bot` CHAT, whose thread comes from `POST /api/threads/mint` — "a conversation
 *    this deployment keeps no channel for", in that route's own words. Its runs go through the
 *    ordinary runtime endpoint and so reach this loader.
 *  - A BACKWARDS HOP relaying into either of those.
 *
 * So the rule is: if this thread belongs to a channel, the file must belong to that same channel;
 * if it belongs to no channel, this adds nothing and the membership check remains the whole of the
 * check. That is strictly narrower than what was here before it and never narrower than a working
 * surface needs, which is the only combination that closes the gap without breaking a hop.
 *
 * NOTE WHAT IT STILL STOPS, because the degrade reads more permissive than it is. The case the
 * reviewers reproduced is a person in channels A and B naming an A-file on a turn in B. B's thread
 * IS mapped, so the degrade branch does not apply, the lookup yields B, and A ≠ B refuses. The
 * branch only opens for a thread nobody is shown.
 */
async function channelOfThread(
  database: Database,
  threadId: string,
): Promise<string | null> {
  const rows = (await database.execute(sql`
    select channel_id as "channelId"
    from intelligence_channel_mappings
    where thread_id = ${threadId}::text
    limit 1
  `)) as unknown as { channelId: string }[];
  return rows[0]?.channelId ?? null;
}

/**
 * Whether `actorId` may see what is in channel `channelId` at all: the channel exists, has not
 * been deleted, and they have a membership row on it.
 *
 * `channels` is in the question, not only `channel_memberships`, and the difference is a channel
 * that has been deleted. Deletion here is soft — `channels.deletedAt` — so the channel row and every
 * membership on it survive it, and a question that asks only "is this actor a member" answers yes
 * for ever afterwards: the bytes would stay downloadable — and inlinable — after the channel they
 * belong to is gone.
 *
 * One statement, so the channel and the membership are read from the same snapshot.
 */
async function canOpenChannel(
  database: Database,
  actorId: string,
  channelId: string | null,
): Promise<boolean> {
  if (!channelId) return false;
  const rows = (await database.execute(sql`
    select 1 as "member"
    from channels
    join channel_memberships
      on channel_memberships.channel_id = channels.id
      and channel_memberships.user_id = ${actorId}::text
    where channels.id = ${channelId}::text
      and channels.deleted_at is null
    limit 1
  `)) as unknown as { member: number }[];
  return rows.length > 0;
}

/**
 * The attachment behind an id, if Intelligence holds one: a live file of this purpose. Anything
 * else — no such file, an expired staged one, a file some other part of the deployment stored —
 * is not an attachment, and reads as null.
 */
async function attachmentFile(id: string): Promise<StoredFile | null> {
  const file = await filesClient().get(id);
  return file && file.purpose === ATTACHMENT_PURPOSE ? file : null;
}

/**
 * Whether a file is one `actorId` may see: sent, or their own. A staged file is a file nobody has
 * shared with anybody yet, so it is its uploader's alone until a send says otherwise.
 */
function sentOrOwn(file: StoredFile, actorId: string): boolean {
  return file.committedAt !== null || file.ownerUserId === actorId;
}

/**
 * The file behind an attachment reference, read for one person's turn. A PURE READ: nothing about
 * being shown a file says anybody sent it, and this function writes nothing.
 *
 * PER ACTOR, AND MEMBERSHIP IS THE CHECK — the live channel and the actor's membership on it, which
 * is the check the upload route leads with and the one `GET /api/attachments/:id` below uses. The id
 * this is called with came out of `input.messages`, which is the browser's: `resolveAttachmentParts`
 * (attachment-parts.ts) reads it out of a user message's own content, and nothing between the wire
 * and here rejects a message that was never in the thread — the runtime hands the input to the agent
 * and only filters what it PERSISTS. So a signed-in person can put an `/api/attachments/<id>` part
 * for a channel they are not in on a message they compose themselves, and no uuid needs guessing to
 * do it: somebody removed from a channel still holds its ids in their local transcript. This function
 * therefore cannot assume the asker is entitled to what they named, and checks membership itself
 * rather than inferring it from where the id came from.
 *
 * Null when no row is visible to this actor — no such attachment, an id that could not name one,
 * a channel that has since been deleted, or not theirs to see, the same answer for all four as on
 * the fetch route. `resolvePart` turns that into a failed turn naming the id, which is the correct
 * outcome: a turn that refers to an attachment the asker cannot see must not proceed to a model
 * that would read the file back to them.
 *
 * THIS USED TO STAMP `attachedAt`, and the reasoning was that a load past the membership join is
 * the closest thing to evidence of a send there is. It is not close enough, in two directions at
 * once. This function is called for the message being asked about AND for every attachment in the
 * history behind it, on every turn — so a read-time stamp said "sent" about every file anybody had
 * ever been shown, including one that is still staged in somebody's composer. And it is scoped to
 * MEMBERSHIP, because members are meant to see each other's sent files, so any member could freeze
 * a colleague's staged row by naming its id in a message of their own: that row then answered the
 * colleague's own withdrawal with a 409 for ever and the sweeper would never reclaim it either.
 *
 * The send writes the column instead. It goes out through AG-UI rather than through either router
 * in this file, so the write is made where the send is actually known to have happened — in
 * `inlineAttachments` (copilot.ts), which is the one place that can tell the message being asked
 * about from the history behind it — through {@link markAttachmentsSent}.
 *
 * IT DOES READ `attachedAt`, THOUGH, WHICH IS NEW. A staged row is a file nobody has shared with
 * anybody yet, so it is its uploader's alone until a send says otherwise; a sent one belongs to the
 * conversation and every member of the channel may read it. The asymmetry used to run one way only:
 * the comment below explains at length why a reader must not WRITE a colleague's staged row, and
 * then let any member read one.
 *
 * AND SCOPED TO THE TURN'S OWN CHANNEL, which it did not used to be. See
 * {@link channelOfThread} for the shape and for why it degrades on an unmapped thread instead of
 * refusing. What it closes: somebody in channels A and B could put an id from A on a message they
 * compose in B, and this returned the bytes. They already hold that file, so it was never
 * escalation — but it left a message in B whose file lives in a channel B has nothing to do with,
 * and the day A is deleted that message's attachment is permanently broken in B while the row is
 * still there. The run carries the thread id, so the channel behind it is knowable here now.
 */
export async function loadAttachmentForTurn(
  database: Database,
  turn: { actorId: string; threadId: string },
  id: string,
): Promise<StoredAttachment | null> {
  /*
   * The same uuid-shape guard as the two routes below, and it belongs here rather than at either
   * caller because this id is the one nothing shaped. A path param at least came off a route
   * pattern; this one comes out of `attachmentIdFor` (attachment-parts.ts), which slices whatever
   * follows `/api/attachments/` in a browser-supplied message part — so a query string, a second
   * path segment, and the empty string all arrive here as "ids".
   *
   * The consequence is worse here than on a route, too. A 500 is one failed request; this throw
   * lands inside `resolvePart`, which only degrades a NULL into the `onMissing: "note"` text. A
   * throw goes straight past that degradation, and history is replayed on every turn, so a single
   * malformed part would fail this channel's every future turn for ever, with no recovery but
   * starting another channel. An id no file could have is an id no file has: null.
   */
  if (!isUuidShaped(id)) return null;

  const file = await attachmentFile(id);
  if (!file) return null;

  /*
   * Sent, or this actor's own. The uploader's half is not a courtesy: this runs for the message
   * being sent BEFORE {@link markAttachmentsSent} commits it, so without it the ordinary first send
   * of a file would refuse to inline the very file it is sending.
   */
  if (!sentOrOwn(file, turn.actorId)) return null;

  /*
   * The conversation this turn is running in: the file's channel must be the thread's, unless the
   * thread belongs to no channel. See {@link channelOfThread}.
   */
  const turnChannel = await channelOfThread(database, turn.threadId);
  if (turnChannel !== null && file.collection !== turnChannel) return null;

  /*
   * The live channel the file was uploaded into, and the actor's membership on it. This is the
   * path that hands bytes to a MODEL rather than to a browser, so without the channel half somebody
   * in a deleted channel could name an id out of their own local transcript on a message they
   * compose themselves and have the file read back to them.
   */
  if (!(await canOpenChannel(database, turn.actorId, file.collection))) {
    return null;
  }

  // The file can have been withdrawn or have expired between the read above and this one; that is
  // the same "no such attachment" as if it had happened a moment earlier.
  const bytes = await filesClient().content(id);
  if (!bytes) return null;
  return { mimeType: file.contentType, name: file.name, bytes };
}

/**
 * Records that these attachments went out in a message, on behalf of the person who sent it.
 *
 * WRITTEN BY THE SENDER, NOT BY A READER. Being sent — `committedAt` on the file, `attachedAt` as
 * this deployment's own table called it — means one thing, "this file rode in a message somebody
 * actually sent", and three readers depend on that one meaning: the staged expiry treats a pending
 * file as one nobody came back for and lets Intelligence remove it once its time is up; the upload
 * route treats a pending file as a slot still occupied against `MAX_ATTACHMENTS_PER_MESSAGE`; and
 * `DELETE /api/attachments/:id` treats a sent one as a promise to a sent message and refuses to
 * withdraw the file. A mark written as a side effect of reading cannot carry that meaning, because
 * reading is not sending: history is replayed in full on every turn, for whoever happens to be
 * running it, so a read-time stamp says "sent" about every file anybody has ever been shown.
 *
 * SCOPED TO THE UPLOADER, and that is a second, separate reason a read may not write this. Reading
 * is scoped to CHANNEL MEMBERSHIP, because members are supposed to see each other's sent files —
 * so a stamp on the read path let any member freeze a colleague's still-staged file simply by naming
 * its id in a message of their own. That file then answers the colleague's own DELETE with a 409 for
 * ever, and the expiry will not reclaim it either, because both of those read the sent mark and the
 * mark now says the file was sent. Only the uploader's own send may commit the uploader's own file,
 * so the commit names `ownerUserId` beside the ids.
 *
 * The FIRST send is kept, not the most recent one: committing a file that is already committed
 * changes nothing. A message is replayed as history on every later turn and a stopped run is
 * retried; neither is a new send, and neither should move a timestamp that already means something.
 *
 * Ids that could not name a file are dropped before the request rather than passed to it. These
 * come out of `attachmentIdFor` (attachment-parts.ts), which slices whatever follows
 * `/api/attachments/` in a browser-supplied message part, so a query string, a second path segment
 * and the empty string all arrive here as "ids" — and one malformed id would get the whole commit
 * refused as invalid. Nothing left to ask about is not a request at all.
 *
 * AND SCOPED TO THE TURN'S OWN CHANNEL, by the same {@link channelOfThread} rule the reader uses,
 * for a harm that was reproduced rather than reasoned about. A person in channels A and B could
 * name an id from A on a message they sent in B, and this stamped the file in A. Nothing in A ever
 * referred to it, and yet it was now un-withdrawable — the withdrawal route refuses a sent
 * attachment with a 409 — and unsweepable, because only staged files expire. The person was left
 * holding a file they could neither use nor get rid of, in a channel that had never seen it. That is
 * the same shape as the freeze the uploader scope above exists to prevent, reached from the other
 * direction.
 *
 * THE SAME RULE AS THE READER, NOT A STRICTER ONE, and that was a decision. A stricter write — an
 * unmapped thread commits nothing — is unreachable for a hop (a hop's asked message is
 * `handoff-delivery.ts`'s synthetic instruction, which names no attachment, so the
 * `ids.length === 0` return above fires first) and so looked free. It was rejected because on the
 * one surface where it IS reachable, the direct `/bot` chat, it fails in exactly the direction this
 * mark's whole purpose is to avoid: a file that really was sent silently never gets committed, and
 * the expiry deletes it a day later out from under a conversation that shows it. One rule, stated
 * once, is also one rule to keep true.
 *
 * IT RAISES WHEN IT CANNOT PROVE THE COMMIT LANDED, AND IT USED TO SWALLOW. The sentence that stood
 * here said that a turn is a person waiting for an answer, and that bookkeeping which could not be
 * written is not worth failing that answer over. The first half is true. The second rested on a
 * premise that is false: that by the time this runs, the answer has been earned. It has not.
 * `inlineAttachments` (copilot.ts) calls this BEFORE it hands the history back, and that history is
 * what `super.run` / `next.run` is given afterwards — so at this moment no model has been called, no
 * token has been spent, and the person's message is still in front of them. Raising here costs a
 * retry of something that never started.
 *
 * Staying silent costs the FILE. A staged file expires, so a turn that answered happily about an
 * attachment it never committed leaves a message displaying a file Intelligence deletes a day later;
 * the upload cap keeps counting the slot until then. That damage is permanent, silent, and lands on
 * somebody who did nothing but send a file. An answer somebody can ask for again is the cheaper of
 * the two losses, and this is called at the one point in the turn where that trade is still on
 * offer — which is why the third option, refusing before the turn is spent, beats both halves of
 * the dilemma rather than splitting it.
 *
 * Refusing here is also not a new KIND of outcome on this path. `resolvePart`'s `"fail"` mode
 * already refuses this same turn at this same moment when the asked message names a file that
 * cannot be loaded or cannot be afforded — same reason, same recovery, same sentence-shaped error.
 *
 * WHAT STILL DOES NOT RAISE, because the old swallow was not protecting nothing:
 *
 *  - AN ID THAT COULD NEVER NAME A FILE, dropped before the request as before. A browser part that
 *    is not an attachment reference is not a failed send.
 *  - NOTHING TO RECORD, which is still not a request at all.
 *  - HISTORY. Only the asked message's ids are passed in, so nothing behind it is committed or
 *    checked, and a replayed thread does not acquire new ways to fail.
 *  - A FILE THAT IS ALREADY SENT. A committed file is a SUCCESS here, not a race lost: a stopped run
 *    retried and a message replayed are both ordinary, and a rule that failed them would be failing
 *    people for doing nothing wrong — whoever's file it is.
 *
 * "NOTHING CHANGED" IS NOT WHAT IT CHECKS. A commit that changed nothing is right for a file that
 * was already sent and wrong for one that is missing, so the count of changes is silent about the
 * failure that matters. What has to be true is not "this request changed something" but "this id
 * is, NOW, durably recorded as sent in this conversation", and that is exactly what Intelligence's
 * commit asks after its update, as a second statement with a fresh snapshot — so a file a
 * concurrent run of the same message committed a moment ago counts as sent, and two runs of one
 * message never refuse each other. Every id that cannot answer it is named in the refusal.
 *
 * THAT CHECK DOES NOT REPEAT THE READER'S MEMBERSHIP CHECK, deliberately. Whether this actor may
 * see these files was settled by {@link loadAttachmentForTurn} earlier in the same turn, and a
 * second, subtly different copy of an access rule is a thing to keep in step rather than a check.
 * What is asked here is only what this function is responsible for — the file still exists, it is
 * sent, and it is in this turn's channel.
 *
 * ALL OR NONE, SO A REFUSED SEND LEAVES NO MARKS BEHIND. A message may name several files and only
 * one of them need be missing. Keeping the others' marks would record a send for a turn that never
 * ran, which is the exact freeze the paragraphs above are about: un-withdrawable, unsweepable, and
 * referred to by nothing. Intelligence's commit is one transaction that rolls back when any id
 * cannot be committed, so a refusal puts the files back as the turn found them and the person's
 * retry starts from a clean state.
 *
 * NO LOCK OF ITS OWN, AND THAT WAS CHECKED RATHER THAN ASSUMED. The commit and the two things that
 * can take a file out from under it — `DELETE /api/attachments/:id`, conditional on the version it
 * read, and the staged expiry, which only applies while a file is pending — contend for the same
 * ROW in Intelligence, and its row lock already serialises them: withdrawal first, and the commit
 * finds no file, so the send is refused; commit first, and the withdrawal's version is stale, so it
 * deletes nothing and answers the 409 pinned by "a send landing mid-request cannot have its file
 * deleted out from under it" in attachment-routes.test.ts. They cannot both win.
 *
 * The log names the actor and the ids, because every consequence of a missing mark — a file the
 * expiry reclaims, a slot that never frees — is about a specific person and a specific file, and a
 * line naming neither cannot be acted on. The raised message names the ids as well. There is no
 * `app.onError` behind this server, but this refusal never becomes a response status: it leaves
 * through the run as an AG-UI error, the road `resolvePart`'s refusals already take, so what the
 * composer receives is the sentence rather than a plain-text 500.
 */
export async function markAttachmentsSent(
  database: Database,
  turn: { actorId: string; threadId: string },
  ids: readonly string[],
): Promise<void> {
  const known = [
    ...new Set(ids.filter(isUuidShaped).map((id) => id.toLowerCase())),
  ];
  if (known.length === 0) return;

  let unrecorded: readonly string[] = [];
  try {
    const channel = await channelOfThread(database, turn.threadId);
    await filesClient().commit(
      {
        ids: known,
        purpose: ATTACHMENT_PURPOSE,
        ownerUserId: turn.actorId,
        // The channel this send actually happened in. See {@link channelOfThread}.
        ...(channel !== null ? { collection: channel } : {}),
      },
      filesIdempotencyKey("commit"),
    );
  } catch (error) {
    /*
     * A failure that is not the commit's own refusal is a failure to reach Intelligence (or this
     * deployment's database) at all — a lost connection, a timeout, a 5xx. Nothing is known to have
     * landed, and Intelligence's commit is all-or-none, so every id is unrecorded.
     */
    unrecorded =
      error instanceof CommitIncompleteError ? error.uncommitted : known;
    // The ids that are actually unaccounted for, not the whole list that was asked about: a message
    // may name four files and have one of them go missing, and it is the one that has to be
    // findable from a log line.
    console.error(
      `Could not record attachments as sent for ${turn.actorId} in ${turn.threadId}: ${unrecorded.join(", ")}.`,
      error,
    );
    if (unrecorded.length === 0) unrecorded = known;
  }

  if (unrecorded.length === 0) return;

  const named = unrecorded.map((id) => `"${id}"`).join(", ");
  throw new Error(
    `Your message wasn't sent because ${unrecorded.length === 1 ? "an attachment on it" : "attachments on it"} couldn't be saved (${named}). ` +
      "Attach the files again and resend.",
  );
}

/**
 * The batch a client that names no upload group is counted in.
 *
 * A tab left open across a deploy is running the JavaScript from before it, which sends no
 * `uploadGroup` at all. Left ungrouped those rows would have NULL here, `null = <anything>` is never
 * true, and the cap would count zero of them and never refuse anything — a hole, not a fallback. So
 * every group-less upload from one person in one channel shares this one bucket, which is exactly
 * the per-channel counting this server did before the column existed. Old clients keep old
 * behaviour; new ones get the per-composer count.
 *
 * No UUID can collide with it, and `newId()` only mints UUIDs.
 */
const LEGACY_UPLOAD_GROUP = "legacy";

/**
 * How many unsent attachments ONE PERSON may hold across the whole deployment, whatever they call
 * their upload groups and whichever channels they are in.
 *
 * NOT THE CAP, AND NOT A REPLACEMENT FOR IT. {@link MAX_ATTACHMENTS_PER_MESSAGE} is the number the
 * composer knows, shows and refuses on, counted per `upload_group` for the reasons the route's own
 * comment gives at length. This is a backstop underneath it, and it exists because that cap counts
 * a bucket the CLIENT names: `uploadGroup` arrives as a form field, `uploadGroupOf` deliberately
 * does not validate its value, and a caller that mints a fresh one on every request therefore has
 * zero prior rows in every bucket it is ever counted against. The cap never fires, and nothing else
 * bounded staged `bytea` — the only remaining ceilings were the ~8 MB per-request body limit and
 * `scripts/cull-staged-attachments.ts`, whose default window is 24 hours. Reproduced through this
 * route before it was closed: 33 uploads, a fresh `newId()`-shaped group on each, 33 rows written.
 *
 * PER UPLOADER, ACROSS ALL CHANNELS, and both halves of that were forced.
 *
 * - Per uploader rather than per deployment, because a deployment-wide ceiling is a ceiling one
 *   person can sit on: fill it and every colleague's upload is refused for a sentence naming
 *   nothing they did. It also makes every upload contend on one counter.
 * - Across all channels rather than per channel, because `POST /api/channels` is open to any
 *   authenticated user (`channels/routes.ts`). A per-channel backstop is a backstop a client moves
 *   by creating a channel, which is the same defect as one it moves by choosing a string — a few
 *   more bytes per bucket, still unbounded.
 *
 * ROWS RATHER THAN BYTES, which was the harder call. A row here is at most
 * `MAX_IMAGE_BYTES` (8 MiB), so counting rows bounds bytes too, at 32 x 8 MiB = 256 MiB of staged
 * blobs per person — a real bound, derived rather than declared. A separate `sum(size_bytes)`
 * ceiling was written and dropped: it buys a tighter storage number at the cost of a second limit
 * to keep honest, a second refusal sentence for a person to make sense of, and a test that has to
 * push a quarter of a gigabyte through the route to prove it. If the byte ceiling ever needs to be
 * independent of the file ceiling — an attachment kind larger than 8 MiB, say — that is the moment
 * to add it, and this comment is where to say so.
 *
 * FOUR MESSAGES' WORTH, deliberately loose. Ordinary work never comes near it: the composer refuses
 * a ninth file per message, so reaching 32 means four full eight-file messages composed and left
 * unsent at the same time, inside the sweeper's 24-hour window. Two tabs — the case the per-group
 * cap exists to serve — is sixteen. The looseness is the point: this number is not meant to be the
 * limit anybody experiences, only the one nobody can walk past.
 *
 * COUNTED BY INTELLIGENCE, IN THE SAME TRANSACTION AS THE INSERT. The upload sends both numbers as
 * the file's `pendingLimits`; Intelligence counts this owner's pending files of this purpose, and of
 * this channel and batch, under a lock on that owner's pending files, and refuses with both counts
 * when either has reached its limit. Its pending-owner index is partial on pending files, so the
 * count scans this person's staged files and not their history — the same property the partial
 * `attachments_staged_idx` gave the count when it ran here.
 *
 * WHAT IT CAN COST AN HONEST PERSON, stated because a backstop that cannot be reached honestly is
 * not the same as one that cannot be reached awkwardly. Staged rows in a channel that was
 * soft-deleted, or that this person was removed from, cannot be withdrawn (`DELETE
 * /api/attachments/:id` checks live channels and membership), so they hold their place until they
 * expire — which is as long as this deployment's operator has configured, and for ever if they have
 * turned the sweep off. Thirty-two of those would refuse the next upload anywhere for
 * that whole time. That is the same shape of fault the per-channel cap used to have at EIGHT, which
 * is precisely why this sits four times higher, and why the refusal names the deployment rather than
 * a deadline it cannot promise.
 */
export const MAX_STAGED_ATTACHMENTS_PER_UPLOADER =
  4 * MAX_ATTACHMENTS_PER_MESSAGE;

/**
 * The longest group this route will count a row under.
 *
 * A real client sends `newId()`, which is a 36-character UUID, so nothing legitimate comes within
 * an order of magnitude of this. What the bound is really for is that a longer one FAILS rather
 * than merely wasting space. When the group was a column here it was the third column of a btree
 * index, and a group of 2600 bytes made the INSERT itself fail (measured: 2000 bytes stored fine and
 * 2600, 2700, 3000 and 8000 all raised), which the transaction's `.catch` turned into a 503. The
 * group is now the file's `batch` in Intelligence, which refuses one longer than this outright —
 * the upload would be refused just the same.
 *
 * 128 because that is the difference between a value a composer can plausibly have minted and one
 * nothing in this app produces, and it is the limit Intelligence keeps a batch to.
 */
const MAX_UPLOAD_GROUP_LENGTH = 128;

/**
 * Which composer session this upload belongs to, as the browser named it.
 *
 * The VALUE needs no validation and gets none: it is only ever compared for equality against other
 * files the SAME person staged in the SAME channel, and the worst a person
 * can do by choosing their own is give themselves a second bucket of eight — which two tabs already
 * do, below.
 *
 * The SHAPE is a different question, and the comment here used to conflate the two. A group that is
 * too long for {@link MAX_UPLOAD_GROUP_LENGTH}, or that carries a U+0000 — which Postgres refuses
 * in a `text` value at all, and Intelligence refuses in a batch — does not give its sender a second
 * bucket. It fails the one write the group ever appears in — the upload itself — so nothing is
 * written and the upload is refused outright, as a 503 the person can do nothing about. Both were
 * reproduced through this route against the local Postgres when the group was a column here.
 *
 * Neither is refused, though: both fall back to {@link LEGACY_UPLOAD_GROUP}, exactly as a request
 * that named no group at all does. A group is a client-side grouping hint, not something anybody
 * asked for, so a hint this server cannot store is a hint it can do without — and treating it as a
 * hard refusal would turn a stale or third-party client's cosmetic mistake into an upload it can
 * never complete, which is a worse answer than counting its files in the same bucket every
 * group-less upload already shares.
 */
function uploadGroupOf(formData: FormData): string {
  const value = formData.get("uploadGroup");
  if (typeof value !== "string") return LEGACY_UPLOAD_GROUP;
  if (value.length === 0 || value.length > MAX_UPLOAD_GROUP_LENGTH) {
    return LEGACY_UPLOAD_GROUP;
  }
  // A NUL is not a length problem and would survive the check above, so it is asked separately:
  // Intelligence refuses U+0000 in a batch outright, which would take down the upload itself — the
  // only write the group reaches.
  return value.includes("\u0000") ? LEGACY_UPLOAD_GROUP : value;
}

/**
 * The longest filename this route will store, in UTF-8 bytes.
 *
 * The fetch route echoes a stored name into `Content-Disposition` TWICE — once quoted, once
 * percent-encoded for `filename*` — and percent-encoding can triple a non-ASCII byte, so the header
 * runs to roughly four times the name. Nothing capped the name, and a multipart `filename`
 * parameter can be as long as the body allows: a 4000-character name was measured through these
 * two routes producing a 32 KB `Content-Disposition`. Bun serves that without complaint, but every
 * common reverse proxy caps response headers at 4-8 KB, so behind an ingress that attachment is not
 * a large download — it is a row nobody can ever fetch again, and no part of this app would say
 * why.
 *
 * 255 bytes because that is the limit almost every filesystem imposes, so it is the number a name
 * that came off somebody's disk has already been through. It holds the header under about 1 KB.
 *
 * TRUNCATED RATHER THAN REFUSED, and the extension is not preserved. A name is a property OF a file
 * somebody chose to send; refusing the file over it would be refusing content this app can read for
 * a reason that has nothing to do with the content. The stored name is what the 201 hands back, so
 * the composer shows what was actually kept rather than what was sent. Rebuilding a `.png` tail
 * onto the cut name was considered and dropped: it is more code and more edge cases (no dot, a dot
 * at the end, a 300-byte "extension") for a case that only arises with a name no filesystem would
 * have held in the first place.
 */
const MAX_FILENAME_BYTES = 255;

const utf8 = new TextEncoder();

/** A filename cut to {@link MAX_FILENAME_BYTES}, never through the middle of a character. */
function withinFilenameLimit(name: string): string {
  if (utf8.encode(name).length <= MAX_FILENAME_BYTES) return name;
  let kept = "";
  let bytes = 0;
  // Code points, not code units, so the cut cannot split a character into a lone surrogate — and
  // never more than 256 iterations, because it stops the moment the budget is spent.
  for (const character of name) {
    const size = utf8.encode(character).length;
    if (bytes + size > MAX_FILENAME_BYTES) break;
    bytes += size;
    kept += character;
  }
  return kept;
}

/**
 * The parenthetical that names a refused file's type, or nothing at all when there is nothing to
 * name.
 *
 * WHAT IS ASKED IS `namesNoFormat`, NOT WHETHER THE STRING IS EMPTY, and the difference is the
 * whole point. This started as an emptiness test, because `sniffMimeType` used to hand back the
 * claim itself when the bytes corroborated nothing — and the claim can be `""`, which this sentence
 * interpolated into `'archive' is not a file type this app can read ().` An empty parenthetical is
 * strictly worse than the generic sentence it was written to improve on, and the composer shows
 * this string verbatim, so it is the only explanation anybody gets.
 *
 * `sniffMimeType` no longer returns a claim that names nothing — it answers
 * `application/octet-stream` instead, which is the honest answer to "what are these bytes" and the
 * right contract for a sniffer. That silently defeated an emptiness test: the parenthetical came
 * back, now reading `(application/octet-stream)`, which names a string nobody chose and tells the
 * reader less than saying nothing would. Both changes are right; only asking the question the
 * shared list already answers composes them. A ninth thing that names no format gets added to
 * `MIME_NAMES_NOTHING` and this sentence keeps working.
 *
 * A BLANK CLAIM IS REACHED THROUGH THE FILENAME, not through the request. Measured against this
 * deployment's Bun: the multipart parser ignores a part's own `Content-Type` header entirely and
 * derives `File.type` from the filename's EXTENSION — `photo.png` declared `text/plain` arrives as
 * `image/png`, `drawing.svg` declared `text/plain` arrives as `image/svg+xml`, and a name with no
 * extension at all arrives as `""`. So this is not an exotic path: it is any file whose name has no
 * dot in it, and the bytes not being valid UTF-8 is the rest of it.
 */
function describeType(mimeType: string): string {
  return namesNoFormat(mimeType) ? "" : ` (${mimeType})`;
}

/**
 * A channel's upload door: one file in, one staged row out, or a reason it was refused.
 *
 * THE TRADE-OFF THE GROUPING MAKES, WRITTEN DOWN BECAUSE IT IS A REAL BEHAVIOUR CHANGE. The cap
 * counted every unsent row this person had in this channel; it now counts the ones staged by one
 * composer session. Two tabs open on the same channel are two sessions, so they get eight each
 * rather than eight between them. That is accepted deliberately: the cap is documented and enforced
 * as a PER-MESSAGE limit everywhere else (`MAX_ATTACHMENTS_PER_MESSAGE`, and the composer's own
 * screen), two tabs are two messages, and the alternative — the per-channel count — is what made a
 * closed tab's leftovers refuse a pick the client had already accepted, naming files nobody could
 * see. A cap that occasionally allows a second message's worth is a far smaller fault than one that
 * bricks uploads in a channel for 24 hours.
 *
 * THAT PARAGRAPH DESCRIBED HALF THE PICTURE UNTIL `MAX_STAGED_ATTACHMENTS_PER_UPLOADER` EXISTED.
 * "A second bucket of eight" is what a second TAB gets. It is not what a CALLER gets, because the
 * bucket is named by a form field this route does not validate: a fresh group on every request has
 * nothing in it to count, so the cap never fires, and the number of buckets is however many strings
 * the caller cares to type. Nothing else bounded staged bytes — the body limit is per request, and
 * the culler ran on a 24-hour window — so one authenticated member could stage without limit into
 * what was then the only table in this deployment that held blobs. Reproduced through this route before it
 * was closed, not argued from the code.
 *
 * SO THERE ARE TWO NUMBERS NOW, AND THEY ARE DIFFERENT KINDS OF NUMBER. The cap is the one the
 * composer knows, shows and is refused by, counted over a bucket the client names — because the set
 * on the screen is the only set the client can reason about. The backstop is counted over every
 * unsent row one person holds, in every channel and every group, because that is the only scope a
 * client cannot move. It sits four messages higher so that everything the paragraph above accepts —
 * two tabs, a closed tab's leftovers, a stopped run — still fits comfortably underneath it. The
 * trade survives; what it no longer does is run to infinity.
 *
 * The refusal is the point of this route as much as the upload is. `classifyAttachment` and
 * `sniffMimeType` between them already decide, byte-for-byte, whether a file is something a Bot can
 * read; this handler's job is to turn "no" into a sentence a person sees, naming what the file
 * actually was rather than "unsupported file type" — the composer surfaces the string verbatim, so
 * it is the only explanation anybody gets.
 *
 * Mounted at `/api/channels` by whoever wires the app together; this file only builds the router.
 */
export function createChannelAttachmentRoutes(
  database: Database,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: { stagedTtlHours?: number | null } = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  // Read once, when the routes are built: the operator's window, or none at all when the sweep is
  // switched off. See {@link stagedAttachmentTtlHours}.
  const stagedTtlHours =
    options.stagedTtlHours !== undefined
      ? options.stagedTtlHours
      : stagedAttachmentTtlHours(process.env);

  routes.post("/:channelId/attachments", requireUser, async (context) => {
    const actor = context.var.actor;
    const channelId = context.req.param("channelId");

    /*
     * The membership check: true only when this channel exists, is not soft-deleted, and this actor
     * has a membership row on it. False, for any of those three reasons, reads the same from here
     * on: a member of somebody else's channel learns nothing about whether it exists.
     *
     * NOT THE ONLY CHECK THE UPLOAD STANDS ON, though — this one only refuses early, before the file
     * is read off the wire. It is asked again after the file is stored, because a check up here and
     * a write down there are two steps with the whole of the upload between them.
     */
    const member = await canOpenChannel(database, actor.id, channelId)
      // Guarded like every other call on these routes, and this is the one that runs FIRST: without
      // it a database that cannot answer takes the door out before the body is even read, as a
      // plain-text 500 the composer can only report as "could not upload".
      .catch((error: unknown) => {
        console.error(
          `Could not check ${actor.id}'s membership of ${channelId} for an upload.`,
          error,
        );
        return null;
      });

    if (member === null) {
      return context.json(
        { error: "Couldn't upload that file. Try again." },
        503,
      );
    }

    if (!member) {
      return context.json({ error: "You're not in this conversation." }, 403);
    }

    /*
     * Every other body parse in this server is `.catch(() => null)` so a
     * malformed body reads as a refusal, not a crash. `formData()` throws
     * `ERR_FORMDATA_PARSE_ERROR` on a non-multipart body, and there is no
     * `app.onError` to catch it — left unguarded, that throw becomes a
     * plain-text 500 instead of the `{ error }` body the client reads off
     * every failure.
     */
    const formData = await context.req.formData().catch(() => null);
    if (!formData) {
      return context.json(
        { error: 'Send the file as multipart form data under a "file" field.' },
        400,
      );
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return context.json(
        { error: 'Attach a file under the "file" field.' },
        400,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = sniffMimeType(bytes, file.type);
    const kind = classifyAttachment(mimeType);

    // Bounded once, here, so the same name is what gets stored AND what every refusal below quotes
    // back: a sentence naming a file by a name the row does not carry would be its own small lie.
    const name = withinFilenameLimit(file.name);

    if (kind === "unsupported-image") {
      const error =
        mimeType === "image/svg+xml"
          ? `'${name}' can't be attached. SVG files aren't accepted.`
          : `'${name}' can't be attached. OpenBot can't read ${mimeType} images.`;
      return context.json({ error }, 415);
    }

    if (kind === "unsupported") {
      return context.json(
        {
          error: `'${name}' isn't a file type OpenBot can read${describeType(mimeType)}.`,
        },
        415,
      );
    }

    if (kind === "image" && bytes.byteLength > MAX_IMAGE_BYTES) {
      return context.json(
        {
          error: `'${name}' is larger than the ${megabytes(
            MAX_IMAGE_BYTES,
          )} limit for images.`,
        },
        413,
      );
    }

    if (kind === "text" && bytes.byteLength > MAX_FILE_BYTES) {
      return context.json(
        {
          error: `'${name}' is larger than the ${megabytes(
            MAX_FILE_BYTES,
          )} limit for files.`,
        },
        413,
      );
    }

    const uploadGroup = uploadGroupOf(formData);

    /*
     * THE COUNT AND THE STORE ARE ONE STEP, IN INTELLIGENCE.
     *
     * It used to be a count, a comparison, and then an insert. Two uploads in flight at once both
     * counted seven and both inserted, and the person held nine — the same time-of-check /
     * time-of-use hole `withEnabledCapLock` in routines/store.ts was written for, and this route is
     * the more reachable one: dropping eight files on the composer fires eight uploads in parallel
     * by design.
     *
     * So the two limits travel with the file as its `pendingLimits`, and Intelligence counts and
     * inserts in one transaction, serialised per owner — the same two halves this route used to hold
     * itself: the count folded into the write, so no file can be stored by a request whose count did
     * not permit it, and a lock that makes the count authoritative under READ COMMITTED, so the
     * second of two concurrent uploads counts after the first one's file is visible.
     *
     * THE LOCK IS THE UPLOADER, AND IT USED TO BE (channel, uploader, group). That was the right
     * scope while the group cap was the only thing being counted, and it is the wrong scope now:
     * `MAX_STAGED_ATTACHMENTS_PER_UPLOADER` is counted over everything one person has staged, so a
     * lock keyed on the group serialises the uploads that share a bucket and nothing else — which
     * is to say it serialises none of the uploads a client varying its group sends. Intelligence's
     * lock is the owner's pending files of the purpose, which covers both counts. Nobody else's
     * uploads wait on this person's.
     *
     * THE REFUSAL REPORTS THE COUNTS THAT REFUSED, because Intelligence answers with the numbers its
     * own decision was made on. This used to be an insert followed, on the refusal path, by a second
     * SELECT that counted the staged rows again, and a withdrawal committing between the two produced
     * "you already have 7 attachments waiting" while the cap is 8, and a composer dropping a whole
     * queued message produced 0. The insert was right to refuse both times; only the sentence was
     * wrong, and a sentence that contradicts the refusal is worse than no number.
     *
     * A staged file carries an expiry: the window the operator configured for the staged sweep, from
     * now. A send commits it and clears the expiry; a file nobody sends is gone when it passes.
     */
    const upload = await filesClient()
      .create(
        {
          purpose: ATTACHMENT_PURPOSE,
          ownerUserId: actor.id,
          collection: channelId,
          batch: uploadGroup,
          name,
          contentType: mimeType,
          committed: false,
          expiresAt:
            stagedTtlHours === null
              ? null
              : new Date(Date.now() + stagedTtlHours * 60 * 60 * 1000),
          pendingLimits: {
            perBatch: MAX_ATTACHMENTS_PER_MESSAGE,
            perOwner: MAX_STAGED_ATTACHMENTS_PER_UPLOADER,
          },
        },
        bytes,
        filesIdempotencyKey("attachment"),
      )
      .then(({ file }) => ({ stored: file }) as const)
      .catch((error: unknown) => {
        if (error instanceof PendingLimitError) {
          return {
            batchPending: error.batchPending,
            ownerPending: error.ownerPending,
          } as const;
        }
        /*
         * EVERY OTHER FAILURE ON THIS ROUTE ANSWERS `{ error }`, AND SO DOES THIS ONE.
         *
         * The `formData()` call above is wrapped for exactly this reason — there is no
         * `app.onError` anywhere behind this router, so an unguarded throw is Hono's default
         * plain-text `Internal Server Error`. The composer reads `{ error }` off every failed upload
         * and falls back to a generic `Could not upload "<name>"` when the body will not parse as
         * JSON, so a lost connection during a rollout, a timeout, or a store that refused the bytes
         * would all be the same unactionable sentence, with nothing written to the log either.
         *
         * LOGGED WITH WHAT IT WOULD TAKE TO ACT ON IT — who, which channel, and how big the file was
         * — because these are operator faults rather than uploader mistakes, and the one refusal
         * whose cause lives on this side of the wire is the one nobody could otherwise see.
         *
         * 503 rather than 500: every failure in that list is a "the store is not able to take this
         * right now" and is worth retrying, which is what the sentence tells the person to do.
         */
        console.error(
          `Could not store an attachment for ${actor.id} in ${channelId} (${mimeType}, ${bytes.byteLength} bytes).`,
          error,
        );
        return { unavailable: true } as const;
      });

    if ("unavailable" in upload) {
      return context.json(
        { error: "Couldn't upload that file. Try again." },
        503,
      );
    }

    if ("stored" in upload) {
      /*
       * THE MEMBERSHIP IS ASKED AGAIN, AFTER THE FILE IS STORED, against a slower race. The handler
       * checks membership at the top and stores on the strength of what it read — with
       * `await file.arrayBuffer()`, the sniff, the classification and the store in between, so the
       * window is as wide as reading an upload off the wire, not as wide as a scheduler tick. A
       * removal landing in it would put a file into a channel its uploader had just been taken out
       * of. When the insert lived beside the channel tables it selected its row FROM the
       * membership join; the file now lives in Intelligence, which cannot see that join, so the
       * question is asked again once the file exists and the file is taken back out if the answer
       * changed. A removal that lands after this check is a removal of somebody whose upload had
       * already finished, which is what it would have been before.
       */
      const stillMember = await canOpenChannel(
        database,
        actor.id,
        channelId,
      ).catch((error: unknown) => {
        console.error(
          `Could not recheck ${actor.id}'s membership of ${channelId} after an upload.`,
          error,
        );
        return null;
      });
      if (stillMember !== true) {
        await filesClient()
          .delete(upload.stored.id, filesIdempotencyKey("attachment-withdraw"))
          .catch((error: unknown) => {
            // Left pending, it expires with every other staged file; nothing reads it meanwhile,
            // because every read checks the same membership.
            console.error(
              `Could not take back attachment ${upload.stored.id} from ${channelId} after ${actor.id} left it.`,
              error,
            );
          });
        // The same sentence and the same status as the check at the top of the handler, because
        // from the uploader's side it is the same refusal — it just became true later than that
        // check ran. A database that could not answer is the 503 it is everywhere else here.
        return stillMember === false
          ? context.json({ error: "You're not in this conversation." }, 403)
          : context.json(
              { error: "Couldn't upload that file. Try again." },
              503,
            );
      }
      return context.json(
        {
          id: upload.stored.id,
          name: upload.stored.name,
          mimeType: upload.stored.contentType,
          sizeBytes: upload.stored.sizeBytes,
        },
        201,
      );
    }

    /*
     * Where both limits refused, the per-message cap is answered first, because it is the one that
     * can be acted on: it is the limit the composer already shows, counted over the files on the
     * screen in front of the person. Being told about everything they hold everywhere, while this
     * composer sits at eight, sends them hunting through other channels for a problem that is on
     * this one. The backstop's sentence is only ever the answer when the cap would have let this
     * file through.
     *
     * NOT "IN THIS CHANNEL", WHICH IS THE COUNT THIS SERVER STOPPED COMPUTING.
     *
     * The cap is counted per composer session now — that is what `upload_group` is for, and the
     * header comment above explains why — so a person with a full tab A and an empty tab B was
     * being told about a channel total nobody computes, and sent hunting for files that are on
     * another screen. That is the exact confusion the grouping was introduced to end.
     *
     * The limit is named beside the count because the limit is the actionable half: the count says
     * what is true now, and `MAX_ATTACHMENTS_PER_MESSAGE` says what to do about it. The count can
     * no longer be below the limit — the decision that refused is the one that counted — so
     * the two can never contradict each other in the same sentence.
     */
    if (upload.batchPending >= MAX_ATTACHMENTS_PER_MESSAGE) {
      return context.json(
        {
          error: `You can attach ${MAX_ATTACHMENTS_PER_MESSAGE} files to a message, and ${upload.batchPending} are already waiting to send.`,
        },
        409,
      );
    }

    /*
     * THE BACKSTOP'S REFUSAL, AND IT DELIBERATELY DOES NOT SOUND LIKE THE CAP'S.
     *
     * Nobody reaching this has filled the composer in front of them — the branch above would have
     * answered if they had. They are holding four messages' worth of unsent files somewhere, and
     * the sentence has to say so, or this is the 409 nobody could act on all over again: "you can
     * attach 8 files to a message", said to a composer holding one, is an instruction to go looking
     * for seven files that are not there.
     *
     * NAMES THE SCOPE AND THE WAY OUT. "Across your channels" because the files need not be in this
     * one, and sending or removing because those are the two things a person can do to clear a row.
     *
     * AND IT NAMES THE SWEEP WITHOUT PROMISING A SCHEDULE, WHICH IS A CORRECTION. Some of these rows
     * cannot be withdrawn at all — a channel that was soft-deleted, or one this person was removed
     * from, still holds their staged rows and `DELETE /api/attachments/:id` will not take them — so a
     * sentence offering only "remove some" would be asking for something impossible, and the sentence
     * has to say what becomes of those. It used to say they are "cleared within a day", which this
     * server is in no position to promise: `attachments.culler.olderThanHours` is the operator's to
     * set, and `attachments.culler.enabled: false` is a documented way to keep every staged row for
     * ever (charts/openbot/README.md). A deployment that has done either is one where this sentence
     * was simply a lie, told to the one person who could not act on it. What is true whatever the
     * chart says is that those rows are the deployment's to clear and not this person's, and that is
     * what it says now.
     *
     * The count comes from the decision that refused, exactly as the cap's does, so the number and
     * the decision cannot contradict each other.
     */
    return context.json(
      {
        error: `You have ${upload.ownerPending} files waiting to send across your conversations, which is the limit. Send or remove some first. Files in a conversation you can't open anymore have to be cleared by an admin.`,
      },
      409,
    );
  });

  return routes;
}

/**
 * Replaces every character that cannot legally appear in a header value with `_`.
 *
 * RFC 9110 allows visible ASCII, SP, HTAB and obs-text (%x80-FF) in a field value and nothing
 * else: the C0 controls and DEL are not representable there at all. Two of them, CR and LF, are
 * the header-injection pair, and for a long time they were the only two this file took out. The
 * rest are just as fatal, only more quietly. Bun's serializer throws on a NUL, and it throws from
 * inside `c.body` after the response has already begun, with no `app.onError` behind this router
 * to turn that into anything — so one such name is a 500 on EVERY fetch of that attachment rather
 * than a served file. The ones Bun does pass through (0x01-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F) are
 * still illegal on the wire, arrive mangled at the client, and entitle any proxy in between to
 * reject or re-parse the whole header over one byte.
 *
 * A NUL cannot reach a stored name today — Intelligence refuses U+0000 in a file's name — but the
 * name is whatever the uploader's browser called the file, and header-safety is this function's job to guarantee rather than a column type three
 * files away's to imply.
 *
 * HTAB goes too, and the list above says it is legal. Both are true: a tab is legal in a field
 * VALUE and meaningless in a FILENAME, where it would only ever arrive as an accident of whatever
 * produced the name and read back as ragged whitespace. The predicate below takes the whole C0
 * range rather than carving one character out of it for no gain.
 *
 * `_` rather than deletion, matching `foldToLatin1` below: the substitution shows up in the
 * downloaded filename, where deletion would silently join whatever sat on either side.
 */
function withoutControlCharacters(name: string): string {
  return Array.from(name)
    .map((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f ? "_" : char;
    })
    .join("");
}

/**
 * Escapes a stored filename for the quoted `filename` parameter of `Content-Disposition`.
 *
 * The name came from whatever the uploader's browser called the file, so it can contain a quote
 * or a backslash, either of which would end the `filename="..."` value early or splice in
 * attacker-controlled header syntax. Neither survives here, and nothing that could not appear in
 * a header value at all survives `withoutControlCharacters` above.
 */
function escapeFilename(name: string): string {
  return withoutControlCharacters(name)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

/**
 * Folds a filename down to Latin-1 for the quoted `filename` parameter.
 *
 * Bun's header serializer throws on any value carrying a code unit above U+00FF, and it throws
 * from inside `c.body` after headers have already started being written — there is no
 * `app.onError` behind this router to turn that into a response, so an uploader who legitimately
 * named their file `メモ.txt` or `笔记.md` would 500 the whole handler. Folding those code points
 * to `_` here keeps the quoted parameter header-safe for every client; `filename*` below is what
 * carries the real name back intact, for the clients that read it.
 */
function foldToLatin1(name: string): string {
  return Array.from(name)
    .map((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint > 0xff ? "_" : char;
    })
    .join("");
}

/**
 * Percent-encodes a filename for the RFC 5987 `filename*` parameter (`encodeURIComponent` leaves
 * `'`, `(`, `)` and `*` unescaped, none of which are legal in `attr-char`).
 */
function encodeRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds the `filename="..."; filename*=UTF-8''...` pair for a `Content-Disposition` value: an
 * ASCII-folded fallback every client can parse, plus the exact name for the clients that support
 * the extended form.
 *
 * Exported only so a test can reach the NUL case, which no route can: Intelligence will not store
 * a U+0000 in a file's name, so calling this directly is the one way to show it never hands
 * the serializer a byte that would throw.
 */
export function contentDispositionFilename(name: string): string {
  // Both parameters are built from the SAME neutralised name, so the fallback and the extended
  // form can never disagree about what the file is called. `encodeRfc5987ValueChars` would
  // otherwise percent-encode a control character into something a header can legally carry
  // (`%0B`) and hand the client back a name it should never have been offered.
  const safe = withoutControlCharacters(name);
  const quoted = foldToLatin1(escapeFilename(safe));
  const extended = encodeRfc5987ValueChars(safe);
  return `filename="${quoted}"; filename*=UTF-8''${extended}`;
}

/**
 * What `GET /api/attachments/:id` says about caching, on the 200 and on the 304 alike so the two
 * cannot drift.
 *
 * `private` because these are somebody's own files: no proxy and no CDN in between may hold a copy
 * that a different person could be served.
 *
 * `no-cache` — WHICH IS NOT `no-store`. The browser still keeps its copy; it just may not use that
 * copy without asking here first. This replaced `max-age=3600`, and the hour was not a small
 * mistake: deleting an attachment makes this route answer 404, and the browser never asked, so an
 * `<img>` already on the page went on painting the file from its own cache at full natural width
 * for the rest of the hour and the "this attachment is unavailable" path could not be reached at
 * all. The same hour kept bytes readable after a sign-out and after a removal from the channel.
 *
 * WHAT IS TRADED AWAY IS A ROUND TRIP, and knowingly. Every fetch now costs a request to this
 * server even when nothing has changed, where before one in an hour did. The ETag below buys back
 * the expensive half — a revalidation that still holds is a 304 with no body — but the request
 * itself, and the row lookup behind it, are the price of the property being bought: not freshness
 * of CONTENT, which cannot change for a given id, but freshness of EXISTENCE and of entitlement,
 * re-decided against this actor's membership on every single fetch.
 */
const ATTACHMENT_CACHE_CONTROL = "private, no-cache";

/**
 * Whether an `If-None-Match` header says the client already holds this exact representation.
 *
 * Weak comparison, as RFC 9110 requires for `If-None-Match`: `W/"x"` and `"x"` are a match, and so
 * is a list containing either. `*` matches whenever any representation exists at all, which by the
 * time this is asked it does.
 *
 * A header nobody sent is not a match, which is the ordinary first fetch.
 */
function ifNoneMatchHolds(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some(
      (candidate) =>
        candidate === "*" || candidate.replace(/^W\//, "") === etag,
    );
}

/**
 * The headers a stored attachment is served under — by `GET` and by `HEAD` alike, from one place,
 * because a probe that disagreed with the fetch about the type or the disposition would be worse
 * than no probe at all.
 */
function attachmentHeaders(
  row: { name: string; mimeType: string },
  etag: string,
): Record<string, string> {
  const kind = classifyAttachment(row.mimeType);
  return {
    // The type this server sniffed from the bytes at upload time, never the client's original
    // claim — that claim is exactly what this header exists to override, so trusting it here
    // would undo the sniff.
    "Content-Type": row.mimeType,
    // Without this, a browser that decides it knows better than the declared type will sniff
    // the bytes itself, which is how a "text" file with HTML in it becomes a page rendered on
    // this app's own origin instead of the download or plain text it was declared to be.
    "X-Content-Type-Options": "nosniff",
    // Only an image opens inline. Everything else — including a stray file whose sniffed type
    // is not one of the accepted image formats — downloads instead, because inline is exactly
    // what would let script-carrying content (the SVG case refused at upload) run if it ever
    // reached this endpoint another way.
    "Content-Disposition":
      kind === "image"
        ? "inline"
        : `attachment; ${contentDispositionFilename(row.name)}`,
    // What may be reused, and on what terms: see {@link ATTACHMENT_CACHE_CONTROL}. The short of
    // it is that a stored copy may be kept but not used without asking here again, so a deletion
    // or a removal from the channel is seen on the next fetch rather than up to an hour later.
    "Cache-Control": ATTACHMENT_CACHE_CONTROL,
    // Paired with that: the ask is cheap, because a client that still holds this id's bytes gets
    // a 304 instead of them.
    ETag: etag,
  };
}

type AttachmentContext = Context<{ Variables: AppVariables }>;

/**
 * "No such attachment", said the one way, by every read on `GET /api/attachments/:id` and by the
 * withdrawal below.
 *
 * A FUNCTION RATHER THAN FOUR LITERALS, because this sentence is the whole of what an outsider is
 * told and its value is that it never varies. `visibleAttachment` returns no file for four
 * different reasons — no such id, a channel since deleted, not a member of it, a colleague's staged
 * draft — and the uuid-shape guards answer a fifth before any query runs. If any one of those ever
 * came back phrased differently, or with a different status, the difference would be exactly the bit
 * of information the uniform 404 exists to withhold.
 */
function noSuchAttachment(context: AttachmentContext) {
  return context.json({ error: "No such attachment." }, 404);
}

/**
 * What `GET /api/attachments/:id` says when the store could not be asked — the fetch, the probe and
 * the revalidation alike.
 *
 * THE PROBE ANSWERS THIS BY CALLING THIS, WHICH IT DID NOT USED TO. `HEAD` had its own
 * `context.body(null, 503)` beside a comment claiming its refusals were "the GET's, exactly". They
 * were not: Hono answers a HEAD by dispatching the GET handler and re-wrapping the response as
 * `new Response(null, <it>)`, so the headers survive even though the body does not — and a
 * `context.body(null, ...)` sets no `Content-Type` where `context.json` sets `application/json`.
 * Reproduced against an unreachable database: GET gave `503 application/json`, HEAD gave `503` with
 * no `Content-Type` at all. That is a probe answering a question the fetch would not, which is the
 * one thing the two are not allowed to do. There is now no second spelling to drift from.
 */
function couldNotReadAttachment(context: AttachmentContext) {
  return context.json(
    { error: "Couldn't open that attachment. Try again." },
    503,
  );
}

/**
 * The attachment `GET /api/attachments/:id` may answer about, for the fetch, the probe and the
 * revalidation alike: null when there is none this actor may see.
 *
 * THE ANSWER IS THE ACCESS CHECK. A file comes back only when this attachment exists, the channel
 * it was uploaded into has not been deleted, and this actor has a membership row on that channel.
 * No file, for any of those reasons, is a 404 rather than a 403: a 403 would mean "yes, that id
 * exists, but it is not yours", which is a free bit of information for somebody probing ids for
 * attachments they cannot see. 404 is the same answer for "no such attachment", "the channel is
 * gone" and "not yours", so guessing ids learns nothing either way.
 *
 * The channel's deletion is part of the check beside the membership, and not only the membership,
 * because channels soft-delete: the channel row and every membership on it outlive the deletion, so
 * a membership-only test says yes for ever and the bytes stay downloadable — and inlinable — after
 * the channel they belong to is gone.
 *
 * AND A STAGED FILE IS ITS UPLOADER'S ALONE. Membership is what lets people see each other's SENT
 * files; a pending file has been shared with nobody, so a colleague's half-composed draft is not a
 * channel's to read. Reaching one needs its v4 uuid, which only the uploader's own 201 ever carried,
 * so this is a boundary rather than a leak anybody has — but it is the boundary the write side
 * already assumes, and the read side used not to keep.
 *
 * On the ordinary send that costs nothing: the commit is made before the message is persisted, so
 * by the time another member's browser can name the id the file is no longer staged. What it does
 * change is the turns that fail before the commit — a Bot that is no longer registered, a run that
 * throws mid-inline — where the message is persisted anyway and the file stays staged until it
 * expires. Their attachments read "unavailable" to everybody but the sender rather than being served
 * out of a draft nobody sent. That is the more honest answer of the two, and the underlying leak — a
 * persisted message whose files were never committed — is a copilot.ts fault worth fixing on its
 * own.
 *
 * ONE DECISION FOR ALL THREE READS, which is what lets them differ in nothing but what they send.
 * The fetch wants the bytes, the probe wants the size, and a revalidation wants nothing at all —
 * and when each of them carried its own copy of the rule, a rule added to one and not the others
 * turned `HEAD` into a way to learn that an id exists, or that a colleague has a draft, which the
 * uniform 404 exists to hide. Stated once, there is no second copy to leave behind.
 *
 * Throws when Intelligence or this deployment's database cannot answer; see {@link readOrNull}.
 */
async function visibleAttachment(
  database: Database,
  actorId: string,
  id: string,
): Promise<StoredFile | null> {
  const file = await attachmentFile(id);
  if (!file || !sentOrOwn(file, actorId)) return null;
  return (await canOpenChannel(database, actorId, file.collection))
    ? file
    : null;
}

/**
 * What a read on this route came back with, or null when the store could not be asked.
 *
 * A STORE THAT COULD NOT ANSWER IS NOT AN ANSWER OF "NO" — Intelligence or this deployment's
 * database alike — and on this route the difference
 * matters more than anywhere else in this file. 404 here is load-bearing in the client: the
 * transcript treats it as "this attachment is gone" and paints the unavailable tile in its place,
 * and {@link ATTACHMENT_CACHE_CONTROL} is `no-cache`, so it asks again on every paint. Answering a
 * lost connection with 404 would tell every member that a file which is still there has been
 * withdrawn. A null file is the real "no such attachment", and that alone is the 404.
 *
 * There is no `app.onError` behind this router, so the alternative to catching here is Hono's
 * plain-text default, which the client cannot read as `{ error }` and which leaves no server-side
 * trace of a fault that is this side's to fix. One log line for all three reads, naming the row and
 * the asker, because that is what it would take to act on it.
 */
async function readOrNull<T>(
  read: PromiseLike<T>,
  actorId: string,
  id: string,
): Promise<{ value: T } | null> {
  try {
    return { value: await read };
  } catch (error) {
    console.error(`Could not read attachment ${id} for ${actorId}.`, error);
    return null;
  }
}

/**
 * An attachment's own door: fetch its bytes back, or take it off the shelf before it is sent.
 *
 * Both routes below start from the same join as `createChannelAttachmentRoutes` above — a channel
 * that has not been deleted, and the actor's membership on it — because an attachment is only ever
 * visible to the channel it was uploaded into, sender and recipients alike, and only for as long as
 * that channel is.
 *
 * Mounted at `/api/attachments` by whoever wires the app together; this file only builds the
 * router.
 */
export function createAttachmentRoutes(
  database: Database,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:id", requireUser, async (context) => {
    const actor = context.var.actor;
    const id = context.req.param("id");

    // Attachment ids are UUIDs: an id that cannot possibly be one gets the same answer as one that
    // just isn't a match, so the "404 hides both reasons" design this route relies on for security
    // holds for malformed ids too.
    if (!isUuidShaped(id)) {
      return noSuchAttachment(context);
    }

    /*
     * THE VALIDATOR IS KNOWN BEFORE THE FILE IS, AND THAT IS WHAT MAKES A 304 CHEAP.
     *
     * An attachment's bytes never change once stored, so a given id names one exact representation
     * for as long as it names anything. A strong ETag of the id therefore needs no digest of the
     * file to compute: whether the client's `If-None-Match` still holds is decidable HERE, before
     * the file's bytes are asked for.
     *
     * It used to be asked after the bytes were read, so every revalidation read the whole file out
     * of the store in order to send an empty body — measured through this route against an 8 MiB
     * attachment, 12 runs each side: 8,388,608 bytes read and 25.09ms median per 304 before, 0 bytes
     * and 0.65ms after. The bytes now come from Intelligence, which makes not asking for them matter
     * more, not less.
     *
     * NOR IS IT A CORNER. {@link ATTACHMENT_CACHE_CONTROL} is `private, no-cache` deliberately, so
     * EVERY image paint in every viewing member's transcript revalidates here — the 304 is the
     * common path on this route, not the rare one.
     *
     * WHAT IS NOT GIVEN UP IS THE AUTHORISATION. The question a conditional request answers on this
     * route is not "have the bytes changed" — they cannot — but "is this still there and still
     * yours", so a 304 is still earned by the same channel-and-membership decision a 200 is.
     * Somebody removed from the channel gets 404 on their next revalidation, not 304. Only the
     * bytes left the question; the decision did not.
     *
     * AND IT IS ASKED AHEAD OF THE `HEAD` BRANCH, so the probe gets the same saving and the same
     * answer from the same lines. A revalidating HEAD and a revalidating GET differ in nothing but
     * the body Hono strips, which is what "the probe answers exactly what the fetch would" is
     * supposed to mean.
     */
    const etag = `"${id}"`;
    const visible = await readOrNull(
      visibleAttachment(database, actor.id, id),
      actor.id,
      id,
    );
    if (visible === null) return couldNotReadAttachment(context);
    const file = visible.value;
    if (!file) return noSuchAttachment(context);

    if (ifNoneMatchHolds(context.req.header("If-None-Match"), etag)) {
      return context.body(null, 304, {
        ETag: etag,
        "Cache-Control": ATTACHMENT_CACHE_CONTROL,
      });
    }

    /*
     * A PROBE THAT DOES NOT READ THE FILE, AND WHY IT IS A BRANCH RATHER THAN A ROUTE.
     *
     * Hono intercepts HEAD before routing and re-dispatches it as a GET, returning
     * `new Response(null, <the GET's response>)` (hono-base.js, `#dispatch`). A
     * `routes.on("HEAD", ...)` handler is therefore never reached — that was written first and
     * verified not to run — so the only place that can answer a HEAD cheaply is here, in the
     * handler Hono actually calls. The REQUEST object is passed through untouched, which is why
     * the method is still readable at this point.
     *
     * It is worth answering cheaply. The transcript probes every document tile it draws with
     * `HEAD /api/attachments/<id>`, from every viewing member's browser, and
     * {@link ATTACHMENT_CACHE_CONTROL} is `no-cache`, so each probe used to re-read a file nobody
     * was going to be sent — measured: a HEAD of an 8 MiB attachment came back 200 with an empty
     * body, having read all 8 MiB.
     *
     * Same access decision and the same headers — the file's size in place of its bytes, and
     * `Content-Length` set by hand because a body-less response has nothing to derive it from and
     * the size is the thing a probe is usually asking for. The refusals have to be indistinguishable
     * from the fetch's, or a probe becomes a way to learn something a fetch would not tell you, so
     * they are not repeated here at all: {@link visibleAttachment} makes the decision above, and
     * {@link noSuchAttachment} and {@link couldNotReadAttachment} phrase both of its refusals, for
     * this branch and the fetch below alike. `attachment-routes.test.ts` still asserts that case by
     * case rather than leaving it to this comment.
     */
    if (context.req.method === "HEAD") {
      return context.body(null, 200, {
        ...attachmentHeaders(
          { name: file.name, mimeType: file.contentType },
          etag,
        ),
        "Content-Length": String(file.sizeBytes),
      });
    }

    /*
     * The only read on this route that is going to send a body, and so the only one that asks for
     * the bytes. A file withdrawn or expired between the decision above and this read is the same
     * "no such attachment" it would have been a moment later.
     */
    const bytes = await readOrNull(filesClient().content(id), actor.id, id);
    if (bytes === null) return couldNotReadAttachment(context);
    if (!bytes.value) return noSuchAttachment(context);

    /*
     * A VIEW OVER THE BUFFER, NEVER `Uint8Array.from` OVER IT.
     *
     * A `Buffer` is both array-like and iterable, and `%TypedArray%.from` prefers the ITERATOR, so
     * it walks the file one element at a time on the single JS thread: 8.4 million steps for a file
     * at `MAX_IMAGE_BYTES`. Measured on this repo's Bun 1.4 over an 8 MiB buffer: `Uint8Array.from`
     * 62-87ms, this view 0.0004ms. That cost lands where it hurts most: every image paint
     * revalidates, so a transcript with a handful of large images would stall the event loop — for
     * every other person's request on this process too — on every scroll-back.
     *
     * The offset and the length are both passed, rather than `new Uint8Array(buffer.buffer)`,
     * because a `Buffer` need not own the whole of its `ArrayBuffer`: Node pools small allocations,
     * so a short file can arrive as a window into a larger block. Dropping the offset would serve
     * whatever else shares that block. The bytes are not copied, which is safe because nothing here
     * or downstream writes through this view. The cast narrows `ArrayBufferLike` to `ArrayBuffer`,
     * which is a type-level narrowing with no run-time step.
     */
    const body = new Uint8Array(
      bytes.value.buffer as ArrayBuffer,
      bytes.value.byteOffset,
      bytes.value.byteLength,
    );

    return context.body(
      body,
      200,
      attachmentHeaders({ name: file.name, mimeType: file.contentType }, etag),
    );
  });

  routes.delete("/:id", requireUser, async (context) => {
    const actor = context.var.actor;
    const id = context.req.param("id");

    // Same uuid-shape guard, and the same sentence, as the GET route above.
    if (!isUuidShaped(id)) {
      return noSuchAttachment(context);
    }

    /*
     * THE WHOLE DECISION IS THE DELETE, and that is what makes the refusal below mean anything.
     *
     * This route used to read whether the file was sent, decide on what it read, and then delete by
     * id alone. Those are two steps with a gap between them, and the send that commits the file is
     * the third party that fits in it: commit the file after the read and before the delete, and the
     * file goes out from under a message that already claims it, leaving the transcript pointing at
     * nothing. The window is not theoretical — it is the sender's own turn racing their own
     * composer, which still offers the file for withdrawal until the send is recorded.
     *
     * The delete is conditional on the VERSION that was read, and a commit raises the version. So
     * the file Intelligence deletes is exactly the staged file this route decided on: a send that
     * landed in between makes the delete a 412, nothing is deleted, and the route reads again and
     * answers the 409 below. There is no moment at which a sent attachment is deletable.
     *
     * The uploader, for the reason it was there before. Membership only ever gated visibility, and a
     * sent attachment is refused below regardless of who asks; what membership-only scoping still
     * allowed was a member deleting a colleague's *unsent* draft, which does real damage — the
     * colleague's composer keeps pointing at a now-missing file, and their send fails later when
     * nothing can resolve it. A non-uploader gets the same 404 as a non-member.
     *
     * A LIVE CHANNEL AND MEMBERSHIP ON IT, because "is a member of this live channel" is an
     * access-control boundary, and the case dropping it would open — somebody removed from a channel
     * withdrawing their own still-unsent draft — is low-harm enough that letting it through would be
     * a boundary loosened for no reason at all. The channel's deletion is in the check beside the
     * membership, because channels soft-delete: a membership row outlives its channel's deletion, so
     * a membership-only test kept saying yes and this route kept acting inside a channel nobody can
     * open. Same scope as the fetch route above and as the upload route.
     *
     * NOTHING WAS WITHDRAWN, AND ONLY THEN IS IT WORTH ASKING WHY — 404 or 409 is a question about
     * how to answer, not about what to do. The same 404-hides-every-reason answer as the GET route
     * above: no file, whether because there is no such attachment, because its channel has been
     * deleted, because the actor is not in that channel, or because somebody else uploaded it, reads
     * identically from here. A 403 would mean "yes, that id exists, but it is not yours", which is a
     * free bit of information for anybody probing ids. And a file that is the actor's, in a live
     * channel they are in, and sent, is the 409: once an attachment rides in a sent message, it is
     * part of that message's record.
     */
    const withdrawal = await withdraw(database, actor.id, id).catch(
      (error: unknown) => {
        // As on the two routes above, and here the mistaken answer would be the worst of the three:
        // an unguarded throw is a plain-text 500, and the composer's only other reading of a failed
        // withdrawal is that the file is still staged. Say that the store could not be reached.
        console.error(
          `Could not withdraw attachment ${id} for ${actor.id}.`,
          error,
        );
        return "unavailable" as const;
      },
    );

    if (withdrawal === "unavailable") {
      return context.json(
        {
          error: "Couldn't remove that attachment. Try again.",
        },
        503,
      );
    }
    if (withdrawal === "withdrawn") return context.body(null, 204);
    if (withdrawal === "missing") return noSuchAttachment(context);

    // Once an attachment rides in a sent message, it is part of that message's record: pulling it
    // out from under a message that already claims it would leave the message pointing at nothing.
    // A staged attachment has made no such promise yet, so only that one may still be withdrawn —
    // and the conditional delete is the only thing that decides whether it still is one.
    return context.json(
      { error: "This attachment is already part of a sent message." },
      409,
    );
  });

  return routes;
}

/**
 * Withdraws one staged attachment of the actor's, or says why not.
 *
 * Reads the file, decides, and deletes on the version it read. A 412 means the file changed in
 * between — a send committed it, most likely — so the decision is made again on what is there now.
 * Nothing else changes a staged attachment, so the second read settles it; the bound is only so a
 * file that kept changing could never hold a request open.
 */
async function withdraw(
  database: Database,
  actorId: string,
  id: string,
): Promise<"withdrawn" | "missing" | "sent"> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = await attachmentFile(id);
    if (
      !file ||
      file.ownerUserId !== actorId ||
      !(await canOpenChannel(database, actorId, file.collection))
    ) {
      return "missing";
    }
    if (file.committedAt !== null) return "sent";
    try {
      const deleted = await filesClient().delete(
        id,
        filesIdempotencyKey("attachment-withdraw"),
        file.version,
      );
      return deleted === "deleted" ? "withdrawn" : "missing";
    } catch (error) {
      if (!(error instanceof FileVersionConflictError)) throw error;
    }
  }
  throw new Error(
    `Attachment ${id} kept changing while it was being withdrawn.`,
  );
}

/**
 * The environment variable that sets how long a staged attachment is kept, in hours: the window
 * `attachments.culler.olderThanHours` configures in the chart. `off` keeps staged attachments until
 * they are sent or withdrawn (`attachments.culler.enabled: false`).
 */
export const STAGED_ATTACHMENT_TTL_ENV = "OPENBOT_STAGED_ATTACHMENT_TTL_HOURS";

/** The window a staged attachment is kept for when nothing says otherwise: a day. */
export const DEFAULT_STAGED_ATTACHMENT_TTL_HOURS = 24;

/**
 * How long a staged attachment is kept before it expires, in hours, or null to keep it until it is
 * sent or withdrawn.
 *
 * WHAT USED TO BE THE SWEEP'S WINDOW. A staged attachment used to sit in this deployment's own table
 * until the culler CronJob deleted the ones older than `attachments.culler.olderThanHours`. It is
 * now a pending file in Intelligence, which removes a file the moment its `expiresAt` passes, so the
 * same window is stamped on each staged file when it is uploaded — the operator's number, the same
 * default, the same "off". A fraction is a fraction of an hour, as it was for the sweep.
 *
 * A value that is not a positive number of hours and not `off` stops the server at boot rather than
 * picking a window nobody chose: this deletes files a person picked and has not sent yet.
 */
export function stagedAttachmentTtlHours(
  environment: Record<string, string | undefined>,
): number | null {
  const raw = environment[STAGED_ATTACHMENT_TTL_ENV]?.trim();
  if (!raw) return DEFAULT_STAGED_ATTACHMENT_TTL_HOURS;
  if (["off", "false", "never"].includes(raw.toLowerCase())) return null;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      `${STAGED_ATTACHMENT_TTL_ENV} must be a positive number of hours, or "off" to keep staged attachments until they are sent or removed; got ${JSON.stringify(raw)}.`,
    );
  }
  return hours;
}
