import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport, type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type { MailboxConfig } from "../config";

/**
 * The only place in this deployment that speaks IMAP and SMTP.
 *
 * One door, for the same reason `plugins/mcp.ts` is one door for MCP: every call out carries the
 * mailbox password and brings back text a model will read, so both directions want a single place to
 * be careful in. A second client somewhere else would be a second place to forget the timeout, the
 * size cap, or the rule that the password never appears in anything anybody reads.
 *
 * NO SESSION IS KEPT. A connection is opened, used and closed for every listing, every read, every
 * search and every send. A pooled IMAP session would be a long-lived authenticated socket that
 * several Bots' calls arrive on, which is the shape of bug `mcp.ts` declines to have. IMAP is worse
 * for it than HTTP, because a session carries SELECTED-mailbox state, so one call's `mailbox`
 * argument would silently decide what another call read.
 *
 * WHAT THIS MODULE IS NOT. It makes no decision about whether a call is allowed, whose it is, or
 * what a model should be told. It speaks the two protocols and hands back plain values.
 * `plugins/builtin-mailbox.ts` holds the tools, the argument checking and the sentences; the split
 * is the same one Routines has between `routines/store.ts` and `plugins/builtin-routines.ts`.
 */

/**
 * How long a server gets before we give up on it.
 *
 * One number for connecting, for the greeting and for socket inactivity, because a mailbox that is
 * slow in any of those three ways is a turn that is hanging, and the person is waiting either way.
 * Well under the 60s an MCP call is given: a mail server that has said nothing for half a minute is
 * not about to.
 */
const TIMEOUT_MS = 30_000;

/**
 * The wall clock one network operation gets, whatever it is doing.
 *
 * The three timeouts above are all INACTIVITY timeouts, which is a different promise: a server that
 * sends one byte every twenty seconds resets all three forever, and the call it is holding open is a
 * turn nobody can end. This one does not care whether bytes are arriving. When it expires the socket
 * is closed rather than left to the garbage collector, because an abandoned IMAP connection is an
 * authenticated socket that the server keeps until its own idle timer notices.
 *
 * Per operation rather than per tool call, and the difference is visible in exactly one place:
 * `send_message` with `in_reply_to` fetches over IMAP and then sends over SMTP, so its worst case is
 * two deadlines rather than one. Both end, which is the property that matters.
 */
const CALL_DEADLINE_MS = 60_000;

/**
 * The most of one message this deployment will pull off the wire.
 *
 * imapflow will happily accept a literal up to a gigabyte and `simpleParser` has no cap of its own,
 * so without this a single mail with a large attachment is a gigabyte in this process's heap to
 * produce at most {@link MAX_BODY_CHARS} of text. 512 KB is far more prose than the body cap can
 * ever show, so the only thing it truncates is content that was never going to be read out.
 *
 * A truncated source is still parsed, because the headers and the first text part are at the front
 * of a message and are what the tools want. That it was cut is carried out with the message and
 * said in the answer rather than left to look like a message that ended there.
 */
export const MAX_SOURCE_BYTES = 512 * 1024;

/** One message as a listing shows it. No body: a listing of ten bodies is not a listing. */
export type MessageHeader = {
  uid: number;
  /** The From: header rendered as `Name <address>`, or just the address. */
  from: string;
  to: string;
  subject: string;
  /** The message date as an ISO string, or null when the server sent none. */
  date: string | null;
  seen: boolean;
};

/** One message, opened. */
export type FullMessage = MessageHeader & {
  /**
   * The Message-ID header, which is the only thing that makes a reply thread.
   *
   * Null for a message that arrived without one. A reply to such a message is still a reply; it just
   * cannot be threaded, and {@link OutgoingMessage.reply} is left off rather than filled with a
   * guess that would thread it into the wrong conversation.
   */
  messageId: string | null;
  /** The References header, oldest first, as the reply has to repeat it. */
  references: readonly string[];
  /** The text of the message, already bounded by the caller's cap. */
  body: string;
  /** How long the body was before the cap, so the caller can say it was cut. */
  bodyLength: number;
  /**
   * True when only the first {@link MAX_SOURCE_BYTES} of the message were read off the wire.
   *
   * Separate from a body that was merely long: this one says the deployment never saw the rest, so
   * an answer that says "that is the whole message" would be wrong rather than abbreviated.
   */
  sourceTruncated: boolean;
  /** What the server says the whole message weighs, in bytes, when it says. */
  sizeBytes: number | null;
};

/** A message on its way out. */
export type OutgoingMessage = {
  to: string;
  subject: string;
  body: string;
  /**
   * The message this one replies to, when it is a reply.
   *
   * Both headers together, never one: `In-Reply-To` alone threads in some clients and not others,
   * and `References` alone loses which message was actually answered. They are computed from a
   * message that was fetched, so a reply is threaded against something that exists rather than
   * against an id a model produced.
   */
  reply?: { messageId: string; references: readonly string[] };
};

/**
 * One open IMAP connection, as the four tools need it.
 *
 * Deliberately narrow. Nothing a model calls has any business deleting a message, moving one, or
 * setting a flag, so none of that is here. Same reasoning that keeps `RoutineTools` down to four of
 * `RoutineStore`'s methods.
 */
export type MailboxSession = {
  /** The newest `limit` messages in `mailbox`, newest first. */
  recent(mailbox: string, limit: number): Promise<MessagePage>;
  /** One message by uid, or null when that mailbox holds no such uid. */
  message(mailbox: string, uid: number): Promise<FullMessage | null>;
  /** Messages whose subject, sender or text matches, newest first, at most `limit`. */
  search(mailbox: string, query: string, limit: number): Promise<MessagePage>;
};

/**
 * Some messages, and how many there were to choose from.
 *
 * `total` is the whole point of the shape. A page of ten headers with nothing else said reads to a
 * model as the whole mailbox, and it will answer "you have ten messages" about a mailbox holding
 * four thousand. The count is free at both call sites (the mailbox's own `exists`, and the length of
 * what SEARCH returned) and it is the difference between a listing and a claim.
 */
export type MessagePage = {
  headers: MessageHeader[];
  /** How many messages the mailbox or the search had, before `limit` was applied. */
  total: number;
};

/**
 * The two protocols, as something the tools can be tested against.
 *
 * A seam rather than a direct import, and it is the same seam `PluginStoreOptions.callVendor` is:
 * the properties worth asserting about this module are which arguments a call went out with and
 * what a model is told, and asserting either otherwise would need a reachable mail server, which
 * means the properties most worth testing would be the ones never tested.
 */
export type MailboxClients = {
  /** Open a connection, run the work, close it. Closed whatever happened. */
  withSession<T>(use: (session: MailboxSession) => Promise<T>): Promise<T>;
  send(message: OutgoingMessage): Promise<SendReceipt>;
};

/**
 * What happened to one outgoing message: it went, and whether a copy was filed.
 *
 * TWO OUTCOMES RATHER THAN ONE, and keeping them apart is the whole point of the shape. SMTP
 * delivery and the IMAP copy are separate operations against separate servers, and the second can
 * fail after the first has succeeded. Reported as one failure, that is a Bot telling somebody the
 * mail did not go and sending it again, which is the expensive mistake: mail cannot be recalled and
 * the recipient gets it twice.
 */
export type SendReceipt = {
  messageId: string | null;
  /** The folder the copy was appended to, or null when no copy was filed. */
  filedTo: string | null;
  /** Why no copy was filed, when none was. Null when one was. */
  fileError: string | null;
};

/**
 * The message as bytes, built once.
 *
 * WHY RAW RATHER THAN LETTING NODEMAILER COMPOSE AT SEND TIME. What SMTP delivers and what IMAP
 * stores have to be the same message, and composing twice is two messages: different `Message-ID`,
 * different `Date`, different boundaries. A person looking at Sent in webmail would be reading a
 * near-copy of what the recipient got, and a Bot trying to verify its own send by `Message-ID`
 * would find nothing.
 */
export type ComposedMessage = {
  raw: Buffer;
  /** The SMTP envelope, so the delivery uses the same addresses the headers name. */
  envelope: ReturnType<
    ReturnType<InstanceType<typeof MailComposer>["compile"]>["getEnvelope"]
  >;
  messageId: string;
};

/**
 * Build one outgoing message into the bytes that will be both delivered and stored.
 *
 * Exported because it is worth asserting on its own: it is the only place the `From` is decided,
 * and the only place the two threading headers are written.
 */
export async function composeMessage(
  account: string,
  message: OutgoingMessage,
): Promise<ComposedMessage> {
  const composed = new MailComposer({
    // The selected account, never an address from the arguments. A `from` a model could name is a
    // Bot sending mail as somebody else.
    from: account,
    to: message.to,
    subject: message.subject,
    text: message.body,
    ...(message.reply
      ? {
          inReplyTo: message.reply.messageId,
          references: [...message.reply.references],
        }
      : {}),
  }).compile();

  return {
    raw: await composed.build(),
    envelope: composed.getEnvelope(),
    // `compile` has already ensured one, so this is the id that is in the bytes above rather than a
    // second one generated here.
    messageId: composed.messageId(),
  };
}

/** The special-use flag every IMAP server that has a Sent folder marks it with (RFC 6154). */
const SENT_SPECIAL_USE = "\\Sent";

/** What a Sent folder is called on a server that marks nothing. Lower-cased. */
const SENT_NAMES = new Set(["sent", "sent items", "sent messages"]);

/**
 * Which folder a copy of a sent message belongs in, out of what the server listed.
 *
 * SPECIAL-USE FIRST, because it is the answer that survives a localised server: a French account's
 * Sent folder is `Éléments envoyés` and no list of English names will ever find it. The names are
 * the fallback for the servers that mark nothing, and they are the three spellings in the wild.
 *
 * Null rather than a guess when neither finds one. Appending to the wrong folder is worse than not
 * appending: it puts outgoing mail somewhere a person will read it as incoming.
 */
export function sentFolderFrom(
  boxes: readonly { path: string; name?: string; specialUse?: string }[],
): string | null {
  const marked = boxes.find((box) => box.specialUse === SENT_SPECIAL_USE);
  if (marked) return marked.path;

  const named = boxes.find((box) =>
    SENT_NAMES.has((box.name ?? box.path).toLowerCase()),
  );
  return named ? named.path : null;
}

/** The most of one body that is ever read out of a message. See {@link readBody}. */
export const MAX_BODY_CHARS = 8_000;

export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxError";
  }
}

/** The wall clock in {@link withDeadline} won. Its own class so a send can tell it from a refusal. */
export class DeadlineExpiredError extends MailboxError {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineExpiredError";
  }
}

/**
 * A send the server never answered, which is neither a delivery nor a failure.
 *
 * SMTP confirms a message with one reply after the final `.` of DATA, and everything before that
 * reply is the server's to decide. A socket that times out, drops or hits this module's deadline
 * after the bytes have gone is a message that may well be in the recipient's inbox, and the only
 * thing this process knows is that it was not told. Reporting that as a plain failure is the one
 * way this connector can deliver a message twice: a Bot told "it failed" sends it again, and mail
 * cannot be recalled. So it is a different error with a different sentence, one that says delivery
 * is unknown, says not to retry, and carries the Message-ID so a duplicate can be traced if a
 * person decides to send after all.
 *
 * The rule errs towards this class. nodemailer tags a lost socket `CONN` whatever command was in
 * flight, so a greeting that never arrived and a reply that never arrived after DATA look the same
 * from here, and the first is reported as unconfirmed too. A Bot held back from a message that was
 * never sent costs a person one look; a Bot that resent one that was costs the recipient two.
 */
export class UnconfirmedSendError extends MailboxError {
  readonly messageId: string;

  constructor(messageId: string, cause: string) {
    super(
      `The mail server stopped answering while the message was being sent (${cause}), so it is not known whether it was delivered, and it may have been. Do not send it again. Tell the person who asked, and quote message id ${messageId}, so a duplicate can be found if they decide to resend.`,
    );
    this.name = "UnconfirmedSendError";
    this.messageId = messageId;
  }
}

/**
 * Whether a failure while sending leaves delivery unknown, as opposed to refused.
 *
 * A refusal is a sentence the server wrote: nodemailer files those under `EENVELOPE`, `EMESSAGE`,
 * `EAUTH` and `EPROTOCOL`, and carries the reply. What it files under `ETIMEDOUT`, `ESOCKET` and
 * `ECONNECTION` is a server that went quiet or a socket that went away, at whatever point in the
 * exchange that happened; this module's own deadline is the same thing on a longer clock. See
 * {@link UnconfirmedSendError} for why the quiet cases are all treated as possibly delivered.
 */
export function deliveryUnconfirmed(error: unknown): boolean {
  if (error instanceof DeadlineExpiredError) return true;
  if (error === null || typeof error !== "object") return false;
  const { code } = error as { code?: unknown };
  return code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION";
}

/** `Name <address>`, or the address alone, or an empty string. Never `undefined` in a listing. */
function addressLine(
  addresses: readonly { name?: string; address?: string }[] | undefined,
): string {
  if (!addresses || addresses.length === 0) return "";
  return addresses
    .map((one) => {
      const address = one.address ?? "";
      const name = one.name?.trim();
      return name ? `${name} <${address}>` : address;
    })
    .join(", ");
}

/**
 * A header line out of what the server sent.
 *
 * Every field is optional in IMAP's envelope and several are optional in practice: a message with no
 * Subject, no Date, or a From the server could not parse is an ordinary message, not an error. Empty
 * strings rather than absent fields, so the rendering above this never has to branch.
 */
function headerOf(message: {
  uid: number;
  flags?: Set<string>;
  envelope?: {
    date?: Date;
    subject?: string;
    from?: { name?: string; address?: string }[];
    to?: { name?: string; address?: string }[];
  };
}): MessageHeader {
  const envelope = message.envelope ?? {};
  return {
    uid: message.uid,
    from: addressLine(envelope.from),
    to: addressLine(envelope.to),
    subject: envelope.subject ?? "",
    date: envelope.date ? new Date(envelope.date).toISOString() : null,
    seen: message.flags?.has("\\Seen") ?? false,
  };
}

/**
 * HTML as something worth putting in front of a model, for a message that carries no text part.
 *
 * Deliberately crude, and only ever a fallback. `mailparser` already hands back `text` for anything
 * multipart/alternative, which is nearly everything; what is left is the marketing mail that ships
 * HTML alone, where the choice is between this and telling the model the message was empty. Scripts
 * and styles go first, because their contents are not prose and would otherwise arrive as prose.
 */
export function strippedHtml(html: string): string {
  return (
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+/g, " ")
      // The space every dropped tag left behind, where it now sits at the start or end of a line. A
      // stripper that keeps them indents the whole message by one space and nobody can see why.
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * The readable text of a parsed message, and how long it was before the cap.
 *
 * The text part wins whenever there is one. Falling back to the HTML is for the message that has no
 * text part at all, rather than for the one whose text part is short: a plain-text alternative that
 * says "this message needs an HTML viewer" is still what the sender wrote, and preferring the HTML
 * on length would swap the sender's own words out for markup on any short message.
 */
export function readBody(parsed: { text?: string; html?: string | false }): {
  body: string;
  bodyLength: number;
} {
  const text = parsed.text?.trim();
  const source =
    text && text.length > 0
      ? text
      : typeof parsed.html === "string"
        ? strippedHtml(parsed.html)
        : "";
  return {
    body:
      source.length > MAX_BODY_CHARS ? source.slice(0, MAX_BODY_CHARS) : source,
    bodyLength: source.length,
  };
}

/** The References header as a list, oldest first. Whitespace-separated, per RFC 5322. */
function referencesOf(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : value.split(/\s+/);
  return parts.map((one) => one.trim()).filter((one) => one.length > 0);
}

/**
 * The sentence a mail server actually wrote, out of the error that carries it.
 *
 * WHY THIS IS NOT `error.message`. imapflow answers every IMAP `NO` and `BAD` with an Error whose
 * message is the fixed string "Command failed" and puts the server's own words on `responseText`
 * (`imapflow/lib/imap-flow.js`). So the naive reading turns "Invalid credentials", "Mailbox does not
 * exist" and "Over quota" into one useless sentence that names none of them, which is the opposite
 * of the reason this deployment keeps the vendor's wording at all: each of those has a different fix
 * and only the server can tell them apart.
 *
 * nodemailer is the other half of the same story, from the other protocol: it puts the SMTP reply on
 * `response`. Both are read, and both are read only when they are strings, because imapflow also
 * uses `response` for the parsed response OBJECT, and `String(anObject)` is `[object Object]`.
 */
export function mailServerSentence(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const carried = error as { responseText?: unknown; response?: unknown };
    if (
      typeof carried.responseText === "string" &&
      carried.responseText.trim() !== ""
    ) {
      return carried.responseText.trim();
    }
    if (
      typeof carried.response === "string" &&
      carried.response.trim() !== ""
    ) {
      return carried.response.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** The most folder names one refusal will list. See {@link noSuchFolderSentence}. */
export const MAX_FOLDERS_LISTED = 40;

/**
 * Whether the server refused because the folder is not there, rather than for any other reason.
 *
 * Only ever asked about a failed SELECT, which narrows it a lot: at that point the connection is up
 * and authenticated, so the interesting failures are "no such folder" and permission. Every server
 * words the first differently ("Mailbox doesn't exist: support", "[NONEXISTENT] Unknown Mailbox",
 * "NO Mailbox does not exist"), so the wordings are matched rather than a code that not every
 * server sends.
 */
function looksLikeMissingFolder(error: unknown): boolean {
  const sentence = mailServerSentence(error).toLowerCase();
  return (
    sentence.includes("doesn't exist") ||
    sentence.includes("does not exist") ||
    sentence.includes("nonexistent") ||
    sentence.includes("unknown mailbox") ||
    sentence.includes("no such mailbox") ||
    sentence.includes("no such folder")
  );
}

/**
 * What a model is told when it asked for a folder that is not there.
 *
 * THE VENDOR'S OWN SENTENCE IS A TRAP HERE, which is why this is the one place the rule about
 * keeping it is broken. "Mailbox doesn't exist: support" reads as a folder that happens to be
 * missing, so a model retries with another folder name, and the live failure this exists for was
 * exactly that: refused an address in `folder`, it tried `support`, then `webmaster`, which are the
 * local parts of two configured accounts. The folders that DO exist, and one sentence saying the
 * account is not chosen this way, turn a loop into a correction.
 *
 * Trimmed to fit the 400 characters a failure is capped at by `plugins/builtin-mailbox.ts`, from
 * the end of the list rather than the end of the sentence: the closing instruction is the half that
 * changes what the model does next, so it is the half that must survive.
 */
export function noSuchFolderSentence(
  folder: string,
  account: string,
  folders: readonly string[],
): string {
  const head = `No folder named ${folder} in ${account}.`;
  const tail =
    "The account is chosen by `account`, not by folder; leave folder unset for INBOX.";

  const candidates = folders.slice(0, MAX_FOLDERS_LISTED);
  const room = 380 - head.length - tail.length;
  const shown: string[] = [];
  let used = " Folders here: .".length;
  for (const name of candidates) {
    if (used + name.length + 2 > room) break;
    shown.push(name);
    used += name.length + 2;
  }

  const middle =
    shown.length === 0
      ? ""
      : ` Folders here: ${shown.join(", ")}${shown.length < folders.length ? ", and more" : ""}.`;
  return `${head}${middle} ${tail}`;
}

/**
 * Run one network operation against a wall clock, and shut the socket if the clock wins.
 *
 * The cleanup is the point rather than the rejection. A `Promise.race` that only rejects leaves the
 * losing work running, holding an authenticated connection this deployment has stopped waiting for;
 * `onExpiry` is what makes the deadline mean the operation is over rather than merely unwatched. The
 * timer is cleared in a `finally` so a fast call does not hold the process open for a minute.
 */
export async function withDeadline<T>(
  work: () => Promise<T>,
  onExpiry: () => void,
  what: string,
  // A parameter with a default rather than a constant read inside, so the behaviour can be asserted
  // in a test that finishes in milliseconds instead of one that takes a minute to prove a minute.
  deadlineMs: number = CALL_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Best effort: a socket that is already gone throws here, and that is not a failure of the
      // deadline, which has already decided what this call answers.
      try {
        onExpiry();
      } catch {}
      reject(
        new DeadlineExpiredError(
          `The mail server did not finish ${what} within ${Math.round(deadlineMs / 1000)} seconds.`,
        ),
      );
    }, deadlineMs);
  });

  try {
    // Both promises are raced, so the loser's rejection is handled here rather than surfacing later
    // as an unhandled one.
    return await Promise.race([work(), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The real thing: imapflow for reading, nodemailer for sending.
 *
 * Built per call rather than once, because it holds the password. Nothing here caches a connection,
 * a transport or the secret itself beyond the call that asked for it.
 *
 * `account` is one of `config.users`, already chosen and checked by the caller, and it is both what
 * the two protocols authenticate as and what the mail is from. It is a parameter rather than a
 * field of the configuration because a deployment's hosts are one thing and the account a
 * particular call is working in is another: the same hosts serve every account, and which one this
 * client speaks for is decided per call.
 */
export type MailboxWire = {
  /** How an IMAP client is built. Defaults to imapflow. */
  imap?: (options: ConstructorParameters<typeof ImapFlow>[0]) => ImapLike;
  /** How an SMTP transport is built. Defaults to nodemailer. */
  smtp?: (options: SmtpOptions) => SmtpLike;
};

/** As much of imapflow as this module speaks. */
export type ImapLike = Pick<
  ImapFlow,
  | "connect"
  | "logout"
  | "close"
  | "getMailboxLock"
  | "mailbox"
  | "fetch"
  | "fetchOne"
  | "search"
  | "list"
  | "append"
>;

/** As much of nodemailer as this module speaks. */
export type SmtpLike = Pick<Transporter, "sendMail" | "close">;

/** What this module asks an SMTP transport to be built with. */
export type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
};

export function createMailboxClients(
  config: MailboxConfig,
  account: string,
  password: string,
  /*
   * Injected only by tests, and only for the one property that cannot be asserted otherwise: that
   * the bytes handed to SMTP and the bytes appended to Sent are the same bytes. Everything else
   * about this module is asserted through `MailboxAccess.clients`, one level up.
   */
  wire: MailboxWire = {},
): MailboxClients {
  /**
   * Build, use and close a client.
   *
   * The `finally` logs out whatever happened, because a thrown error is the case where a leaked
   * connection is most likely and least noticed. `logout` is given the same swallow `mcp.ts` gives
   * `close`: a server that will not say goodbye has not failed the work that just succeeded.
   */
  async function withClient<T>(
    use: (client: ImapLike) => Promise<T>,
    what = "reading the mailbox",
  ) {
    const build = wire.imap ?? ((options) => new ImapFlow(options));
    const client = build({
      host: config.imapHost,
      port: config.imapPort,
      // Implicit TLS, always. STARTTLS is negotiated in the clear, so a server that answers without
      // it gets this deployment's mailbox password over a plain socket.
      secure: true,
      auth: { user: account, pass: password },
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
      /*
       * No logging at all, and this is a decision rather than noise control. imapflow's logger
       * writes the commands it sends, and one of them is LOGIN. A deployment that turned this on
       * would put the mailbox password into whatever collects its stdout.
       */
      logger: false,
      // The connection lives for one call, so idling would only ever be a command the next call has
      // to interrupt.
      disableAutoIdle: true,
    });

    try {
      return await withDeadline(
        async () => {
          await client.connect();
          return await use(client);
        },
        // Closed rather than logged out: a deadline has expired because the server is not answering,
        // and LOGOUT is another command to wait for.
        () => client.close(),
        what,
      );
    } catch (error) {
      // Rewrapped so a caller never has to care whether the failure came from the socket, the
      // login or the command, and so what reaches an audit row is one sentence rather than a stack.
      throw new MailboxError(mailServerSentence(error));
    } finally {
      await client.logout().catch(() => {
        client.close();
      });
    }
  }

  /**
   * Hold the mailbox lock for exactly the work that reads it.
   *
   * imapflow's own rule, and the reason it offers a lock at all: SELECT is connection state, so two
   * pieces of work sharing a connection can otherwise read each other's mailbox. Released in a
   * `finally` for the same reason the client is closed in one.
   */
  async function withMailbox<T>(
    client: ImapLike,
    mailbox: string,
    use: () => Promise<T>,
  ): Promise<T> {
    let lock: Awaited<ReturnType<ImapLike["getMailboxLock"]>>;
    try {
      lock = await client.getMailboxLock(mailbox);
    } catch (error) {
      /*
       * A folder that is not there is answered with the folders that are, on the same connection
       * and inside the same deadline. See noSuchFolderSentence for why the server's own words are
       * not enough here.
       */
      if (!looksLikeMissingFolder(error)) throw error;
      let folders: string[] = [];
      try {
        folders = (await client.list())
          .map((box) => box.path)
          .filter(
            (path): path is string => typeof path === "string" && path !== "",
          );
      } catch {
        // A LIST that fails leaves the correction without its examples, which is still better than
        // the vendor's sentence. Never a reason to lose the refusal itself.
      }
      throw new MailboxError(noSuchFolderSentence(mailbox, account, folders));
    }

    try {
      return await use();
    } finally {
      lock.release();
    }
  }

  return {
    async withSession<T>(use: (session: MailboxSession) => Promise<T>) {
      return withClient(async (client) => {
        const session: MailboxSession = {
          async recent(mailbox, limit) {
            return withMailbox(client, mailbox, async () => {
              const open = client.mailbox;
              const exists = open ? open.exists : 0;
              if (exists === 0) return { headers: [], total: 0 };

              /*
               * The tail of the mailbox by SEQUENCE, which is what "newest" means here.
               *
               * Sequence numbers are ordered by arrival and are contiguous, so the last `limit` of
               * them is one range and one round trip. Uids are neither ordered by arrival in any
               * guaranteed way nor contiguous, so asking for "the highest N uids" would be a fetch
               * of the whole mailbox first.
               */
              const first = Math.max(1, exists - limit + 1);
              const headers: MessageHeader[] = [];
              for await (const message of client.fetch(`${first}:${exists}`, {
                uid: true,
                envelope: true,
                flags: true,
              })) {
                headers.push(headerOf(message));
              }
              // Newest first, which is the order a person reads a mailbox in. `exists` is the
              // whole mailbox, so the caller can say ten of four thousand rather than ten.
              return { headers: headers.reverse(), total: exists };
            });
          },

          async message(mailbox, uid) {
            return withMailbox(client, mailbox, async () => {
              const message = await client.fetchOne(
                String(uid),
                {
                  uid: true,
                  envelope: true,
                  flags: true,
                  // Bounded on the WIRE, not after the fact. See MAX_SOURCE_BYTES.
                  source: { maxLength: MAX_SOURCE_BYTES },
                  // What the whole message weighs, which is the only way to tell a message that
                  // ended at the cap from one that happens to be exactly that long.
                  size: true,
                },
                { uid: true },
              );
              // `false` is imapflow's "no such message", and it is a different fact from a
              // message that arrived without a source. Compared rather than falsy-checked so the
              // type narrows: `message?.source` leaves `false` in the union below.
              if (message === false || !message.source) return null;

              const parsed = await simpleParser(message.source);
              const { body, bodyLength } = readBody(parsed);
              const sizeBytes =
                typeof message.size === "number" ? message.size : null;
              return {
                ...headerOf(message),
                messageId: parsed.messageId ?? null,
                references: referencesOf(parsed.references),
                body,
                bodyLength,
                /*
                 * Either the server said the message is bigger than what we asked for, or it did not
                 * say and we got exactly the cap. The second is a message that MIGHT be exactly
                 * 512 KB, and saying it was cut when it was not is the better of the two errors: it
                 * understates what we hold rather than overstating it.
                 */
                sourceTruncated:
                  sizeBytes !== null
                    ? sizeBytes > MAX_SOURCE_BYTES
                    : message.source.length >= MAX_SOURCE_BYTES,
                sizeBytes,
              };
            });
          },

          async search(mailbox, query, limit) {
            return withMailbox(client, mailbox, async () => {
              /*
               * One IMAP SEARCH over the three fields a person means by "find the mail about X".
               * `text` already covers headers and body, and subject and from are named beside it
               * anyway: a server that indexes headers separately answers those far faster, and the
               * OR of the three is what an unindexed server would have scanned regardless.
               */
              const uids = await client.search(
                {
                  or: [{ subject: query }, { from: query }, { text: query }],
                },
                { uid: true },
              );
              if (!uids || uids.length === 0) return { headers: [], total: 0 };

              // Highest uid last, so the tail is the newest matches. Reversed after fetching so the
              // answer reads newest first, like the listing.
              const wanted = uids.slice(-limit);
              const headers: MessageHeader[] = [];
              for await (const message of client.fetch(
                wanted,
                { uid: true, envelope: true, flags: true },
                { uid: true },
              )) {
                headers.push(headerOf(message));
              }
              // How many matched, not how many are being shown. A search that found 300 and is
              // answering with 20 has to be able to say so.
              return { headers: headers.reverse(), total: uids.length };
            });
          },
        };

        return use(session);
      });
    },

    async send(message) {
      /*
       * COMPOSED ONCE, USED TWICE. `raw` goes to SMTP and the same `raw` is appended to Sent, so
       * what the recipient holds and what the account's Sent folder holds are byte for byte the
       * same message, down to the Message-ID a Bot would verify its own send by.
       */
      const composed = await composeMessage(account, message);

      const build =
        wire.smtp ?? ((options) => createTransport(options) as SmtpLike);
      const transport = build({
        host: config.smtpHost,
        port: config.smtpPort,
        // Implicit TLS on 465, for the same reason IMAP uses it: SMTP AUTH sends the password.
        secure: true,
        auth: { user: account, pass: password },
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
      });

      try {
        await withDeadline(
          () =>
            transport.sendMail({
              envelope: composed.envelope,
              raw: composed.raw,
            }),
          () => transport.close(),
          "sending the message",
        );
      } catch (error) {
        /*
         * Two different answers, because a Bot acts on them differently. A refusal the server wrote
         * is a message that was not sent and may be corrected and sent; a server that stopped
         * answering is a message that may have been, and must not be sent again on this process's
         * say-so. See UnconfirmedSendError.
         */
        if (deliveryUnconfirmed(error)) {
          throw new UnconfirmedSendError(
            composed.messageId,
            mailServerSentence(error),
          );
        }
        throw new MailboxError(mailServerSentence(error));
      } finally {
        transport.close();
      }

      const filed = await fileInSent(composed.raw);
      return {
        messageId: composed.messageId,
        filedTo: filed.folder,
        fileError: filed.error,
      };
    },
  };

  /**
   * Put a copy of a message that has already gone out into the account's Sent folder.
   *
   * AFTER THE SEND AND NEVER IN FRONT OF IT. The mail is already delivered by the time this runs,
   * so nothing it does can stop or duplicate a delivery, and nothing it fails at is a failed send.
   * That is why every failure here is caught and RETURNED rather than thrown: a throw would reach
   * the tools as "the send failed", and a Bot told that resends a message that cannot be recalled.
   *
   * Why it is needed at all: SMTP delivers, it does not file. Without this the account's Sent
   * folder stays empty, webmail shows nothing sent, and a person checking concludes the mail was
   * never sent. That happened, to three messages that had all been delivered.
   *
   * On its own connection, inside the same per-operation deadline as everything else here, and
   * marked `\\Seen` because the account did not receive this message, it wrote it.
   */
  async function fileInSent(
    raw: Buffer,
  ): Promise<{ folder: string | null; error: string | null }> {
    try {
      return await withClient(async (client) => {
        const folder = sentFolderFrom(await client.list());
        if (!folder) {
          return { folder: null, error: "this account has no Sent folder" };
        }
        await client.append(folder, raw, ["\\Seen"], new Date());
        return { folder, error: null };
      }, "filing the copy in Sent");
    } catch (error) {
      return { folder: null, error: mailServerSentence(error) };
    }
  }
}
