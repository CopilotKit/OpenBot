import {
  type Attachment,
  type AttachmentsConfig,
  useAttachments,
} from "@copilotkit/react-core/v2";
import {
  IconArrowUp,
  IconPlayerStopFilled,
  IconPlus,
} from "@tabler/icons-react";
import { PromptArea, type PromptAreaHandle } from "prompt-area";
import {
  isSegmentsEmpty,
  mergeAdjacentTextSegments,
  type Segment,
  text,
} from "prompt-area/helpers";
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { attachmentModality } from "@/components/channels/chat-messages";
import {
  attachmentUrl,
  classifyAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  mediaTypeOf,
  shouldClaimPaste,
} from "@/lib/channels/attachments";
import { newId } from "@/lib/new-id";
import { cn } from "@/lib/utils";
import { Button } from "../../ui/button";
import {
  attachmentsConfigFor,
  FILE_PICKER_ACCEPT,
  stagedRowId,
} from "./attachments";
import {
  applyCommandChips,
  canSendDraft,
  type CommandOption,
  type ComposerDraft,
  enforceSingleAgent,
  toDraft,
} from "./draft";
import { screenPickedFiles } from "./picked-files";
import { AttachmentStrip } from "./attachment-strip";
import { type RejectedFile, RejectedFiles } from "./rejected-files";
import { PLACEHOLDER_COMMANDS } from "./sources";
import { type AgentOption, buildTriggers } from "./triggers";

/**
 * The SDK's upload failure, derived rather than imported for the reason `attachments.ts` records
 * against the same derivation: `@copilotkit/shared` declares `AttachmentUploadError` and is not a
 * dependency of `app/`, so the only public spelling of this shape is the config it is passed to.
 */
type UploadFailure = Parameters<
  NonNullable<AttachmentsConfig["onUploadFailed"]>
>[0];

/**
 * WHY A STAGED ATTACHMENT LEFT THE COMPOSER WITHOUT BEING SENT.
 *
 * Two different things push files down this channel and they want different words. The composer
 * used to build ONE sentence for both — "dropped when queued messages were merged into one: a
 * message can carry at most 8" — which was true of the first and false of the second: nothing is
 * merged when somebody removes a parked message, and no cap is hit. Telling them about a limit they
 * never reached is worse than saying nothing, because it sends them looking for a limit to work
 * around.
 *
 * `reduceQueue` reports the same `Attachment[]` either way, so the cause cannot be recovered from
 * the files. It is read off the queue ACTION instead, by `conversation-view.tsx`, which is the one
 * place that has both halves in hand.
 */
export type DroppedAttachmentCause =
  /** Several parked messages became one turn, and the joined message overran the per-message cap. */
  | "merged-over-cap"
  /** A parked message was taken back out of the queue, and it was carrying these. */
  | "queued-message-removed";

export type DroppedAttachments = {
  cause: DroppedAttachmentCause;
  attachments: readonly Attachment[];
};

/**
 * WHAT A STAGED ATTACHMENT ACTUALLY IS, rather than what the browser called it when it was picked
 * up. See the `images` memo for the whole account, and `attachmentModality` in `chat-messages.ts`
 * for the rule itself — the send path and the parked tiles ask this same question the same way, and
 * a second copy of the rule here would be a second thing to get wrong.
 *
 * A one-line function rather than an inline expression because BOTH halves of the strip call it and
 * they are complements: `images` keeps what this calls an image and `files` keeps everything else,
 * so the two must never be able to drift into disagreeing about one attachment.
 */
function stagedModality(attachment: Attachment) {
  const { source } = attachment;
  // Only a `url` source has been past the server, which sniffed the bytes. A `data` source's
  // `mimeType` is `file.type`: the same claim, not a second opinion on it.
  const corroborated =
    source.type === "url" && source.mimeType ? source.mimeType : undefined;
  return attachmentModality(attachment.type, corroborated);
}

const MAX_HEIGHT_PX = 220;
/**
 * Tracks the compact `text-sm` line box so PromptArea stays vertically centered in one row.
 */
const COMPACT_MIN_HEIGHT_PX = 19;
const COMPACT_MAX_HEIGHT_PX = 96;

export type ComposerProps = {
  className?: string;
  /**
   * Classes for the editor itself rather than the frame. `className` styles the box — border,
   * background, width; the type inside it is PromptArea's, so changing it (a hero composer's
   * `text-lg`) goes through here, where tailwind-merge lets it beat the built-in `text-sm`.
   */
  editorClassName?: string;
  compact?: boolean;
  /** Agents that `@` can address. Empty means the mention menu reports an empty channel. */
  agents?: readonly AgentOption[];
  commands?: readonly CommandOption[];
  /**
   * Receives the whole draft rather than a string, so a mention or a command reaches the caller as
   * structured data instead of something it would have to re-parse out of the text.
   */
  onSubmit?: (draft: ComposerDraft) => void | Promise<void>;
  /**
   * Park this message until the turn in flight is over, instead of refusing the keystroke.
   *
   * Its presence is what lets a person type at a Bot that is already working. Without it the
   * composer goes on refusing mid-turn sends, which is still the right answer for a screen that has
   * nowhere to put a parked message — the compose screen creates the channel on send and then
   * navigates away, so anything parked there would be dropped on unmount, and a message that
   * silently disappears is worse than a send button that visibly will not go.
   *
   * Called instead of `onSubmit`, not as well as it, and it does not return a promise: parking is
   * a state change, and awaiting one would hold the composer's send lock for the length of somebody
   * else's turn and block the next correction.
   */
  onQueue?: (draft: ComposerDraft) => void;
  /** Stop the Bot mid-answer; while pending, the send button becomes a stop button. */
  onStop?: () => void;
  /**
   * The conversation cannot take another message at all, which is a property of the conversation
   * rather than of the moment: a channel whose coworker was deleted. This is the only thing that
   * stops a person typing.
   */
  disabled?: boolean;
  /**
   * A turn is in flight. It gates sending, not writing: a channel is `pending` while it is still
   * connecting and restoring its history, and the composer is on screen throughout.
   */
  pending?: boolean;
  /**
   * Put the caret in the editor the first moment it can take one, and then leave it alone. For the
   * screens where typing is the next thing a person does — choosing a coworker answers the "to"
   * field, and the message is what remains.
   *
   * Once, not on every change: it used to re-claim the caret whenever the editor became interactive
   * again, so a person who had clicked into something else — a search box, another channel's row —
   * had the cursor yanked back the moment a turn finished. A send of their own still returns the
   * caret, because that one they asked for.
   */
  autoFocus?: boolean;
  /**
   * The channel a picked file is uploaded to, and the one switch for the whole attachment feature.
   *
   * WITH NO `channelId` THIS COMPOSER BEHAVES EXACTLY AS IT DID BEFORE ATTACHMENTS EXISTED, which
   * is what keeps `/channel/new`, the home screen and the onboarding poster working untouched. No
   * config reaches `useAttachments`, so it installs no paste listener at all; the form takes no
   * drag handlers, no file input is rendered, and the `+` button goes on saying it has nothing to
   * offer. That is the right answer rather than a degraded one for a screen with nowhere to put an
   * upload: the compose screen creates its channel on send, so a file staged there would belong to
   * a channel that does not exist yet.
   */
  channelId?: string;
  /**
   * There is a run on the wire for Stop to reach.
   *
   * Not the same question as `pending`, and telling them apart is the whole reason this exists. A
   * turn is in flight from the moment somebody presses send; the run it becomes does not exist
   * until the caller has waited for whatever it has to wait for, which on a channel that is still
   * joining is up to a second and a half. A Stop button drawn in that window aborts a controller
   * nobody has made yet: the press is swallowed, the message goes anyway, and the one control the
   * whole affordance leans on has quietly lied.
   *
   * Defaults to `pending`, which is the right answer for a caller with no gap between the two.
   */
  stoppable?: boolean;
  initialValue?: string;
  /**
   * Files a caller's queue left behind, and WHY, reported so they read as a refusal rather than
   * vanishing.
   *
   * Two causes reach here and they are not interchangeable — see `DroppedAttachments` above.
   * Joining several parked messages into one drained turn can overflow
   * `MAX_ATTACHMENTS_PER_MESSAGE` in a way no per-draft check ever saw coming (see `reduceQueue`'s
   * `droppedAttachments` in `queue.ts`), and removing a parked message takes whatever it was
   * carrying with it. Either way those files are still staged server-side, so saying nothing is not
   * neutral: it is a person finding out from a 409 on their next upload, with nothing connecting
   * that refusal to the files that silently disappeared.
   *
   * A FRESH OBJECT EACH TIME SOMETHING IS DROPPED is what this relies on — see the effect below.
   * The caller builds one per event, which it has to do anyway to say which cause it was.
   */
  droppedAttachments?: DroppedAttachments;
  /**
   * HOW MANY ATTACHMENTS ARE SITTING IN THE CALLER'S QUEUE, BECAUSE THE SERVER IS STILL COUNTING
   * THEM AND THIS COMPOSER CANNOT SEE THEM.
   *
   * Parking a message takes its chips off the strip — the queue owns them now — but nothing about
   * the rows behind them changes: `attachedAt` is written only when the message is really sent, so
   * they stay `attached_at IS NULL` in this composer's `uploadGroup` for the whole life of the
   * in-flight turn, and the server's upload cap counts exactly that set. The strip is empty,
   * `screenPickedFiles` is told `alreadyStaged: 0`, the pick is accepted, the upload round-trips,
   * and the server answers 409 for a file the client had already said yes to. Park eight files
   * during a turn — or three messages carrying three each — and the next one is refused.
   *
   * A per-draft cap that ignores the queue cannot agree with a per-group cap that does not, so the
   * one number the client screens against has to include both halves.
   *
   * NOT THE CLOSED-TAB LOCKOUT, and worth saying so because the sentence is the same: parked files
   * are drawn in the transcript, come back if the message is taken out of the queue, and their rows
   * are stamped the moment the turn drains. The cost is a refusal that should have been instant and
   * in our words arriving after a round trip in the server's.
   *
   * The count rather than the attachments, because that is all the screen needs and the queue's
   * shape is the caller's business. `conversation-view.tsx` owns the queue and is the only thing
   * that can sum this; a caller with no queue leaves it out and nothing changes.
   */
  queuedAttachmentCount?: number;
};

/**
 * One sentence per cause, and they say different things because different things happened.
 *
 * A merge names the cap, because that is the limit the person can work around — send fewer at once.
 * A removal names the removal and nothing else: there is no limit to explain, and inventing one
 * would send somebody hunting for a rule they never hit.
 */
const DROPPED_REASON: Record<DroppedAttachmentCause, string> = {
  "merged-over-cap":
    "dropped when queued messages were merged into one: a " +
    `message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} ` +
    "attachments.",
  "queued-message-removed":
    "removed along with the queued message it was attached to.",
};

/**
 * WHAT A FILE DROPPED ON A COMPOSER THAT CANNOT TAKE IT IS TOLD, AND WHY IT IS TOLD ANYTHING.
 *
 * Catching the drop (see `refuseDragOver`/`refuseDrop` below) is what stops the browser from
 * navigating the app away, and that alone would be a fix. It would also be a file that vanished:
 * the person aimed a screenshot at the one box on the screen that takes screenshots, let go, and
 * got nothing back — no chip, no error, no cursor change that outlasts the gesture. That is the
 * exact failure `rejected` exists to end for every other door into this composer, and a drop is
 * not a lesser door than the `+` button.
 *
 * TWO SENTENCES, BECAUSE THE TWO REFUSALS ARE NOT THE SAME REFUSAL. One is a "not yet" with a next
 * step the person can take immediately; the other is a "not here, ever". Sharing one string
 * between them would either promise a send that will never work or hide the send that will.
 *
 * NEITHER NAMES A CAUSE THIS COMPONENT CANNOT SEE. `disabled` is a plain boolean prop —
 * `channel-chat.tsx` passes `!channel.active` and its own notice says the coworker was deleted,
 * but that is the CALLER'S knowledge, and a composer that repeated it would be guessing on behalf
 * of every future caller that disables it for some other reason. So this says only what is true of
 * all of them: nothing can be sent from here, so nothing can be attached to it either.
 *
 * The filename is not repeated inside the reason — `RejectedFiles` renders `<name>: <reason>` —
 * matching `DROPPED_REASON` above rather than `picked-files.ts`, whose strings quote the name a
 * second time.
 */
const UNACCEPTED_DROP_REASON = {
  "cannot-send":
    "was not attached: this conversation can no longer take messages.",
  "no-conversation":
    "was not attached: there is no conversation here yet. Send this " +
    "message first, then attach to the one it opens.",
} as const;

export function Composer({
  className,
  editorClassName,
  compact = false,
  agents = [],
  commands = PLACEHOLDER_COMMANDS,
  onSubmit,
  onQueue,
  onStop,
  disabled = false,
  pending = false,
  autoFocus = false,
  channelId,
  stoppable,
  initialValue,
  droppedAttachments,
  // Nothing parked is the right answer for every caller without a queue, which is most of them.
  queuedAttachmentCount = 0,
}: ComposerProps) {
  const [value, setValue] = useState<Segment[]>(
    initialValue ? [{ type: "text", text: initialValue }] : [],
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  const promptAreaRef = useRef<PromptAreaHandle>(null);
  /**
   * The composer's outer element, and the reason the hook's own `containerRef` is left on the
   * floor.
   *
   * `useAttachments` scopes its `document` paste listener with exactly this test — is the event's
   * target inside the element holding my ref — so an unheld ref is a listener that returns on
   * every paste. That is the point. This composer deliberately does its own paste handling (see
   * the listener below for why), and while ours claimed every paste carrying a file the SDK's
   * never got a look in. It does now, on the pastes we decline, and it does not decline them: a
   * spreadsheet cell was staged TWICE, once by us and once by it, and a Word paste that we
   * correctly let through as text had its picture attached anyway. Holding the ref ourselves is
   * what makes this composer the only thing in the app that decides what a paste means.
   */
  const containerRef = useRef<HTMLDivElement>(null);
  /** A send has completed and the caret is owed back, as soon as the editor will take it. */
  const wantsFocus = useRef(false);
  /** `autoFocus` has been honoured once, and is not owed again for the life of this composer. */
  const claimedAutoFocus = useRef(false);
  /**
   * EVERY REFUSAL THIS COMPOSER HAS EVER MADE, BECAUSE NOTHING ELSE REMEMBERS THEM.
   *
   * An `Attachment` has no error state and the hook has no retry: a failed upload removes the
   * placeholder from the strip and calls `onUploadFailed` exactly once, so a refusal that is not
   * kept here is a file that vanished from the composer with nothing said about it. Our own
   * pre-check adds to the same list, so the two sources of "no" read as one list of reasons.
   */
  const [rejected, setRejected] = useState<RejectedFile[]>([]);

  const dismissRejections = useCallback(() => setRejected([]), []);

  /**
   * `newId()` rather than `crypto.randomUUID()`, for the reason `uploadGroup` below sets out at
   * length: the function is ABSENT outside a secure context, so on a deployment served over plain
   * `http://<address>` this throws rather than returning something worse.
   *
   * The throw would land in the worst possible place. This is the SDK's `onUploadFailed`, called
   * from inside `processFiles` — so the report of a failed upload would itself fail, the file
   * would leave the strip the way a failed upload always does, and the sentence explaining it
   * would never arrive. Every upload refusal in the app comes through here.
   */
  const recordRejection = useCallback((failure: UploadFailure) => {
    setRejected((current) => [
      ...current,
      {
        id: newId(),
        name: failure.file.name,
        reason: failure.message,
      },
    ]);
  }, []);

  /**
   * THIS COMPOSER'S UPLOAD GROUP: one key, minted once, sent with every upload it makes.
   *
   * The per-message cap has two enforcers, and before this they counted different sets. The client
   * counts what is on its own screen; the server counted every unsent row this person had in this
   * channel. They agree only while nothing has been left behind — and a closed tab, a stopped run
   * or a removed queued message leaves exactly that. The client would then accept a pick the server
   * refused with a 409 naming files nobody could see, and eight orphans locked uploads in that
   * channel until the sweeper's 24-hour window expired. Grouping the rows by the composer that
   * staged them is what makes both sides count the same set.
   *
   * NOT A DRAFT ID. Nothing about the message is saved anywhere by this, and nothing survives a
   * reload: a remount mints a new key and the rows the old one staged become somebody else's
   * problem, which is to say the sweeper's.
   *
   * `newId()` rather than `crypto.randomUUID()`, which does not exist outside a secure context —
   * on a deployment reached at plain `http://<address>` the call is not merely wrong, it throws,
   * and the throw here would abort the whole screening pass rather than fail one upload. See
   * `lib/new-id.ts`.
   *
   * Lazy `useState` rather than `useRef(newId())`, whose argument would be evaluated on every
   * render to be thrown away — cheap, but it would also mean the id nobody keeps is minted
   * hundreds of times per composer.
   */
  const [uploadGroup] = useState(newId);

  /**
   * EVERY SERVER ROW THIS COMPOSER HAS CREATED AND NOT YET ACCOUNTED FOR.
   *
   * A row leaves this set exactly one of two ways: a message takes ownership of it
   * (`releaseStagedRows`, on send and on queue), or the reconciler below finds it has no chip left
   * and gives it back to the server. Anything still in here is a row whose fate is undecided.
   *
   * A ref rather than state: nothing on screen is drawn from it, and a set that re-rendered the
   * composer on every upload would invalidate all four attachment memos for no visible reason.
   */
  const uploadedRows = useRef<Set<string>>(new Set());

  const recordUpload = useCallback((attachmentId: string) => {
    uploadedRows.current.add(attachmentId);
  }, []);

  /**
   * These rows belong to a message now, not to this composer, so it must stop offering to delete
   * them. Called before the chips are taken off, on both paths where a draft carries its
   * attachments away — the send that became a message, and the parked message the queue now owns.
   *
   * Getting this wrong in the other direction is the expensive one: leave a row in the set and the
   * reconciler will notice the chip has gone and DELETE an attachment that has just been sent, or
   * that a queued message is still waiting to send.
   */
  const releaseStagedRows = useCallback((released: readonly Attachment[]) => {
    for (const attachment of released) {
      const rowId = stagedRowId(attachment);
      if (rowId !== undefined) {
        uploadedRows.current.delete(rowId);
      }
    }
  }, []);

  const attachmentsConfig = useMemo(
    () =>
      channelId
        ? attachmentsConfigFor(
            channelId,
            uploadGroup,
            recordRejection,
            recordUpload,
          )
        : undefined,
    [channelId, uploadGroup, recordRejection, recordUpload],
  );

  /**
   * The queue just left these behind, and they need the same rejection treatment a pick-time
   * refusal gets — see `droppedAttachments` above for why staying quiet is not an option.
   *
   * Keyed on the object itself rather than on something derived from it, because the caller is
   * expected to hand over a fresh one only when a new drop actually happened; an empty one on
   * mount, or between drops, runs this once for nothing and then not again until the next real
   * drop.
   */
  useEffect(() => {
    if (!droppedAttachments || droppedAttachments.attachments.length === 0) {
      return;
    }
    const reason = DROPPED_REASON[droppedAttachments.cause];
    setRejected((current) => [
      ...current,
      ...droppedAttachments.attachments.map((attachment) => ({
        // `newId()` again, and this is the least survivable of the three sites: an effect body
        // that throws propagates out of React's commit, so on a deployment served over plain
        // `http://` a queue drop would answer by tearing down the tree that was about to explain
        // it — a blank conversation instead of a list of the files it just lost.
        id: newId(),
        name: attachment.filename ?? "Attachment",
        reason,
      })),
    ]);
  }, [droppedAttachments]);

  /**
   * Called unconditionally, with a config only when there is a channel to upload to. The hook
   * reads no React context — it is state, refs and one `document` paste listener that it does not
   * install while disabled — so an undefined config is a hook that does nothing, not a hook that
   * throws.
   */
  const {
    attachments,
    enabled: attachmentsEnabled,
    fileInputRef,
    processFiles,
    handleDragOver,
    handleDragLeave,
    removeAttachment,
  } = useAttachments({ config: attachmentsConfig });

  /**
   * THERE IS A CHANNEL TO UPLOAD TO **AND** THIS CONVERSATION CAN STILL TAKE A MESSAGE.
   *
   * `disabled` used to gate sending and nothing else, so every one of the three doors — the drop,
   * the paste, and the `+` button with its input — went on accepting files for a channel whose
   * coworker has been deleted. Each one becomes a row staged server-side that counts against that
   * channel's cap and waits for the sweeper, attached to a message the screen has already said can
   * never be sent, with nothing connecting the two.
   *
   * Every door reads this rather than `attachmentsEnabled`, and `stageFiles` re-asks it besides:
   * `onImagePaste` is PromptArea's call and not ours, so the choke point has to answer for itself.
   */
  const canAttach = attachmentsEnabled && !disabled;

  /**
   * THE ATTACHMENTS A SEND IN FLIGHT IS ALREADY CARRYING, HIDDEN FOR THE LENGTH OF THE RUN.
   *
   * `onSubmit` does not resolve until the whole run does, so between the press and the answer a
   * screenshot was on screen twice — once in the transcript and once still in the strip — and
   * `canSendDraft` unlocks on attachments alone, so the text box being empty did not disable
   * anything: one more press queued the identical attachment ids into a second message. That
   * duplicate is what this exists to close.
   *
   * THE OTHER WAY TO CLOSE IT, AND WHY NOT IT. Calling `consumeAttachments()` optimistically
   * alongside `setValue([])` is three lines and loses the strip whenever a send fails. This file
   * will not make that trade: a failed send already puts the words back, and files that vanished
   * from the composer at the same moment would be exactly the thing it never does quietly — the
   * whole `RejectedFiles` apparatus above exists because a file that disappears with nothing said
   * about it is the worst outcome here, and these ones are still staged server-side, so nothing on
   * screen would connect them to the 409 they later cause. So the send takes a snapshot of the ids
   * instead, they are hidden while it runs, and the catch hands them straight back with the words.
   *
   * State rather than a ref, because `images`, `files` and `draft` are memos keyed on the
   * attachments: a ref would not invalidate them, and the chips would sit there for the whole run,
   * which is the bug itself.
   */
  const [sending, setSending] = useState<readonly string[]>([]);

  /**
   * What is on the composer right now: everything staged, less whatever a send in flight already
   * took. Every reader goes through this — the per-message cap, both halves of the strip, and the
   * draft both buttons are enabled from — so there is no path left on which an attachment that has
   * already been sent can be counted, drawn, or sent again.
   */
  const staged = useMemo(
    () => attachments.filter((attachment) => !sending.includes(attachment.id)),
    [attachments, sending],
  );

  /**
   * Take a chip off the strip. That is all this does, and the row it stood for is deliberately
   * somebody else's problem — `reconcileStagedRows` below.
   *
   * IT USED TO DELETE THE ROW ITSELF, AND COULD ONLY EVER DO HALF THE JOB. It read the id off the
   * attachment, so it worked for a `ready` chip and did nothing at all for one whose upload was
   * still in flight — there is no id on that one yet. The comment said the in-flight case was the
   * sweeper's and treated it as harmless. It is not: `uploadGroup` is minted once per composer and
   * lives for the whole mount, so the row that lands a moment later is counted by the server
   * against THIS composer, while the chip it belonged to is gone from the strip. The screen counts
   * seven, the server counts eight, and the next pick comes back 409 naming a file nobody can see —
   * verbatim the failure `uploadGroup` was introduced to remove, reached through a Remove button
   * instead of through a closed tab.
   *
   * Splitting the answer across two functions is what left the gap, so there is one function now,
   * and it is the one that can see both halves.
   */
  const discardAttachment = useCallback(
    // Unconditional: the person asked for the chip to be gone, and nothing here is allowed to make
    // that wait on a round trip.
    (id: string) => removeAttachment(id),
    [removeAttachment],
  );

  /**
   * GIVE BACK EVERY ROW THAT NO LONGER HAS A CHIP — THE ONE PLACE THAT DECIDES THIS.
   *
   * A row this composer uploaded is either on the strip, or owned by a message, or nobody's. The
   * third is the leak, and it has two sources that used to be handled differently and one of them
   * not at all: a `ready` chip removed by hand, and a chip removed while its upload was still in
   * the air. Reconciling what was uploaded against what is drawn catches both without having to
   * know which happened.
   *
   * WHY IT CANNOT BE DONE AT THE MOMENT OF THE REMOVAL, WHICH IS THE OBVIOUS PLACE. `onUpload` is
   * handed a `File` and nothing else; the SDK mints the placeholder id itself and never says which
   * placeholder a given call belongs to. So at the moment somebody removes an uploading chip there
   * is no id to record, and when the upload lands there is no way to ask whether the chip it
   * belonged to is the one that went. Absence is the only signal that survives that, and it is a
   * complete one.
   *
   * WAITING FOR NOTHING TO BE UPLOADING IS THE WHOLE OF THE SAFETY. Between `onUpload` returning an
   * id and the SDK writing it onto its placeholder there is a window in which the row is known and
   * not yet drawn, and deleting there would destroy a live attachment. While that window is open
   * the placeholder is still `uploading` in committed state, so this gate closes exactly over it.
   * The gate is read off `attachments` rather than off the `staging` ref next to `stagedCount`
   * deliberately: a ref is not a render, so a ref-gated pass could skip the last commit and never
   * be woken again — a stale count self-corrects on the next commit, an un-deleted row does not.
   *
   * `attachments` and not `staged`: a send in flight only HIDES its attachments, and they are still
   * the composer's until the send becomes a message.
   */
  useEffect(() => {
    if (uploadedRows.current.size === 0) {
      return;
    }
    if (attachments.some((attachment) => attachment.status === "uploading")) {
      return;
    }
    const drawn = new Set<string>();
    for (const attachment of attachments) {
      const rowId = stagedRowId(attachment);
      if (rowId !== undefined) {
        drawn.add(rowId);
      }
    }
    for (const rowId of uploadedRows.current) {
      if (drawn.has(rowId)) {
        // Still on the strip. Left in the set on purpose: it may yet be removed, and this is the
        // only thing watching for that.
        continue;
      }
      uploadedRows.current.delete(rowId);
      discardStagedAttachment(rowId);
    }
  }, [attachments]);

  /**
   * How many attachments the next screen must count, including any this tick has already accepted.
   *
   * `staged.length` is a number captured at render, and `stageFiles` is async, so two gestures in
   * one tick — two drops in a row, or a drop landing on a paste — both read the same stale count
   * and both accept a full cap's worth. Five files and five more went out as ten uploads against a
   * cap of eight, and the server refused the surplus: a 409 the person had been given no chance to
   * avoid, which is the exact failure this whole change exists to remove.
   *
   * A ref, because the correction has to be visible to the second caller in the SAME tick, and no
   * state update is.
   */
  const stagedCount = useRef(0);

  /**
   * How many accepted files are between `stageFiles` and their placeholders.
   *
   * This exists only to say when `stagedCount` may be resynced, and it is not optional: the hook
   * adds placeholders ONE AT A TIME, so mid-flight `staged.length` is a number that is still
   * climbing. Resyncing from it there would hand the reservation straight back — the first version
   * of this did, and the second gesture screened against 1 instead of 5.
   */
  const staging = useRef(0);

  /*
   * Every commit, and cheap: whenever nothing is in flight, the hook's own count is the truth, and
   * that is how a removal, a send taking its attachments off, or a file the SDK refused after we
   * accepted it all get back into the number. No dependency array on purpose — the condition that
   * matters is a ref, which no dependency list can watch.
   */
  useEffect(() => {
    if (staging.current === 0) {
      stagedCount.current = staged.length;
    }
  });

  /**
   * The one way a file gets from a person's hands into the upload queue.
   *
   * SCREENING HAPPENS HERE, BEFORE `processFiles`, AND THAT ORDER IS THE WHOLE POINT. The SDK
   * enforces `accept` and `maxSize` itself and phrases its refusals for a machine — `File
   * "logo.svg" is not accepted. Supported types: image/png,…` — where `screenPickedFiles` writes a
   * sentence naming the file and the limit it hit. Anything this refuses never reaches the SDK, so
   * a refused file produces exactly one reason, in our words.
   */
  const stageFiles = useCallback(
    async (picked: readonly File[]) => {
      // The last gate, and the only one `onImagePaste` passes: PromptArea decides on its own when
      // to hand an image over, so a door we do not own still arrives here.
      if (disabled) {
        return;
      }
      const screened = screenPickedFiles(picked, {
        // What is on the composer, not what the hook is holding: an attachment riding on a send
        // in flight belongs to that message's count, not to the one being built now.
        //
        // PLUS WHAT IS PARKED, which is on nobody's strip and is still counted by the server —
        // see `queuedAttachmentCount`. Without the second half the client accepts a pick the
        // server then refuses with a 409 the person was given no chance to avoid.
        alreadyStaged: stagedCount.current + queuedAttachmentCount,
      });
      if (screened.rejected.length > 0) {
        setRejected((current) => [...current, ...screened.rejected]);
      }
      if (screened.accepted.length === 0) {
        return;
      }
      // Both bumps happen BEFORE the await, so a second gesture in this same tick screens against
      // a number that already includes these.
      stagedCount.current += screened.accepted.length;
      staging.current += screened.accepted.length;
      try {
        await processFiles(screened.accepted.map(withMediaTypeOnly));
      } finally {
        staging.current -= screened.accepted.length;
      }
    },
    [disabled, processFiles, queuedAttachmentCount],
  );

  /**
   * The image half of a paste that our own listener let through.
   *
   * `PromptArea` has its own rule for a clipboard carrying BOTH text and an image: if the
   * `text/html` is Microsoft Office markup it inserts the TEXT and ignores the image, because a
   * copied Excel cell or Word block is text that happens to ship a picture of itself. Anything else
   * it treats as an image, calls this, and RETURNS — having already called `preventDefault` and
   * inserted nothing.
   *
   * WHICH SOURCES LAND WHERE, SAID PLAINLY, BECAUSE THE SECOND GROUP IS NOT COVERED. Word and Excel
   * write Office markup, so their text is typed. Google Sheets and Numbers do not, so they take the
   * second branch: this prop attaches their image and THEIR TEXT IS NOT TYPED. Having the prop is
   * still strictly better than not having it — without it that same paste calls nothing at all, so
   * there is no text AND no attachment, which is the failure our own listener was written to avoid
   * — but it does not make the spreadsheet case right, and this does not claim it does. See
   * `shouldClaimPaste` in `shared/attachments.ts` for the rule and for why it is being kept.
   *
   * Routing it into `stageFiles` means the file arrives by the same door as the picker and the
   * drop, so it is screened, capped and refused in the same words.
   *
   * EVERY BRANCH BELOW HAS TO PASS IT, WHICH IS THE WHOLE OF THIS PROP'S CORRECTNESS. It went on
   * the compact one alone for a while, and the full-size branch — the shape the home screen draws
   * — swallowed exactly this paste in silence. `composer-paste.test.tsx` renders that branch for
   * no other reason.
   */
  const stagePastedImage = useCallback(
    (file: File) => {
      void stageFiles([file]);
    },
    [stageFiles],
  );

  /**
   * THE THIRD DOOR, SHUT — AND SHUT AHEAD OF THE SDK'S OWN.
   *
   * `useAttachments` installs a bubble-phase `document` paste listener that pre-filters the
   * clipboard with the same exact `file.type === filter` comparison `withMediaTypeOnly` exists to
   * survive, and then calls `processFiles` directly. A pasted `text/plain;charset=utf-8` file —
   * which is what a browser reports for some clipboard entries — fails that comparison, and the
   * listener then returns having uploaded nothing, said nothing and called no `onUploadFailed`.
   * Silent. Paste also skipped the per-message cap and `MAX_FILE_BYTES`, which our screen enforces
   * and the SDK's does not.
   *
   * So this one listens in the CAPTURE phase, which runs before the hook's, and `stopPropagation`
   * on a paste we claim means the hook's listener never runs at all. What we claim goes through
   * `stageFiles`, the same path the `+` button and the drop already take, so screening, the cap and
   * the wording of a refusal are identical whichever way the file arrived.
   *
   * `shouldClaimPaste` decides whether the paste is ours: text wins whenever the clipboard carries
   * any, and a file is ours only when there is none. Copying a cell from a spreadsheet puts BOTH an
   * image and text on the clipboard, and claiming that paste attached a screenshot of the cell and
   * typed nothing.
   *
   * DECLINING IS NOT THE SAME AS THE TEXT BEING TYPED. What a declined paste does next is
   * PromptArea's rule, and it types the text only when the `text/html` is Microsoft Office markup.
   * So Word and Excel are handled; Google Sheets and Numbers are not — their image is attached
   * through `stagePastedImage` below and their text is lost. That is a known defect being kept for
   * now, and it is written out in full on `shouldClaimPaste` in `shared/attachments.ts`.
   */
  useEffect(() => {
    if (!canAttach) {
      return;
    }
    const handlePaste = (event: ClipboardEvent) => {
      // The hook's own containment gate, kept exactly: several composers can be mounted at once,
      // and a paste into a search box is nobody's attachment.
      const target = event.target as Node | null;
      if (!target || !containerRef.current?.contains(target)) {
        return;
      }
      const clipboard = event.clipboardData;
      if (!clipboard) {
        return;
      }
      const files = Array.from(clipboard.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      const claimed = shouldClaimPaste({
        kinds: files.map((file) => classifyAttachment(file.type)),
        plainText: clipboard.getData("text/plain"),
      });
      if (!claimed) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void stageFiles(files);
    };
    document.addEventListener("paste", handlePaste, true);
    return () => document.removeEventListener("paste", handlePaste, true);
  }, [canAttach, stageFiles]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      /*
       * The hook's `dragOver` flag, put back down.
       *
       * NOTHING DRAWS IT TODAY, AND THIS IS STILL NOT DEAD CODE. `useAttachments` keeps a
       * `dragOver` boolean that its own chat components render a highlight from; this composer
       * does not destructure it and no border or overlay anywhere in `app/src` changes while a
       * file hovers. The comment that used to sit here said a missed drag-leave "would leave the
       * composer looking like a file is still hovering over it", which was describing a highlight
       * that does not exist — a reader chasing that sentence finds nothing.
       *
       * The call stays because the flag is the hook's, not ours: leaving it stuck at `true` after
       * a drop would hand a trap to whoever wires the highlight up, and they would have no reason
       * to suspect the drop path. It costs one function call per drop.
       */
      handleDragLeave(event);
      void stageFiles(Array.from(event.dataTransfer.files));
    },
    [handleDragLeave, stageFiles],
  );

  /**
   * THE DROP THIS COMPOSER CANNOT ACCEPT, CAUGHT ANYWAY — BECAUSE "NOT A DROP TARGET" IS NOT THE
   * SAME THING AS "IGNORES DROPS", AND THE DIFFERENCE IS THE WHOLE APP.
   *
   * An element becomes a drop target only when something calls `preventDefault` on its `dragover`.
   * With no handler at all — which is what `dropZone` used to spread whenever `canAttach` was
   * false — the composer is not a target, `drop` never fires on it, and the browser performs ITS
   * default for a file dropped on a document: it NAVIGATES THE TOP-LEVEL DOCUMENT TO THAT FILE.
   *
   * The comment this replaces called those "drag handlers it would only ignore". Ignoring is the
   * one thing that does not happen. The single-page app unloads and everything held in memory goes
   * with it: the sentence being typed on `/channel/new`, and on a `disabled` channel the entire
   * parked queue — whose own teardown effect in `conversation-view.tsx` never gets to run, because
   * the document is being REPLACED rather than unmounted, so the rows behind those parked messages
   * stay orphaned until the 24-hour sweep. The person sees their raw PNG on a blank page and
   * presses Back.
   *
   * ALWAYS INSTALLED; ONLY THE ACCEPTANCE IS CONDITIONAL. The states that reach here are the three
   * the `channelId` docblock names — `/channel/new`, the home screen, the onboarding poster — plus
   * every channel whose composer is `disabled`.
   *
   * THE APP-WIDE GUARD NOW EXISTS, AND THIS IS STILL NOT REDUNDANT. `useUnclaimedDropGuard` in
   * `routes/__root.tsx` refuses any drop nobody claimed, which covers the transcript, the sidebar,
   * the page margin and the onboarding poster's `pointer-events-none` composer — every surface a
   * leaf could never reach. It deliberately stands down the moment an event is already
   * `defaultPrevented`, because that is the browser's own signal that something in the tree owns
   * the drop. So the two do not fight, and they do different jobs: the root one can only refuse
   * silently, since it has no idea what the person was aiming at. This one KNOWS, and names the
   * file and the reason in `RejectedFiles`. Deleting it would turn a sentence into silence on the
   * one surface people actually aim files at.
   */
  const refuseDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    /*
     * `dropEffect = "none"` SO THE CURSOR TELLS THE TRUTH BEFORE THE PERSON LETS GO.
     *
     * `preventDefault` alone leaves the effect at its default, which draws the same copy-badge
     * cursor the working composer draws — so the guard would advertise an acceptance it is about
     * to refuse, and the refusal would then read as a bug rather than as an answer. "none" draws
     * the no-entry cursor and changes nothing else: the element is still a drop target, `drop`
     * still fires on it, and the browser still never gets the file.
     */
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
  }, []);

  const refuseDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // FIRST, AND UNCONDITIONALLY. Everything below this line is the explanation; this line is
      // the fix, and no branch of the explanation may be able to skip it.
      event.preventDefault();
      // `?.` and `??` because a drag event can reach a handler with no `dataTransfer` — happy-dom
      // builds one only when a test supplies it — and a throw here would be a page saved and a
      // refusal never written down.
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) {
        /*
         * A dragged link, or a selection of text, or a drag from another app carrying no file.
         * The default is still refused above — a dropped URL navigates just as a dropped file does
         * — but there is nothing to name and nothing was attempted, so a refusal written here
         * would be one invented for a gesture nobody made.
         */
        return;
      }
      /*
       * CHOSEN BY WHAT IS DEAD, NOT BY WHAT IS MISSING.
       *
       * This asked `attachmentsEnabled` — is there a channel — and got one of the four states
       * wrong. A composer that is BOTH `disabled` and channel-less was told "there is no
       * conversation here yet. Send this message first, then attach to the one it opens", while
       * the Send button beside the sentence is shut and pressing it does nothing. Advice that
       * cannot be followed is worse than none: it sends somebody to a control that is already
       * refusing them, and they conclude the app is broken rather than that this conversation is
       * over.
       *
       * `disabled` is the question actually being answered — CAN THIS PERSON DO THE THING THE
       * SENTENCE WILL TELL THEM TO DO. It is also the only one of the two that can be true while
       * the other is: `canAttach` is `attachmentsEnabled && !disabled`, so reaching here means at
       * least one is against us, and `disabled` is the one that makes the next step impossible.
       * The three states that were already right are unchanged: a live channel-less composer still
       * gets the "not yet" sentence, and a disabled channel still gets "can no longer take
       * messages".
       */
      const reason =
        UNACCEPTED_DROP_REASON[disabled ? "cannot-send" : "no-conversation"];
      /*
       * `setRejected` directly rather than through `recordRejection`, which takes the SDK's
       * `UploadFailure` shape — a `file` plus a `message` — and would mean fabricating an upload
       * failure for a file no upload was ever attempted for. One line per file, matching every
       * other refusal on this composer: dropping two files on a dead channel is two files that did
       * not arrive, and folding them into one line loses which.
       */
      setRejected((current) => [
        ...current,
        ...files.map((file) => ({ id: newId(), name: file.name, reason })),
      ]);
    },
    [disabled],
  );

  const handlePickedFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.target.files ?? []);
      // Emptied so that picking the same file again still fires a change event: a file refused by
      // the screen above is a file somebody may well pick a second time by mistake, and an input
      // still holding it would silently do nothing.
      event.target.value = "";
      void stageFiles(picked);
    },
    [stageFiles],
  );

  /**
   * PromptArea already draws an attachment strip, so these map onto its props rather than adding a
   * second one. An upload in flight has no preview to show — its placeholder source is an empty
   * string until `onUpload` answers — which is what `loading` covers.
   *
   * SPLIT ON WHAT THE FILE IS, NOT ON WHAT THE BROWSER CALLED IT — the same correction the send
   * path (`toAttachmentPart` in `channel-chat.tsx`) and the parked tiles (`parkedTiles` in
   * `chat-transcript.tsx`) already made, through the same shared `attachmentModality`.
   *
   * `attachment.type` is the SDK's modality, and the SDK derives it from `file.type`: the
   * browser's guess from a file extension, made before anything read a byte. A screenshot dragged
   * out of an app that names it `application/octet-stream` was drawn here as a grey file card and
   * then turned into a thumbnail the instant it was parked or sent — the same file, three
   * surfaces, two answers, and the tile visibly changing shape at the moment of sending. The other
   * direction is worse: a text file the browser calls `image/png` was handed to an `<img>` that
   * can never render it, which is a broken-image icon where a filename should be.
   *
   * ONLY A `url` SOURCE'S `mimeType` IS EVIDENCE, which is why the narrowing below is not
   * defensive noise. A `data` source's `mimeType` is `file.type` — the very claim being refused,
   * wearing the name of an answer — and only a `url` source has been past the server, which sniffs
   * the bytes. `attachmentModality` falls back to the declared type when there is nothing
   * corroborated, so an attachment still uploading is drawn exactly as it used to be and settles
   * onto the truth when the server answers. That settle is the one visible cost: a mislabelled
   * screenshot spends its upload as a file card. The alternative is holding every tile back until
   * the answer, which would make every ordinary attachment feel slower to spare a rare one a
   * flicker.
   */
  const images = useMemo(
    () =>
      staged
        .filter((attachment) => stagedModality(attachment) === "image")
        .map((attachment) => ({
          id: attachment.id,
          url: attachment.source.value,
          alt: attachment.filename,
          loading: attachment.status === "uploading",
        })),
    [staged],
  );

  /**
   * NO `type` HERE, BECAUSE NOTHING HAS EVER READ ONE. This carried
   * `type: attachment.source.mimeType`, `StagedFile` (`attachment-strip.tsx`) declares no such
   * field, and `AttachmentStrip` draws the same `IconFile` for every file whatever its type. It
   * survived because the array is a variable rather than a fresh object literal at the JSX site, so
   * TypeScript's excess-property check — the thing that would have caught it — never ran.
   *
   * Deleted rather than adopted. Adding `type` to `StagedFile` and drawing a per-format label off
   * it is a real improvement and a deliberately separate one: it is a design change to the tile,
   * not the removal of a line that pretends to feed something.
   *
   * The complement of `images` above, and it has to be read as one: whatever is not an image is a
   * card, so both halves must ask the same question of the same field or an attachment lands in
   * both strips or in neither.
   */
  const files = useMemo(
    () =>
      staged
        .filter((attachment) => stagedModality(attachment) !== "image")
        .map((attachment) => ({
          id: attachment.id,
          name: attachment.filename ?? "Attachment",
          size: attachment.size,
          loading: attachment.status === "uploading",
        })),
    [staged],
  );

  const isBusy = pending || isSubmitting;
  const triggers = useMemo(
    () => buildTriggers({ agents, commands }),
    [agents, commands],
  );
  const draft = useMemo(() => toDraft(value, staged), [staged, value]);

  const handleChange = useCallback(
    (next: Segment[]) => {
      const { segments, actions } = applyCommandChips(
        enforceSingleAgent(next),
        commands,
      );
      setValue(segments);
      // Run after the commit so an action that navigates or opens a panel is not fighting the
      // editor's own state update for the same tick.
      for (const action of actions) {
        action();
      }
    },
    [commands],
  );

  /**
   * The single submit path for Enter, the send button, and the form.
   *
   * `submitInFlight` is a ref rather than `isSubmitting` because a second Enter can land before
   * React has re-rendered with the new state, which would send the message twice.
   */
  const submitDraft = useCallback(
    async (segments: Segment[]) => {
      // `canSendDraft` rather than `isEmpty`: a screenshot with no words is a message, and an
      // upload still in flight is not one yet, whatever is typed alongside it.
      const submitted = toDraft(segments, staged);
      if (!canSendDraft(submitted) || disabled) {
        return;
      }

      /*
       * A TURN IS IN FLIGHT, AND THIS IS THE FORK THE WHOLE AFFORDANCE HANGS ON.
       *
       * With somewhere to park it the message goes there and the box empties, so the person sees
       * their words land. Without, we are back to refusing, which is what every caller that does
       * not queue still gets.
       *
       * It returns before `submitInFlight` and `isSubmitting` are touched on purpose. Those guard
       * one send from starting twice; a send here is held open for the length of the whole run, so
       * borrowing them for a parked message would let the first turn lock out every correction
       * typed while it worked — the exact thing this exists to allow.
       */
      if (isBusy) {
        if (!onQueue) {
          return;
        }
        setValue([]);
        dismissRejections();
        // Taken off the composer as the message is parked, so the strip empties with the words
        // rather than leaving the files looking like they are still to be sent. Only these —
        // `consumeAttachments()` takes every `ready` attachment, including ones a send already
        // in flight is riding, and that send's own `finally` still needs them to hand back if it
        // fails. `submitted.attachments` is `staged`, which already excludes those.
        //
        // Released BEFORE the chips go, and this order is not cosmetic: the parked message owns
        // these rows now and will send them later, so the reconciler must be told before it sees
        // the chips disappear — otherwise it reads a queued message's attachments as abandoned and
        // deletes the rows out from under it.
        releaseStagedRows(submitted.attachments);
        for (const attachment of submitted.attachments) {
          removeAttachment(attachment.id);
        }
        onQueue(submitted);
        return;
      }

      if (submitInFlight.current || !onSubmit) {
        return;
      }

      submitInFlight.current = true;
      setIsSubmitting(true);
      // Clear optimistically; restore if the send fails before becoming a message.
      setValue([]);
      /*
       * The refusals go with them, and do NOT come back if the send fails. They are about files
       * that never made it onto this message, so the words being restored has nothing to do with
       * them; putting them back would be an old complaint reappearing next to a new attempt.
       */
      dismissRejections();
      // The strip is cleared optimistically too, but by hiding rather than by consuming: these
      // ids leave the composer now, so nothing on screen can send them a second time, and the
      // `finally` below is what decides whether they come back.
      const riding = submitted.attachments.map((attachment) => attachment.id);
      setSending(riding);
      try {
        await onSubmit(submitted);
        // Only once the send has become a message, and only the ones that rode on it —
        // `consumeAttachments()` would also swallow anything attached while the run was in
        // flight, which belongs to the next message and has never been sent.
        //
        // Released first, for the reason the queue branch above gives: the message carries these
        // rows now, and a reconciler that saw the chips go without being told would delete
        // attachments that have just been sent.
        releaseStagedRows(submitted.attachments);
        for (const id of riding) {
          removeAttachment(id);
        }
      } catch {
        /*
         * THE WORDS COME BACK IN FRONT OF WHATEVER ARRIVED WHILE THE SEND WAS OUT, NOT OVER IT.
         *
         * The editor is never disabled mid-turn, and that is deliberate — it is how a correction
         * gets typed at a Bot that is already working. So by the time a send fails the box may well
         * hold something newer than the message that failed. `setValue(segments)` wrote straight
         * over it: the failed message came back and the sentence typed after it was gone, with
         * nothing said about either. Both are somebody's words, so neither may be dropped; the
         * restored ones go ahead of the newer ones and the person edits the join.
         */
        setValue((current) => {
          // An attachment-only message has no words to restore, and putting an empty segment list
          // back would clear a box somebody has since typed into.
          if (isSegmentsEmpty(segments)) {
            return current;
          }
          if (isSegmentsEmpty(current)) {
            return segments;
          }
          return mergeAdjacentTextSegments([
            ...segments,
            text(" "),
            ...current,
          ]);
        });
        /*
         * NOT RETHROWN, AND THE RETHROW THIS REPLACES REACHED NOTHING.
         *
         * `submitDraft` has exactly two callers: `handleFormSubmit`, which does
         * `void submitDraft(value)`, and PromptArea's `onSubmit`, which calls it and ignores the
         * promise. Neither awaits and neither catches, so every failed send became an unhandled
         * rejection — and in this repository's test runner, a failure attributed to whichever test
         * happened to be running when it surfaced, which is why two composer suites carry notes
         * saying a failed send could not be driven from them at all.
         *
         * Nothing is hidden by stopping. The caller is the half that knows what went wrong and it
         * already reports it: `conversation-view.tsx` shows a failed turn through its own notice,
         * and its drain path catches this same rejection under a comment saying the composer's
         * throw exists only so the composer can put the words back. Putting the words back is what
         * this catch does, so there is nothing left for the throw to carry.
         */
      } finally {
        // Handed back to the composer either way: on success they are already gone from the
        // hook's own state, and on failure this is what puts the chips back beside the restored
        // words rather than leaving somebody to re-pick files that are still staged server-side.
        setSending([]);
        submitInFlight.current = false;
        setIsSubmitting(false);
        // Asked for here, performed in the effect below, which runs after the commit that clears
        // `isSubmitting` and so after the render the caret would otherwise be placed against.
        wantsFocus.current = true;
      }
    },
    [
      disabled,
      dismissRejections,
      isBusy,
      onQueue,
      onSubmit,
      releaseStagedRows,
      removeAttachment,
      staged,
    ],
  );

  /**
   * Put the caret back the moment the composer can accept it again.
   *
   * Keyed off the editor becoming interactive rather than off the send resolving, so it survives
   * whatever the parent does with `pending` in between — and it runs after the commit, which is the
   * only point at which the element is enabled and focusable.
   *
   * Two different debts, and only one of them recurs. A finished send owes the caret back every
   * time. `autoFocus` owes it exactly once, at the start: it used to be re-owed on every
   * disabled/busy transition, so every completed turn stole the caret back from wherever the person
   * had moved it, and a composer that had never been sent from would grab focus mid-conversation.
   */
  useEffect(() => {
    if (disabled || isBusy) {
      return;
    }
    const owed = wantsFocus.current || (autoFocus && !claimedAutoFocus.current);
    if (!owed) {
      return;
    }
    wantsFocus.current = false;
    claimedAutoFocus.current = true;
    promptAreaRef.current?.focus();
  }, [autoFocus, disabled, isBusy]);

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitDraft(value);
  };

  /**
   * There is a turn in flight and somewhere to park what is being typed.
   *
   * Not the same question as "is anything typed" — an empty composer mid-turn can queue nothing,
   * and the button it wants is Stop.
   */
  const canQueue = Boolean(onQueue) && isBusy && !disabled;
  /**
   * There is a message here to send or to park.
   *
   * `canSendDraft` rather than a local "is anything typed": it is the half of this answer that
   * knows about attachments — an image on its own is a message, and one still uploading is not
   * one yet. Both buttons read it, so Send and Queue can never disagree about whether there is
   * anything to do.
   */
  const sendable = canSendDraft(draft);
  /** Something to send, mid-turn, with a queue to put it in. */
  const parking = canQueue && sendable;
  const canSend = !disabled && sendable && (!isBusy || canQueue);
  /**
   * Stop is available only once there is a run for it to reach, and it gives way to Send the moment
   * there is something typed to park.
   *
   * `stoppable` rather than `pending`, because a turn is in flight before its run is, and a button
   * that cannot do the thing it names is worse than no button at all.
   *
   * One button, so one of the two has to yield. Send wins because the correction is the thing that
   * cannot wait: park it and the box empties, which brings Stop straight back — so stopping is
   * never more than one press away, and the press before it is the one that saves the sentence.
   * Showing both would be honest and would also put two round buttons in a row on a compact
   * composer that has room for one.
   */
  const canStop = Boolean(onStop) && (stoppable ?? pending) && !parking;
  /**
   * The same arrow either way, because it is the same gesture, but a screen reader is told which of
   * the two it is about to do. "Send" on a button that will not send for another minute is a small
   * lie told to exactly the people who cannot see the queue it lands in.
   */
  const sendLabel = parking ? "Queue message" : "Send message";

  /**
   * EVERY COMPOSER IS A DROP TARGET. What changes with `canAttach` is what happens to the file,
   * never whether the browser gets to keep it — see `refuseDragOver` above for what an
   * uninstalled `dragover` handler actually does to this app.
   *
   * SPREAD ON THE CONTAINER, NOT ON THE FORM, AND THE DIFFERENCE IS A REAL GAP THAT WAS OPEN. The
   * refusal strip renders ABOVE the form — `RejectedFiles` is a sibling, moved there so the reasons
   * sit next to the drop that caused them rather than below the box — so with the handlers on the
   * form, a file let go over a refusal was let go over nothing. The most likely second drop in the
   * whole app lands exactly there: somebody drops two files, reads why the first was refused, and
   * aims the retry at the sentence they are reading.
   *
   * The container is also the element `containerRef` is on, which is the boundary our own paste
   * listener already uses to decide whether a paste is ours. One element now answers both
   * questions, so "inside this composer" means the same thing for a file that arrives by clipboard
   * and for one that arrives by hand.
   *
   * No `onDragLeave` on the refusing branch, and that is not an omission: `handleDragLeave` only
   * puts the hook's `dragOver` flag back down, and the branch that never raises it has nothing to
   * put down. (Nothing renders that flag today — see `handleDrop` above, which says why the call
   * is kept anyway.)
   */
  const dropZone = canAttach
    ? {
        onDragLeave: handleDragLeave,
        onDragOver: handleDragOver,
        onDrop: handleDrop,
      }
    : {
        onDragOver: refuseDragOver,
        onDrop: refuseDrop,
      };

  /**
   * Rendered only with a channel behind it: without one there is nothing to upload to, and a file
   * dialog that leads nowhere is worse than no button.
   *
   * `FILE_PICKER_ACCEPT` RATHER THAN `attachmentsConfig?.accept`, WHICH THESE TWO NO LONGER SHARE.
   * The config's `accept` is a GATE the SDK enforces on every file we hand it, and it is a wildcard
   * now for the reason set out on `attachmentsConfigFor` — a second, stricter, machine-worded gate
   * behind `screenPickedFiles` refused the very files that screen exists to pass. A dialog filter is
   * a HINT: it greys files out, refuses nothing, and drag and paste never meet it. Spending one
   * string on both meant the honest widening of the gate would have widened the hint to "any file",
   * which helps nobody. Two names, two jobs.
   */
  const filePicker = attachmentsEnabled ? (
    <input
      accept={FILE_PICKER_ACCEPT}
      className="sr-only"
      // The input the `+` button clicks, shut along with it: a `click()` on a disabled input opens
      // no dialog, so the door is closed even to a caller that reaches past the button for the ref.
      disabled={disabled}
      multiple
      onChange={handlePickedFiles}
      ref={fileInputRef}
      type="file"
    />
  ) : null;

  if (compact) {
    return (
      /*
       * THE WRAPPER EXISTS TO HOLD `containerRef`, AND HOLDING IT IS NOT OPTIONAL. The ref is the
       * boundary our own `document` paste listener asks about — it claims a paste only when the
       * event's target is inside this element — so a branch that never lands the ref has paste
       * dead entirely rather than merely unstyled: every paste into it reads as somebody else's.
       * The ref is typed for a `div`, which is why it cannot simply go on the form.
       *
       * IT IS ALSO A COLUMN NOW, so the refusals can sit ABOVE the composer. Below, they pushed the
       * box the person is reading down the screen as each one arrived, and on the compact composer
       * that box is already pinned to the bottom of the pane — so the reasons appeared in the gap
       * under it, furthest from the drop that caused them.
       */
      <div className="flex flex-col" ref={containerRef} {...dropZone}>
        <RejectedFiles onDismiss={dismissRejections} rejected={rejected} />
        <form
          aria-busy={isBusy}
          className={cn(
            /*
             * `py-3` IS LOAD-BEARING ONCE THE TEXT WRAPS. On one line `min-h-14` and the controls
             * row's own `items-center` fake the vertical padding, so it read as correct for as long
             * as nobody typed a paragraph. Past that the box grows to fit its content exactly and
             * the glyphs sit against the border.
             *
             * It goes on the form rather than on the editor because the editor scrolls internally
             * at COMPACT_MAX_HEIGHT_PX: padding inside that box would scroll away with the text, so
             * the first visible line would still touch the top edge on a long message.
             */
            /*
             * A COLUMN, SO THE ATTACHMENT STRIP CAN HAVE THE FULL WIDTH. It used to be one row —
             * attach button, editor, send — with the strip inside the editor's column, which
             * started it 42px in from the frame's left edge with nothing under it. The strip is
             * its own row across the top now, and the three controls keep their row below it.
             */
            "flex min-h-14 flex-col rounded-2xl border border-border bg-card px-3 py-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
            className,
          )}
          onSubmit={handleFormSubmit}
        >
          {filePicker}
          <AttachmentStrip
            files={files}
            images={images}
            onRemove={discardAttachment}
          />
          {/*
           * `self-end` ON THE THREE CONTROLS, AND IT COSTS NOTHING ON ONE LINE. The row is
           * `items-center`, which is right while everything in it is a single line high. A long
           * message grows the editor to `COMPACT_MAX_HEIGHT_PX`, and centred buttons then float to
           * the middle of that block rather than sitting on the line the person is typing. Empty,
           * the row is exactly a button tall, so centred and bottom are the same pixel.
           */}
          <div className="flex items-center gap-3">
            {attachmentsEnabled ? (
              <Button
                aria-label="Attach a file"
                className="self-end"
                // The button stays, and stays labelled: a conversation that cannot take another
                // message has not lost the ability to attach, it has lost the message. Swapping it
                // for the "unavailable" placeholder would say the wrong thing about why.
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
                size="icon"
                type="button"
                variant="ghost"
              >
                <IconPlus className="size-5" />
              </Button>
            ) : (
              <Button
                aria-label="More message options unavailable"
                className="self-end disabled:opacity-100"
                disabled
                size="icon"
                type="button"
                variant="ghost"
              >
                <IconPlus className="size-5" />
              </Button>
            )}
            <PromptArea
              aria-label="Message"
              className={cn(
                "min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none",
                editorClassName,
              )}
              disabled={disabled}
              maxHeight={COMPACT_MAX_HEIGHT_PX}
              minHeight={COMPACT_MIN_HEIGHT_PX}
              onChange={handleChange}
              onImagePaste={canAttach ? stagePastedImage : undefined}
              onSubmit={submitDraft}
              placeholder="Ask anything"
              ref={promptAreaRef}
              triggers={triggers}
              value={value}
            />
            {canStop ? (
              <Button
                aria-label="Stop the Bot"
                className="size-8 self-end rounded-full p-0"
                data-testid="composer-stop"
                onClick={onStop}
                size="icon"
                type="button"
              >
                <IconPlayerStopFilled className="size-3" />
              </Button>
            ) : (
              <Button
                aria-label={sendLabel}
                className="size-8 self-end rounded-full p-0"
                disabled={!canSend}
                size="icon"
                type="submit"
              >
                <IconArrowUp className="size-3.5" />
              </Button>
            )}
          </div>
        </form>
      </div>
    );
  }

  return (
    // The same `containerRef`, on the wrapper this branch already had: the paste listener is scoped
    // to whatever holds the ref, so a branch without it can be pasted into and nothing happens.
    <div
      className={cn("flex w-xl flex-col", className)}
      ref={containerRef}
      {...dropZone}
    >
      <RejectedFiles onDismiss={dismissRejections} rejected={rejected} />
      <form
        aria-busy={isBusy}
        className="overflow-hidden rounded-2xl border border-border bg-card"
        onSubmit={handleFormSubmit}
      >
        {filePicker}

        <div className="grow px-3 pt-3 pb-2">
          <AttachmentStrip
            files={files}
            images={images}
            onRemove={discardAttachment}
          />
          <PromptArea
            aria-label="Message"
            autoGrow
            className={cn(
              "w-full border-0 bg-transparent p-0 text-sm shadow-none",
              editorClassName,
            )}
            disabled={disabled}
            maxHeight={MAX_HEIGHT_PX}
            onChange={handleChange}
            onImagePaste={canAttach ? stagePastedImage : undefined}
            onSubmit={submitDraft}
            placeholder="Ask anything"
            ref={promptAreaRef}
            triggers={triggers}
            value={value}
          />
        </div>

        <div className="mb-2 flex items-center justify-between px-2">
          {attachmentsEnabled ? (
            <Button
              aria-label="Attach a file"
              className="size-7 rounded-full p-0"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              type="button"
              variant="ghost"
            >
              <IconPlus className="size-4" />
            </Button>
          ) : (
            <div />
          )}

          <div>
            {canStop ? (
              <Button
                aria-label="Stop the Bot"
                className="size-7 rounded-full bg-primary p-0"
                data-testid="composer-stop"
                onClick={onStop}
                type="button"
              >
                <IconPlayerStopFilled className="size-3" />
              </Button>
            ) : (
              <Button
                aria-label={sendLabel}
                className="size-7 rounded-full bg-primary p-0 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSend}
                type="submit"
              >
                <IconArrowUp className="size-3.5 fill-primary" />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * GIVE BACK THE STAGED ROW A REMOVED CHIP STOOD FOR — THE ONLY CALLER THIS ENDPOINT HAS.
 *
 * `removeAttachment` only filters client state, so until this existed, attach-then-change-your-mind
 * left the row staged with `attachedAt IS NULL` for good. The upload handler counts exactly those
 * rows per person per channel and refuses the ninth with "You already have 8 attachments waiting to
 * send in this channel." — naming files that are on nobody's screen, with no way back.
 *
 * BEST-EFFORT, AND DELIBERATELY UNINSPECTED. The chip is gone from the strip before this is called,
 * because that is what the person asked for; making that wait on a round trip, or reporting what
 * comes back, would put an error in front of somebody for a request they never made. There are two
 * such answers — 404 for a non-uploader, 409 for an attachment already sent — and neither is
 * actionable. `cull-staged-attachments.ts` is the backstop for whatever this misses.
 */
function discardStagedAttachment(attachmentId: string): void {
  void fetch(attachmentUrl(attachmentId), {
    method: "DELETE",
    credentials: "include",
  }).catch(() => undefined);
}

/**
 * THE SECOND DOOR, SHUT.
 *
 * `processFiles` re-checks `accept` itself with an exact, CASE-SENSITIVE `file.type === filter`
 * comparison, while `classifyAttachment` — the rule the server also applies — normalises first.
 * Left alone, the two gates disagree, and a text file this composer accepted would be refused a
 * second time in the SDK's own machine wording.
 *
 * BOTH HALVES OF THE NORMALISATION, WHICH IS WHY THIS GOES THROUGH `mediaTypeOf` RATHER THAN DOING
 * ITS OWN SPLIT. It used to drop the parameter and leave the case, which closed the
 * `text/plain;charset=utf-8` half of the gap and left the other half open: a type differing from
 * the accept list only in case came back from the split unchanged, so this function decided nothing
 * needed doing and handed the SDK a file it was about to refuse. That case cannot be reproduced
 * with `new File(...)`, which lower-cases `type` per the Blob spec — but this function's whole
 * purpose is the files this app did not build.
 *
 * The new `File` is a handle onto the same bytes, not a copy of them.
 */
function withMediaTypeOnly(file: File): File {
  const mediaType = mediaTypeOf(file.type);
  if (mediaType === file.type) {
    return file;
  }
  return new File([file], file.name, {
    lastModified: file.lastModified,
    type: mediaType,
  });
}
