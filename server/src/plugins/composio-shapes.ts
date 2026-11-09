import type { ListShape } from "./result-fit";

/**
 * Composio actions whose call, as a model writes it, brings back more than a model can read, and
 * how OpenBot asks for and hands back each one instead.
 *
 * WHAT THIS IS FOR. Composio's `beforeExecute` and `afterExecute` modifiers exist for this: an
 * action's own defaults are the vendor's, and some of them assume a caller who wants everything.
 * `GMAIL_FETCH_EMAILS` is the one that broke a plain question ("read my emails from the past 24
 * hours and tell me the top 2"): a model asks it for `max_results: 50` with `include_payload: true`
 * and `verbose: true` (Claude Sonnet 5.5 picks exactly those for that prompt), and each message then
 * carries its raw MIME tree with base64 body parts, 30,000 to 65,000 characters per message as
 * Composio returned them on 2026-11-07. Fifty is a few megabytes, two hundred is refused by
 * Composio as `Upstream_PayloadTooLarge` (413), and the 20,000 characters a result may spend in a
 * model's context held part of the first message's HTML.
 *
 * A LISTING IS FOR TRIAGE, so it is asked for as one: sender, recipients, subject, time, labels and
 * Gmail's own snippet, a page small enough to arrive whole, and the page token to the next. The
 * body of any one message is a call to `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`, which the answer says,
 * and that answer, like a thread's, drops the raw MIME too and keeps the decoded body.
 *
 * Keyed by action slug. A slug names one app's action at Composio, so `GMAIL_` is already the app.
 */
export type ActionShape = {
  /** The arguments sent to Composio, from the ones the model wrote. Absent: sent as written. */
  request?(args: Record<string, unknown>): Record<string, unknown>;
  /** The answer's data as the model reads it. */
  answer(data: Record<string, unknown>): Record<string, unknown>;
  /** Where its records are, so a cut keeps them whole. See `./result-fit`. */
  list?: ListShape;
};

/**
 * Messages per page of a Gmail listing.
 *
 * SIZED TO THE RESULT CAP, NOT RAISED PAST IT. A listing message as {@link leanMessage} leaves it
 * measured on a real mailbox's week (175 messages, 2026-11-07) at a mean of 788 characters
 * pretty-printed, 963 at the 95th percentile and 1,055 at the largest, the size driven by long `to`
 * lines and subjects. Pages of 20 from it came to 16,700 characters at most, inside the 20,000 a
 * result may spend (`MAX_RESULT_CHARS`, about 5,000 tokens); pages of 25 went over on five of
 * seven. A page that still runs over is cut between messages and says how to page, so a long page
 * costs a call rather than a message. A busy inbox's day of 150 messages is eight calls and about
 * 30,000 tokens in all, which is what reading every message's key fields costs however it is paged;
 * raising the cap would spend the same tokens on every other tool's answer too.
 */
export const GMAIL_LISTING_PAGE = 20;

/**
 * What a listing tells the model about itself, first in the answer so it is read before the
 * messages.
 *
 * THE PAGE THAT IS NOT THE LAST SAYS SO IN COUNTS. A token alone, with the same sentence on every
 * page, was not enough: asked about a week of mail on a real mailbox, Claude Sonnet 5.5 read two
 * pages of about 200 matches and answered. An answer about "my emails" is an answer about all of
 * them, so a page that is not the last says how many it holds of how many, and that the rest are
 * one call per page away.
 */
export function gmailListingNote(data: Record<string, unknown>): string {
  const base = `This listing holds each message's sender, recipients, subject, time, labels and Gmail's snippet, at most ${GMAIL_LISTING_PAGE} per call. Bodies are left out so a whole page fits: read any message in full with GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID and its messageId.`;
  const token = data.nextPageToken;
  if (typeof token !== "string" || token === "") return base;
  const shown = Array.isArray(data.messages) ? data.messages.length : 0;
  const estimate =
    typeof data.resultSizeEstimate === "number"
      ? ` of about ${data.resultSizeEstimate} that match`
      : "";
  return `${base} This page holds ${shown}${estimate}, so it is not the whole answer: before answering about these messages as a whole, call GMAIL_FETCH_EMAILS again with the same query and page_token "${token}", and keep following nextPageToken until it comes back empty.`;
}

/** A page size the model asked for, held to {@link GMAIL_LISTING_PAGE}; the page when it named none. */
function listingPage(asked: unknown): unknown {
  if (asked === undefined || asked === null) return GMAIL_LISTING_PAGE;
  if (typeof asked !== "number" || !Number.isFinite(asked)) return asked;
  return Math.min(asked, GMAIL_LISTING_PAGE);
}

/**
 * The headers of a message's MIME tree a model is shown. The rest of the tree goes: who else it
 * went to and where a reply goes are the two facts the top-level fields do not already carry.
 */
const KEPT_HEADERS = new Set(["cc", "reply-to"]);

/** The kept headers of a raw `payload`, by their own names, or null when it has none of them. */
function keptHeaders(payload: unknown): Record<string, string> | null {
  if (!payload || typeof payload !== "object") return null;
  const headers = (payload as { headers?: unknown }).headers;
  if (!Array.isArray(headers)) return null;
  const kept: Record<string, string> = {};
  for (const header of headers) {
    if (!header || typeof header !== "object") continue;
    const { name, value } = header as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || typeof value !== "string") continue;
    if (KEPT_HEADERS.has(name.toLowerCase())) kept[name] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * One message as a model reads it, from a listing or read by its id.
 *
 * `payload` is the raw MIME tree, base64url-encoded, which no model reads and which is most of the
 * size; its Cc and Reply-To survive as `headers`. `messageText` is the decoded body when Composio
 * sent one and is dropped when empty, as is an empty `attachmentList`; `preview.subject` repeats
 * `subject`. Everything else is kept under the vendor's own names.
 */
export function leanMessage(message: unknown): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message))
    return message;
  const { payload, messageText, attachmentList, preview, ...rest } =
    message as Record<string, unknown>;
  const lean: Record<string, unknown> = { ...rest };
  const headers = keptHeaders(payload);
  if (headers) lean.headers = headers;
  if (typeof messageText === "string" && messageText.trim() !== "")
    lean.messageText = messageText;
  if (Array.isArray(attachmentList) && attachmentList.length > 0)
    lean.attachmentList = attachmentList;
  if (preview && typeof preview === "object" && !Array.isArray(preview)) {
    const { subject, ...kept } = preview as Record<string, unknown>;
    lean.preview =
      subject !== undefined && subject !== rest.subject
        ? { ...kept, subject }
        : kept;
  } else if (preview !== undefined) {
    lean.preview = preview;
  }
  return lean;
}

const SHAPES: Record<string, ActionShape> = {
  GMAIL_FETCH_EMAILS: {
    request: (args) => ({
      ...args,
      include_payload: false,
      verbose: false,
      max_results: listingPage(args.max_results),
    }),
    // An answer with no message list is not a listing this knows, and goes on as it came.
    answer: (data) =>
      Array.isArray(data.messages)
        ? {
            openbot_note: gmailListingNote(data),
            ...data,
            messages: data.messages.map(leanMessage),
          }
        : data,
    list: {
      key: "messages",
      // The note names the token too, so it goes with it; the cut's own note says how to go on.
      dropWhenCut: ["nextPageToken", "openbot_note"],
      rest: (shown) =>
        `call GMAIL_FETCH_EMAILS again with the same arguments and max_results set to ${shown}, then follow nextPageToken until it comes back empty`,
    },
  },
  // One message: the body stays, decoded, and the raw MIME beside it goes.
  GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: {
    answer: (data) =>
      typeof data.messageId === "string"
        ? (leanMessage(data) as Record<string, unknown>)
        : data,
  },
  /*
   * A thread is its messages, each as one message read by its id: a two-message thread was 122,624
   * characters as Composio sent it on 2026-11-07, 105,000 of them raw MIME. A thread too long to
   * show whole names the messages left out, so each is one call away.
   */
  GMAIL_FETCH_MESSAGE_BY_THREAD_ID: {
    answer: (data) =>
      Array.isArray(data.messages)
        ? { ...data, messages: data.messages.map(leanMessage) }
        : data,
    list: {
      key: "messages",
      dropWhenCut: [],
      rest: (_shown, leftOut) => {
        const ids = leftOut
          .map((message) =>
            message && typeof message === "object"
              ? (message as { messageId?: unknown }).messageId
              : undefined,
          )
          .filter((id): id is string => typeof id === "string");
        return `read each in full with GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID, one call per messageId: ${ids.join(", ")}`;
      },
    },
  },
};

/** How OpenBot asks for and reads one action, or null for an action it passes through as it is. */
export function shapeOf(toolName: string): ActionShape | null {
  return Object.hasOwn(SHAPES, toolName)
    ? (SHAPES[toolName] as ActionShape)
    : null;
}
