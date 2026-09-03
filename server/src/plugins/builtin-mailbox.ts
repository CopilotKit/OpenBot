import type { MailboxConfig } from "../config";
import {
  createMailboxClients,
  type FullMessage,
  MAX_BODY_CHARS,
  MAX_SOURCE_BYTES,
  type MailboxClients,
  MailboxError,
  type MessageHeader,
  type MessagePage,
  type OutgoingMessage,
} from "../mailbox/client";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * The builtin transport for the Mailbox: a Bot reading and answering the deployment's mail, without
 * leaving the building.
 *
 * WHAT MAKES THIS DIFFERENT FROM ROUTINES, the other builtin. Routines has no credential at all,
 * because it acts on this deployment's own tables and the ACTOR is the authorization. This one does
 * have a credential, a mailbox password, and it is the deployment's rather than anybody's: there is one
 * mailbox, every Bot granted these tools reads the same one, and no person consents to it. So the
 * authorization here is the GRANT: an administrator decides which Bots may read the mail and which
 * may answer it, per tool, on the Plugins page, exactly as they would for a vendor's connector.
 *
 * That is why nothing below reads `connection.actorId` as permission. A run that reaches here has
 * already passed the grant check and the policy decision in `plugins/store.ts`, and there is no
 * per-person narrowing left to do: the mailbox does not have somebody's half.
 *
 * THE PASSWORD IS NEVER IN THE ENVIRONMENT and never in an answer. The hosts and the accounts come
 * from `config.ts`; each account's password comes from the encrypted credential vault, as that
 * account's own credential, resolved through {@link MailboxAccess.password} at the moment a call
 * needs it and thrown away after. {@link redacted} is the last line of that: a failure sentence
 * from a mail server that echoed the login back is scrubbed before anybody reads it.
 *
 * SEVERAL ACCOUNTS, ONE DEPLOYMENT. `support@`, `sales@` and `billing@` on the same shared host are
 * one configuration with one host pair and a password each. Which one a call works in is the
 * `account` argument, defaulting to the first configured. It changes nothing about the access
 * model: the accounts are all the deployment's, the grant is still per tool rather than per
 * account, and a Bot granted these tools reaches every one of them.
 *
 * It implements the same interface as every other transport, as module-level exports, because that
 * is the shape {@link ./transport} resolves: a `TransportKind` maps to a MODULE. Which is also why
 * the configuration and the vault arrive through {@link useMailbox} rather than a constructor: the
 * registry is built at import time, long before `index.ts` has either.
 */

/**
 * What the tools act on: where the mailbox is, how to unlock it, and how the protocols are spoken.
 *
 * `password` is a function rather than a string because a secret read once at boot is a secret held
 * in memory for the life of the process and stale the moment an administrator rotates it. Read per
 * call, a rotation takes effect on the next call and a revocation refuses it.
 */
export type MailboxAccess = {
  config: MailboxConfig;
  /**
   * That account's password from the vault, or null when this deployment holds none for it.
   *
   * Per account rather than per deployment, because a shared host gives each mailbox its own
   * login. A deployment can hold the password for one account and not another, and that is a
   * working deployment for the account it has: the answer names the account that is missing one.
   */
  password: (account: string) => Promise<string | null>;
  /**
   * How IMAP and SMTP are actually spoken. Defaults to imapflow and nodemailer.
   *
   * Injected so a test can assert what a call was about to go out with, which is the same reason
   * `PluginStoreOptions.callVendor` exists: the reply headers, the caps and the argument checking
   * are the properties worth being sure about, and asserting them otherwise would need a reachable
   * mail server.
   */
  clients?: (
    config: MailboxConfig,
    account: string,
    password: string,
  ) => MailboxClients;
};

/**
 * Which credential in the vault is one account's password.
 *
 * Here rather than at the one call site in `index.ts`, because it is a contract with two other
 * parties: the administrator who types these three values at `/admin/credentials`, and
 * `docs/mailbox.md`, which tells them to. Three strings agreeing across three places by convention
 * is how a deployment ends up holding the right secret under a key nothing reads.
 *
 * THE KEY ID IS THE ADDRESS, which is what makes several accounts possible at all: one credential
 * per configured address, so a rotation, a revocation and a missing password are each one
 * account's rather than the whole mailbox's. Lower-cased on the way in, matching what `config.ts`
 * stores, so an administrator who typed `Support@` and a caller who asked for `support@` reach the
 * same row.
 *
 * `mcp` is the kind because that is the vault's name for "the one token this deployment holds for
 * this server", which is the same kind a custom MCP server's own bearer token is stored under and
 * the same thing a mailbox password is: one secret, the deployment's, used for every Bot granted
 * the tools.
 */
export function mailboxCredentialFor(account: string): {
  kind: "mcp";
  provider: "mailbox";
  keyId: string;
} {
  return { kind: "mcp", provider: "mailbox", keyId: account.toLowerCase() };
}

let installed: MailboxAccess | null = null;

/**
 * Hand this module the mailbox, once, from the place that has the configuration and the vault.
 *
 * A module-level binding rather than a constructor argument, for the reason {@link
 * ./builtin-routines.useRoutineTools} gives: `transportFor` resolves a kind to a MODULE and there is
 * no seam to pass anything through. `null` is a supported argument, and not only for symmetry: the
 * suite is one process, so a test that installs a stub has to be able to take it back out again,
 * and a deployment with no mailbox configured installs nothing.
 */
export function useMailbox(access: MailboxAccess | null): void {
  installed = access;
}

/** The IMAP folder a tool reads when the call did not name one. */
const DEFAULT_FOLDER = "INBOX";

/** Bounds on how much mail one call may return. See {@link boundedLimit}. */
const LIST_LIMIT = { fallback: 10, max: 50 } as const;
const SEARCH_LIMIT = { fallback: 20, max: 50 } as const;

/**
 * The largest number that can be a uid, which is what IMAP's own 32-bit field allows (RFC 3501).
 *
 * Checked here so a model that produced `1e21` is told there is no such message, in the same words
 * as any other uid that is not there. Without it the number reaches imapflow, which refuses to
 * compile a sequence set out of it, and the model is handed "Invalid sequence set value" about an
 * argument it thinks of as a message number.
 */
const MAX_UID = 4_294_967_295;

/**
 * What a call answers when this deployment has no mailbox configured.
 *
 * Names all four things, including the one that is not an environment variable, because the half a
 * reader is most likely to be missing is the half that is not in `.env`. The catalogue entry stays
 * admissible and grantable without any of it (see `DeploymentConfig.mailbox`), so this sentence,
 * rather than a missing connector, is how a deployment finds out.
 */
const NOT_CONFIGURED =
  "Mailbox is not configured. Set MAILBOX_IMAP_HOST, MAILBOX_SMTP_HOST, MAILBOX_USERS and store each account's password as its mailbox credential.";

/**
 * What a call answers when the hosts are configured and the vault holds no password for the account.
 *
 * Its own sentence rather than the one above, because it is a different job with a different fix: an
 * administrator has already set the three variables and has one step left, at a different screen.
 * Telling them to set variables they can see are already set is how a correct instruction gets read
 * as a broken deployment.
 *
 * IT NAMES THE ACCOUNT, and with several of them that is the whole content of the message. A
 * deployment that stored `support@` and forgot `billing@` is working for one account and broken for
 * the other, and a sentence saying only "the mailbox" would send an administrator to look at the
 * credential that is already there.
 */
function noPassword(account: string): string {
  return `This deployment holds no password for the mailbox ${account}. An administrator has to store it as that account's mailbox credential (kind \`mcp\`, provider \`mailbox\`, key id \`${account}\`) before mail can be read or sent.`;
}

/**
 * The four tools, as the same shape a server would have answered `tools/list` with.
 *
 * THE DESCRIPTIONS CARRY THE THINGS A MODEL CANNOT SEE. Two of them matter enough to be spelled out
 * rather than implied by a field name. The first is that a uid belongs to one mailbox: a uid read
 * out of a listing of `Archive` names a different message in `INBOX`, and a model that carries one
 * across will confidently open the wrong mail. The second is that this is ONE shared mailbox rather
 * than the mailbox of whoever is asking. A Bot that believes it is reading the person's own mail
 * will summarize somebody else's inbox to them without either party ever saying so.
 */
/**
 * The `folder` argument, in the one wording all four tools use.
 *
 * IT SAYS WHAT IT IS NOT, and that sentence is the whole point of this constant. A smaller model
 * given two arguments that both read as "which mailbox" puts the email address in the wrong one:
 * observed live, a Bot passed `support@example.com` as the folder and was answered "Character not
 * allowed in mailbox name" by the IMAP server, then "Mailbox doesn't exist: support", and never
 * tried `account` at all. Naming the folder `folder`, saying it is not an address, and pointing at
 * the argument that is one costs three lines here and saves a run.
 */
const FOLDER_ARGUMENT = Object.freeze({
  type: "string",
  description: `IMAP folder to read, such as ${DEFAULT_FOLDER}, Sent or Archive. Default ${DEFAULT_FOLDER}. Leave it unset unless the person names a folder. This is not an email address, and it is not the part before the @ of one; to choose the account, use \`account\`.`,
} as const);

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_messages",
    description: [
      "List the newest messages in this deployment's mailbox, newest first: each one's uid, when it",
      "arrived, who sent it, its subject and whether it has been read. No bodies: open one with",
      "`read_message`.",
      "",
      "This is a single shared mailbox belonging to the deployment, not the mailbox of the person you are",
      "talking to. Say whose it is if it is not obvious from the conversation, and never present its",
      "contents as their own mail.",
      "",
      "`uid` values are per folder. A uid from a listing of one folder names a different message in",
      "another, so pass the same `folder` to `read_message` that you listed.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: `How many messages to list. Default ${LIST_LIMIT.fallback}, at most ${LIST_LIMIT.max}.`,
        },
        folder: FOLDER_ARGUMENT,
      },
    },
  },
  {
    name: "read_message",
    description: [
      "Open one message and read it: its headers and its text, by the uid from `list_messages` or",
      "`search_messages`.",
      "",
      "A long message is cut off and says so. Nothing is marked read, moved or deleted by opening it.",
      "",
      "Pass the same `folder` the uid came from. Uids are per folder, so a uid listed in one names a",
      "different message in another.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        uid: {
          type: "integer",
          description: "The message's uid, from a listing or a search.",
        },
        folder: FOLDER_ARGUMENT,
      },
      required: ["uid"],
    },
  },
  {
    name: "search_messages",
    description: [
      "Find messages whose subject, sender or text matches `query`, newest first. Answers with the same",
      "header lines `list_messages` does; open one with `read_message`.",
      "",
      "The match is the mail server's own, which is a plain substring search rather than a search engine:",
      "one or two distinctive words find more than a sentence does, and there is no ranking, no stemming",
      "and no boolean syntax. A search that finds nothing says so.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to look for, matched against subject, sender and message text.",
        },
        limit: {
          type: "integer",
          description: `How many matches to return. Default ${SEARCH_LIMIT.fallback}, at most ${SEARCH_LIMIT.max}.`,
        },
        folder: FOLDER_ARGUMENT,
      },
      required: ["query"],
    },
  },
  {
    name: "send_message",
    description: [
      "Send mail from this deployment's mailbox. It goes out immediately and there is nothing to recall,",
      "so read what you are about to send back to the person first whenever the wording is theirs to",
      "approve.",
      "",
      "To answer a message rather than start a new conversation, give `in_reply_to` as the uid of the",
      "message you are answering. The reply is then threaded properly in the recipient's mail client, and",
      '"Re: " is put in front of the subject if it is not already there. Without it the message opens a new',
      "thread, however the subject is worded.",
      "",
      "The sender is always the account this call works in, which is one of the deployment's own",
      "mailboxes. There is no field for it, and the mail says who it is from, so do not sign it as",
      "somebody else.",
      "",
      "Some deployments only allow mail to certain domains. If this is one of them, a recipient outside",
      "them is refused, nothing is sent, and the refusal names the domain: report that plainly rather",
      "than trying another address.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "The recipient's address. Several are separated by commas.",
        },
        subject: { type: "string", description: "The subject line." },
        body: {
          type: "string",
          description: "The message itself, as plain text.",
        },
        in_reply_to: {
          type: "integer",
          description:
            "The uid of the message this answers, so the reply threads. Omit for a new conversation.",
        },
        folder: FOLDER_ARGUMENT,
      },
      required: ["to", "subject", "body"],
    },
  },
]);

/**
 * Who this call is for, and which Bot is making it.
 *
 * The whole shared connection shape, all of it unused: there is no host to dial from a URL, no token
 * to send, and the actor is not what authorizes this one. Declared anyway because it is the
 * transport interface, and named here so the reason is written down where somebody would look for
 * a missing check.
 */
type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
};

/**
 * The list is static and needs neither a credential nor a configured mailbox.
 *
 * The four definitions are schemas in this file: nothing to discover, nobody to ask. Listing them
 * without a mailbox configured is deliberate rather than an oversight. An administrator sets a
 * connector up and grants its tools before, or instead of, the deployment ever having the secret,
 * and a tool list that emptied itself when a variable was unset would revoke grants by accident.
 */
export async function listTools(): Promise<McpTool[]> {
  const users = installed?.config.users ?? null;
  return TOOLS.map((tool) => withAccount(tool, users));
}

/**
 * One tool definition, plus the `account` argument and the sentence explaining it.
 *
 * ADDED HERE RATHER THAN WRITTEN INTO {@link TOOLS} because the choices are a deployment's, not this
 * file's. A model that is told the addresses can pick one; a model told only that an `account`
 * argument exists has to guess at a string, and a guessed address is a refusal at best. The names
 * are already in front of it in every listing this connector answers with, so naming them in the
 * description reveals nothing a granted Bot could not already read.
 *
 * The generic wording is for the deployment with no mailbox configured, where the list is still
 * answered (see {@link listTools}) and there are no addresses to name yet.
 */
function withAccount(tool: McpTool, users: readonly string[] | null): McpTool {
  const configured = users && users.length > 0 ? users : null;
  const oneOf = configured
    ? `One of: ${configured.join(", ")}.`
    : "One of the deployment's configured addresses.";
  const fallback = configured
    ? `Default ${configured[0]}.`
    : "Default is the first of them.";

  /*
   * ACCOUNT FIRST, deliberately. A model reads a schema in order, and the argument it meets first is
   * the one it reaches for when it wants to say "the support mailbox". Meeting `folder` first is how
   * an address, and then the local part of an address, ends up in it.
   */
  const properties = {
    account: {
      type: "string",
      description: `Which mailbox account to use, as its email address. ${oneOf} ${fallback}`,
    },
    ...((tool.inputSchema.properties as Record<string, unknown> | undefined) ??
      {}),
  };

  return {
    ...tool,
    description: [
      tool.description,
      "",
      `\`account\` is the email address of the mailbox to work in. ${oneOf} ${fallback} It is a different argument from \`folder\`, which names an IMAP folder such as ${DEFAULT_FOLDER}: an address belongs in \`account\` and never in \`folder\`. A uid, like a folder, belongs to one account, so do not carry one across.`,
    ].join("\n"),
    inputSchema: { ...tool.inputSchema, properties },
  };
}

export const listNeedsCredential = false;

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/** Success as a result, with the same visible cap the vendor transports use. */
function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, isError: false, truncated: false };
  }
  return {
    text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${text.length} characters]`,
    isError: false,
    truncated: true,
  };
}

/** A string argument that was actually given, or nothing. Blank is not a value. */
function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * A whole number argument, or nothing, or a refusal.
 *
 * A string of digits counts. Models produce `"42"` for an integer field often enough that refusing
 * it would be refusing a correct intention over a JSON type, and there is nothing ambiguous about
 * it. Anything else that is not a positive whole number is refused rather than rounded or coerced:
 * a uid is an identity, and `12.7` silently becoming 12 is a different message.
 */
function integerArg(
  args: Record<string, unknown>,
  key: string,
): { value?: number; error?: string } {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return {};

  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isInteger(value) || value < 1) {
    return { error: `\`${key}\` has to be a whole number, at least 1.` };
  }
  return { value };
}

/**
 * How many messages one call returns, and whether the ask was cut down.
 *
 * Capped rather than refused, which is the opposite of what this file does with a malformed number,
 * and the difference is what the number means. A malformed uid is a mistake only the model can fix;
 * "give me 200 messages" is a perfectly clear intention that this tool simply does not serve, and
 * refusing it would cost a whole extra round trip to be told a smaller number. The cap is SAID, in
 * the answer, so a model that asked for 200 and got 50 knows there may be more rather than
 * concluding the mailbox holds fifty messages.
 */
export function boundedLimit(
  asked: number | undefined,
  bounds: { fallback: number; max: number },
): { limit: number; capped: boolean } {
  if (asked === undefined) return { limit: bounds.fallback, capped: false };
  if (asked > bounds.max) return { limit: bounds.max, capped: true };
  return { limit: asked, capped: false };
}

/**
 * How a mailbox is named in an answer: the folder, and which account's folder it is.
 *
 * One function so every sentence says it the same way. The account is in all of them rather than
 * only in the ambiguous ones, because a model reading "showing 10 of 236 messages in INBOX" across
 * two accounts in one turn has no way to tell which INBOX either page came from, and will merge
 * them.
 *
 * The word "folder" is in it for the model rather than for the reader: every answer this connector
 * gives then models the vocabulary the arguments use, so the thing before "of" reads as a folder
 * and the thing after it reads as an account, in the same sentence.
 */
function where(folder: string, account: string): string {
  return `folder ${folder} of ${account}`;
}

/**
 * The sentence for a uid that names nothing, wherever it was noticed.
 *
 * One function because there are two ways to arrive at it and they are the same fact to whoever is
 * reading: the mailbox answered with no such message, or the number was never one a mailbox could
 * hold. A model told two different things about one situation will try two different fixes.
 */
function noSuchMessage(uid: number, place: string): string {
  return `There is no message with uid ${uid} in ${place}. Uids are per folder, so check the listing this one came from.`;
}

/**
 * The lines that go under a listing when there is more than it showed.
 *
 * Two separate facts, and a call can have both. "There are 4000 messages and you are seeing 10" is
 * about the mailbox; "50 is the most this tool will list" is about the tool, and only appears when
 * somebody asked for more than that. Said, because a page of ten headers with nothing else on it
 * reads to a model as the whole mailbox, and it will answer "you have ten messages" about a mailbox
 * holding four thousand.
 */
function pageNotes(
  page: MessagePage,
  capped: boolean,
  max: number,
  what: string,
): string[] {
  const notes: string[] = [];
  if (page.total > page.headers.length) {
    notes.push(
      `[showing ${page.headers.length} of ${page.total} ${what}, newest first.]`,
    );
  }
  if (capped) {
    notes.push(
      `[${max} is the most this tool lists at once, so there may be more than these.]`,
    );
  }
  return notes.length > 0 ? ["", ...notes] : [];
}

/** One message as a line in a listing. Empty fields are named, never left blank. */
function headerLine(header: MessageHeader): string {
  return [
    `uid ${header.uid}`,
    header.date ?? "no date",
    `from ${header.from || "an unnamed sender"}`,
    `"${header.subject || "(no subject)"}"`,
    header.seen ? "read" : "unread",
  ].join(" · ");
}

/**
 * One message, opened.
 *
 * The cut is stated in the body's own terms (how long it was, where it stopped) rather than as a
 * generic truncation note, because the model's next move depends on it: a message cut at 8000 of
 * 9000 characters has almost certainly said what it came to say, and one cut at 8000 of 400000 has
 * not. Same reasoning as `mcp.ts`'s cap note, applied one level down, since the whole result is
 * capped again above this.
 */
function messageInWords(message: FullMessage, place: string): string {
  const lines = [
    `uid ${message.uid} in ${place}`,
    `From: ${message.from || "an unnamed sender"}`,
    `To: ${message.to || "nobody named"}`,
    `Date: ${message.date ?? "not stated"}`,
    `Subject: ${message.subject || "(no subject)"}`,
    "",
    message.body || "This message has no readable text.",
  ];
  if (message.bodyLength > MAX_BODY_CHARS) {
    lines.push(
      "",
      `[truncated: the message body is ${message.bodyLength} characters and the first ${MAX_BODY_CHARS} are shown]`,
    );
  }
  /*
   * A different fact from a long body, and it has to be said separately.
   *
   * A cut body means this deployment holds the whole message and is showing part of it. A cut
   * SOURCE means it never read the rest off the wire, so what is missing is missing everywhere:
   * later parts, attachments, and anything a model might otherwise offer to go back for.
   */
  if (message.sourceTruncated) {
    const weight =
      message.sizeBytes === null
        ? ""
        : ` of the message's ${message.sizeBytes} bytes`;
    lines.push(
      `[only the first ${MAX_SOURCE_BYTES} bytes${weight} were read, so anything later in it, including attachments, was not seen]`,
    );
  }
  return lines.join("\n");
}

/**
 * The subject and the two headers that make a reply a reply.
 *
 * WHY THE ORIGINAL IS FETCHED RATHER THAN NAMED. Threading is done on `Message-ID`, and a model
 * cannot know one: it is a header a person never sees. Given the uid of a message that exists, the
 * ids come from the message itself, so a reply is threaded against something real or is not
 * threaded at all.
 *
 * `References` is the original's own chain with the original appended, which is RFC 5322 §3.6.4's
 * rule and the thing mail clients actually walk. A message with no `Message-ID` gets neither header:
 * an `In-Reply-To` pointing at nothing is not a reply, and inventing an id would thread the answer
 * into a conversation that does not exist.
 *
 * The subject keeps whatever the caller wrote and only gains a prefix. A reply marker already
 * there is left alone rather than stacked, and the check is not just for English: `AW:` is German,
 * `SV:` Swedish, `Antw:` Dutch and `Ref:` Italian, and a client that only knew `Re:` is how a thread
 * ends up titled `Re: AW: Re: AW: the numbers`. Case-insensitive, and tolerant of the space some
 * clients put before the colon.
 */
const REPLY_PREFIX = /^(re|aw|sv|antw|ref)\s*:/i;
export function replyFrom(
  original: Pick<FullMessage, "messageId" | "references">,
  subject: string,
): { subject: string; reply?: OutgoingMessage["reply"] } {
  const prefixed = REPLY_PREFIX.test(subject.trim())
    ? subject
    : `Re: ${subject}`.trim();
  if (!original.messageId) return { subject: prefixed };
  return {
    subject: prefixed,
    reply: {
      messageId: original.messageId,
      references: [...original.references, original.messageId],
    },
  };
}

/**
 * A sentence with the password taken out of it, in every spelling it can appear in.
 *
 * Belt and braces over a rule already kept: imapflow is built with `logger: false` and nothing in
 * this deployment prints the secret. What this covers is the sentence a SERVER wrote. Both protocols
 * quote the offending command back on a failed login, and nodemailer appends the raw SMTP reply to
 * its error message, so the credential can arrive here inside somebody else's words. That text goes
 * into an audit row and in front of a model, and neither is a place for the mailbox password.
 *
 * THE BASE64 FORMS ARE NOT PARANOIA, they are the common case. Neither client prefers plaintext
 * `LOGIN`: imapflow authenticates with `AUTH=PLAIN` when the server offers it and falls back to
 * `AUTH=LOGIN`, and both put the credential on the wire base64-encoded. So a quoted command carries
 * `base64("\0user\0password")` or `base64(password)` rather than the password as typed, and a
 * redaction that only knew the plaintext would pass it through unchanged while looking like it
 * worked.
 *
 * A short or empty password is skipped rather than replaced everywhere, since replacing a
 * one-character string would redact half the alphabet out of an unrelated message.
 */
export function redacted(
  message: string,
  password: string | null,
  user?: string,
): string {
  if (!password || password.length < 4) return message;

  const base64 = (value: string) =>
    Buffer.from(value, "utf8").toString("base64");
  const forms = [
    password,
    // AUTH=LOGIN sends the password on its own line.
    base64(password),
    // AUTH=PLAIN sends authzid, authcid and password as one NUL-separated blob.
    ...(user ? [base64(`\u0000${user}\u0000${password}`)] : []),
  ];

  let scrubbed = message;
  for (const form of forms) {
    if (form.length < 4) continue;
    scrubbed = scrubbed.split(form).join("[redacted]");
  }
  return scrubbed;
}

/**
 * The recipient domains this deployment will not send to, out of a `to` field.
 *
 * Returned rather than thrown, and returned as the DOMAINS rather than as a yes or no, because the
 * refusal has to name what was wrong: a model told only that the recipient was refused will try
 * another address, and one told the domain will say plainly that this deployment does not mail
 * outside it.
 *
 * `to` is what the model wrote, so this parses defensively: comma-separated, each part either a bare
 * address or `Name <address>`. Anything with no `@`, or nothing after it, is reported as an offender
 * too, because an unparseable recipient is not a recipient this list has cleared, and letting it
 * through to be somebody else's validation error would be a hole in a safety check.
 *
 * An empty allowlist means unrestricted and is answered before any parsing.
 */
export function refusedRecipients(
  to: string,
  allowed: ReadonlySet<string>,
): string[] {
  if (allowed.size === 0) return [];

  const refused: string[] = [];
  for (const part of to.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const angled = /<([^>]*)>/.exec(trimmed);
    const address = (angled ? angled[1] : trimmed).trim();
    const at = address.lastIndexOf("@");
    const domain = at === -1 ? "" : address.slice(at + 1).toLowerCase();
    if (domain === "" || !allowed.has(domain)) {
      refused.push(domain === "" ? address : domain);
    }
  }
  return [...new Set(refused)];
}

/**
 * Which account this call works in.
 *
 * Unset is the first configured account, which is what makes `account` an argument a model may
 * ignore: the common deployment has one mailbox and never sees this.
 *
 * AN ACCOUNT THAT IS NOT CONFIGURED IS REFUSED HERE, before a password is read and long before
 * anything is dialled, and the refusal lists the ones that exist. Two reasons. A model that
 * invented an address should be corrected rather than handed a login failure from a mail server,
 * which is a sentence about credentials for a mailbox that does not exist; and `send_message` must
 * not reach the network on a mistaken argument, since the interesting mistake is a Bot that was
 * talked into naming an account by the mail it just read.
 *
 * Matched case-insensitively, because the configured list is lower-cased and an address is.
 */
export function selectAccount(
  args: Record<string, unknown>,
  users: readonly string[],
): { account?: string; error?: string } {
  const asked = stringArg(args, "account");
  if (asked === undefined) return { account: users[0] };

  const wanted = asked.toLowerCase();
  if (!users.includes(wanted)) {
    return {
      error: `${asked} is not one of this deployment's mailbox accounts. It has ${users.join(", ")}. Nothing was read and nothing was sent.`,
    };
  }
  return { account: wanted };
}

/**
 * Which IMAP folder this call reads, and the one mistake worth catching by hand.
 *
 * AN ADDRESS IN `folder` IS REFUSED HERE, before the vault and before the network. It is the
 * mistake a smaller model actually makes: two arguments that both read as "which mailbox", and the
 * address goes in the wrong one. Left to the mail server it comes back as "Character not allowed in
 * mailbox name: '.'" and then "Mailbox doesn't exist: support", which are sentences about IMAP
 * folder naming that no model turns into "use the other argument". Said here, the fix is in the
 * refusal.
 *
 * THE LOCAL PART IS THE SECOND HALF OF THE SAME MISTAKE, and it was made live: refused an address
 * in `folder`, the model retried with `support`, then `webmaster`, which are the parts before the @
 * of two configured accounts. That is not an address any more, so the check above lets it through,
 * and the mail server answers "Mailbox doesn't exist: support", which reads as a folder that is
 * merely missing rather than as an argument that is wrong. A folder genuinely named after an
 * account's local part is possible and is given up here on purpose: the mistake is common and the
 * collision is not.
 *
 * `mailbox` is still read as a name for the same argument. This connector shipped with that key,
 * and a Bot holding a tool list from before the rename would otherwise pass a folder that is
 * silently ignored and read INBOX while believing it read Archive. Both checks cover it either
 * way, so the old name cannot reintroduce the trap.
 */
export function selectFolder(
  args: Record<string, unknown>,
  users: readonly string[],
): { folder?: string; error?: string } {
  const asked = stringArg(args, "folder") ?? stringArg(args, "mailbox");
  if (asked === undefined) return { folder: DEFAULT_FOLDER };
  if (asked.includes("@")) {
    return {
      error: `${asked} looks like an email address, and \`folder\` names an IMAP folder such as ${DEFAULT_FOLDER}. Pass the address as \`account\` instead. Nothing was read and nothing was sent.`,
    };
  }

  const wanted = asked.toLowerCase();
  const named = users.find((user) => user.split("@")[0] === wanted);
  if (named) {
    return {
      error: `${asked} is the account ${named}, not a folder. Pass account=${named} and leave folder unset to read ${DEFAULT_FOLDER}. Nothing was read and nothing was sent.`,
    };
  }
  return { folder: asked };
}

/**
 * Which account and which folder, together, because the interesting case is a mistake across both.
 *
 * THE ADOPTION. A model that puts a configured address in `folder` has said something unambiguous:
 * there is exactly one mailbox it can mean, and it named it. Refusing that costs a whole turn to
 * learn a vocabulary lesson, and live runs show the FIRST mailbox call of a turn making this
 * mistake, so the lesson is paid for before any work happens. So the address is taken as the
 * account, the folder falls back to {@link DEFAULT_FOLDER}, and the answer says what was done. The
 * note teaches the same lesson the refusal did, on the way past rather than instead of the work.
 *
 * WHAT IS STILL REFUSED, because neither is unambiguous:
 *
 * - An address in `folder` that is NOT a configured account. There is nothing to adopt: the model
 *   is asking for a mailbox this deployment does not have, and guessing which one it meant would
 *   read somebody else's mail to answer a question about a mailbox that is not there.
 * - `folder` holding one configured address while `account` names a different one. Two arguments
 *   naming two mailboxes is a model that has lost track of which it is reading, and picking either
 *   would be picking for it. The refusal names both.
 *
 * The local-part refusal in {@link selectFolder} is deliberately left alone. `support` is not an
 * address, and a folder genuinely called `support` can exist, so adopting it would be guessing
 * where the address case is certain.
 */
export function selectMailbox(
  args: Record<string, unknown>,
  users: readonly string[],
): { account?: string; folder?: string; note?: string; error?: string } {
  const askedFolder = stringArg(args, "folder") ?? stringArg(args, "mailbox");
  const adopted = askedFolder?.toLowerCase();

  if (adopted !== undefined && users.includes(adopted)) {
    const askedAccount = stringArg(args, "account")?.toLowerCase();
    if (askedAccount !== undefined && askedAccount !== adopted) {
      return {
        error: `folder is ${askedFolder}, which is the account ${adopted}, while account is ${askedAccount}. Those are two different mailboxes and this call names no folder at all. Pass the one you mean as \`account\` and leave \`folder\` unset. Nothing was read and nothing was sent.`,
      };
    }
    return {
      account: adopted,
      folder: DEFAULT_FOLDER,
      note: `[folder took the address ${adopted}; it was used as account, reading ${DEFAULT_FOLDER}.]`,
    };
  }

  const account = selectAccount(args, users);
  if (account.error || !account.account) return { error: account.error };
  const folder = selectFolder(args, users);
  if (folder.error || !folder.folder) return { error: folder.error };
  return { account: account.account, folder: folder.folder };
}

/**
 * Call one tool.
 *
 * The grant and the policy are already settled by the time anything gets here: `plugins/store.ts`
 * checks what this Bot was given and evaluates the policy against the tool's effect, exactly as it
 * does for a vendor's server. There is no second path to the mailbox and nothing here re-decides
 * any of that.
 *
 * The audit row follows the same order as every other connector's, which is attempt first and
 * record second: a refusal is the only row written before this runs, and the outcome row is
 * written after it returns, on what happened rather than on what was permitted. For `send_message`
 * that leaves a window a Bot never sees and an operator should know about: a process that dies
 * between the server accepting the message and the row going down has delivered a message the
 * trail does not hold. The Sent copy is the record that survives it, which is one more reason the
 * copy is filed at all.
 *
 * Nothing thrown escapes. A mail server that refused, timed out or answered nonsense comes back as
 * an `isError` result rather than as a throw, which is what the vendor transports do and what
 * `plugins/tools.ts` expects: it prefixes the sentence with "The vendor reported an error: " and the
 * sentence survives intact, which is the part that matters to whoever reads the transcript.
 */
export async function callTool(
  _connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const access = installed;
  if (!access) return failure(NOT_CONFIGURED);

  const chosen = selectMailbox(args, access.config.users);
  if (chosen.error || !chosen.account || !chosen.folder) {
    return failure(chosen.error ?? NOT_CONFIGURED);
  }
  const { account, folder, note } = chosen;

  const result = await runTool(access, account, folder, toolName, args);
  if (!note) return result;
  /*
   * The note rides on the answer rather than replacing it. A model that is told what it did wrong
   * AND handed the mail it asked for learns the argument without spending a turn on the lesson,
   * which is the whole point of adopting the address instead of refusing it.
   */
  return { ...result, text: `${note}\n${result.text}` };
}

/** The work itself, once the account and the folder are settled. */
async function runTool(
  access: MailboxAccess,
  account: string,
  folder: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  let password: string | null = null;
  /*
   * THE VAULT IS READ AFTER THE ARGUMENTS ARE CHECKED, not before.
   *
   * Every refusal a tool can make on its own arguments, a missing uid, an empty body, a recipient
   * the allowlist does not cover, is made before this is called, so a call that was never going to
   * reach a server also never decrypts the secret it would have reached it with. The password is
   * the one thing here that is worth not touching for nothing, and a refused recipient in
   * particular is the case where the argument came from the mail a Bot just read.
   */
  const unlock = async (): Promise<MailboxClients | null> => {
    password = await access.password(account);
    if (!password) return null;
    return (access.clients ?? createMailboxClients)(
      access.config,
      account,
      password,
    );
  };
  try {
    // The folder and whose folder, which is how every sentence below names it. See `where`.
    const place = where(folder, account);

    if (toolName === "list_messages") {
      const asked = integerArg(args, "limit");
      if (asked.error) return failure(asked.error);
      const { limit, capped } = boundedLimit(asked.value, LIST_LIMIT);

      const clients = await unlock();
      if (!clients) return failure(noPassword(account));
      const page = await clients.withSession((session) =>
        session.recent(folder, limit),
      );
      if (page.headers.length === 0) {
        // Said in words rather than returned as an empty string: an empty result reads to a model
        // as "the tool had nothing to say" and gets filled in from memory.
        return asResult(`There are no messages in ${place}.`);
      }
      return asResult(
        [
          ...page.headers.map((header) => `- ${headerLine(header)}`),
          ...pageNotes(page, capped, LIST_LIMIT.max, `messages in ${place}`),
        ].join("\n"),
      );
    }

    if (toolName === "read_message") {
      const uid = integerArg(args, "uid");
      if (uid.error) return failure(uid.error);
      if (uid.value === undefined) {
        return failure(
          "Say which message to read, by the uid from list_messages or search_messages.",
        );
      }
      // A number no mailbox could hold is a message that is not there, and is answered as one
      // rather than dialled and turned into a sequence-set complaint. See MAX_UID.
      if (uid.value > MAX_UID) {
        return failure(noSuchMessage(uid.value, place));
      }

      const clients = await unlock();
      if (!clients) return failure(noPassword(account));
      const message = await clients.withSession((session) =>
        session.message(folder, uid.value as number),
      );
      if (!message) {
        return failure(noSuchMessage(uid.value, place));
      }
      return asResult(messageInWords(message, place));
    }

    if (toolName === "search_messages") {
      const query = stringArg(args, "query");
      if (!query) return failure("Say what to search the mailbox for.");
      const asked = integerArg(args, "limit");
      if (asked.error) return failure(asked.error);
      const { limit, capped } = boundedLimit(asked.value, SEARCH_LIMIT);

      const clients = await unlock();
      if (!clients) return failure(noPassword(account));
      const page = await clients.withSession((session) =>
        session.search(folder, query, limit),
      );
      if (page.headers.length === 0) {
        return asResult(
          `Nothing in ${place} matches "${query}". There is nothing here to answer from.`,
        );
      }
      return asResult(
        [
          ...page.headers.map((header) => `- ${headerLine(header)}`),
          ...pageNotes(page, capped, SEARCH_LIMIT.max, `matches in ${place}`),
        ].join("\n"),
      );
    }

    if (toolName === "send_message") {
      const to = stringArg(args, "to");
      if (!to) return failure("Say who the message is to.");
      const subject = stringArg(args, "subject");
      if (!subject) return failure("A message needs a subject.");
      const body = stringArg(args, "body");
      if (!body) return failure("A message needs something in it.");

      /*
       * WHERE IT IS GOING IS DECIDED BEFORE ANYTHING IS DIALLED OR UNLOCKED.
       *
       * First, so a refused recipient costs no connection, touches no mailbox and reads no
       * password out of the vault: this is the check that stands between a Bot that was talked
       * into something by the mail it just read and an address outside the deployment, and the
       * secret it would have used stays sealed. Naming the domain rather than the address, because
       * the domain is the thing the allowlist is written about and the thing an administrator would
       * change.
       */
      const refused = refusedRecipients(
        to,
        access.config.allowedRecipientDomains,
      );
      if (refused.length > 0) {
        return failure(
          `This deployment only sends mail to ${[...access.config.allowedRecipientDomains].sort().join(", ")}, and ${refused.join(", ")} is not among them. Nothing was sent. An administrator sets MAILBOX_ALLOWED_RECIPIENT_DOMAINS.`,
        );
      }

      const inReplyTo = integerArg(args, "in_reply_to");
      if (inReplyTo.error) return failure(inReplyTo.error);
      // The same answer a uid that is not there gets, for the same reason as `read_message`, and
      // with the same promise that nothing was sent.
      if (inReplyTo.value !== undefined && inReplyTo.value > MAX_UID) {
        return failure(
          `There is no message with uid ${inReplyTo.value} in ${place}, so there is nothing to reply to. Nothing was sent.`,
        );
      }

      const clients = await unlock();
      if (!clients) return failure(noPassword(account));

      let outgoing: OutgoingMessage = { to, subject, body };
      if (inReplyTo.value !== undefined) {
        const original = await clients.withSession((session) =>
          session.message(folder, inReplyTo.value as number),
        );
        /*
         * Refused rather than sent as a new message. A model that asked for a reply and got an
         * unthreaded mail to the same person has been told the wrong thing about what it did, and
         * the recipient sees an answer that appears to be about nothing.
         */
        if (!original) {
          return failure(
            `There is no message with uid ${inReplyTo.value} in ${place}, so there is nothing to reply to. Nothing was sent.`,
          );
        }
        const threaded = replyFrom(original, subject);
        outgoing = {
          to,
          subject: threaded.subject,
          body,
          ...(threaded.reply ? { reply: threaded.reply } : {}),
        };
      }

      const sent = await clients.send(outgoing);
      return asResult(
        [
          `Sent from ${account} to ${to}, subject "${outgoing.subject}".`,
          outgoing.reply
            ? "It threads as a reply to that message."
            : "It starts a new thread.",
          /*
           * WHERE THE COPY WENT, or why there is none, and never as a failure.
           *
           * Naming the folder is what lets a Bot check its own work: it can list that folder and
           * find the message it just sent. The other branch is the one that matters more. Filing is
           * a separate operation against a separate server and can fail after the mail has gone, so
           * it says plainly that the mail WAS sent. A model told only that something failed sends
           * the message again, and mail cannot be recalled.
           */
          sent.filedTo
            ? `A copy is in folder ${sent.filedTo}.`
            : `The mail was sent, but no copy could be filed in the Sent folder (${redacted(sent.fileError ?? "no reason given", password, account).slice(0, 200)}). It was delivered, so do not send it again.`,
          sent.messageId ? `Message id ${sent.messageId}.` : null,
        ]
          .filter((one): one is string => one !== null)
          .join(" "),
      );
    }

    return failure(
      `${toolName} is not a tool Mailbox implements. The stored tool list is out of date; refresh it on the Plugins page.`,
    );
  } catch (error) {
    /*
     * The mail server's own sentence, scrubbed of the password and nothing else.
     *
     * It is the most useful thing available, since "Invalid credentials", "Mailbox does not exist"
     * and "Relay access denied" each name a different fix, and rewording it here would turn a
     * specific failure into a vague one. Capped, because a failure is not a promise about length.
     */
    const message =
      error instanceof MailboxError || error instanceof Error
        ? error.message
        : String(error);
    return failure(redacted(message, password, account).slice(0, 400));
  }
}
