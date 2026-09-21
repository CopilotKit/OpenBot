/**
 * Gmail over IMAP, as a vendor transport.
 *
 * WHY IMAP AND NOT GOOGLE'S MCP SERVER. Google's Gmail MCP server is gated behind the Workspace
 * Developer Preview, which a personal `@gmail.com` account cannot join at all -- there is no admin
 * console to enable it in. The same reasoning that produced `google-drive-rest` applies here, one
 * step further: Drive fell back to Google's GA REST API, and Gmail falls back to IMAP.
 *
 * WHY IMAP AND NOT THE GMAIL REST API. The REST route wants `gmail.readonly` + `gmail.compose`, both
 * of which Google classifies as RESTRICTED scopes. An unverified app using them is stuck in Testing
 * publishing status, where refresh tokens expire every seven days. A dispute that runs for a month
 * would need the account reconnected four or five times, and a routine whose credential died on day
 * eight fails silently until somebody notices no drafts arriving. An app password does not expire.
 *
 * THE PROPERTY THAT MATTERS. IMAP cannot send mail. Sending is SMTP -- a different protocol, a
 * different port, a different client -- and this module does not speak it and does not import a
 * library that does. The draft-only guarantee therefore does not rest on the grant list, the CEL
 * policy or the model's cooperation: those are defence in depth over a credential that is physically
 * incapable of sending. A draft is written with IMAP APPEND into [Gmail]/Drafts, and a human presses
 * Send in Gmail, where the sending actually lives.
 *
 * The MIME for a draft is built by hand rather than with a mail library. Every such library exists to
 * send, and pulling one in would put an SMTP transport one import away from a module whose whole
 * point is not having one. Building a few headers and a text/plain body is not the hard part.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { McpCallResult, McpTool } from "./mcp";

const HOST = "imap.gmail.com";
const PORT = 993;

/** Gmail's own drafts folder. Localised in some accounts; resolved via the \Drafts special-use flag. */
const DRAFTS_FALLBACK = "[Gmail]/Drafts";

/** A thread listing is for orientation, not archaeology. */
const MAX_THREAD_MESSAGES = 30;
const MAX_SEARCH_RESULTS = 20;

/**
 * How much of one message body is worth handing a model.
 *
 * A vendor's reply is short; a thread that has been forwarded nine times is not, and most of it is
 * quoted history the model already saw in earlier messages of the same thread. Truncation is marked
 * so the model can say the body was cut rather than quietly reasoning from half an email.
 */
const MAX_BODY_CHARS = 4_000;

type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
};

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "search_threads",
    description:
      "Search the mailbox for threads matching a query. Use for finding a dispute thread by vendor name, order number or subject. Returns thread ids, subjects, participants and dates, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Words to search for in subject, sender and body. For example a vendor name or an order number.",
        },
        since: {
          type: "string",
          description:
            "Optional ISO date. Only threads with activity on or after this date.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_thread",
    description:
      "Read every message in one thread, oldest first, with sender, date and body. This is how you see what the vendor actually said.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Thread id from search_threads.",
        },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "get_message",
    description: "Read one message by id, with its full headers and body.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "Message id from get_thread or search_threads.",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "list_drafts",
    description:
      "List drafts currently waiting in the drafts folder, newest first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_draft",
    description:
      "Save a reply as a draft for a human to review and send. This does NOT send anything: it writes the message into the drafts folder, and a person presses Send. Give reply_to_message_id so the draft joins the right thread.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: {
          type: "string",
          description:
            "Subject line. Keep the thread's subject to stay in-thread.",
        },
        body: { type: "string", description: "Plain text body of the reply." },
        reply_to_message_id: {
          type: "string",
          description:
            "The Message-ID of the message being replied to, from get_thread. Without it the draft starts a new thread instead of continuing the dispute.",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "update_draft",
    description:
      "Replace an existing draft with new text. Use after a person asks for a change, rather than leaving several near-identical drafts behind.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string", description: "Draft id from list_drafts." },
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Subject line." },
        body: { type: "string", description: "Replacement plain text body." },
        reply_to_message_id: {
          type: "string",
          description: "Message-ID this reply belongs to.",
        },
      },
      required: ["draft_id", "to", "subject", "body"],
    },
  },
]);

/**
 * False, as for every adapter whose tool list is this file.
 *
 * See the note on {@link VendorTransport.listNeedsCredential}: answering true would send an
 * administrator off to connect an account purely so a credential could be minted, passed to the
 * function below, and ignored.
 */
export const listNeedsCredential = false;

export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

/**
 * The stored credential, as `address:app-password`.
 *
 * IMAP needs a username as well as a secret, and the credential store holds one opaque string per
 * connector. Splitting on the LAST colon rather than the first: an app password contains no colon,
 * an email address contains no colon, but insisting on the first would mangle any future value that
 * did. The address is not inferred from the signed-in person, because the mailbox holding a dispute
 * is not necessarily the mailbox of whoever is reading the channel.
 */
function credential(
  token: string | undefined,
): { user: string; pass: string } | null {
  if (!token) return null;
  const at = token.lastIndexOf(":");
  if (at <= 0 || at === token.length - 1) return null;
  const user = token.slice(0, at).trim();
  const pass = token.slice(at + 1).trim();
  if (!user.includes("@") || pass.length === 0) return null;
  return { user, pass };
}

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/**
 * Empty is an answer, and saying so beats returning a blank the model has to interpret.
 *
 * `truncated` reports only the caps this module applied (body length, thread and result counts),
 * which are already marked inline where they bite.
 */
const asResult = (text: string, truncated = false): McpCallResult => {
  const joined = text.trim();
  if (joined === "") {
    return {
      text: "The tool returned no content. Nothing was found, so there is nothing here to answer from.",
      isError: false,
      truncated: false,
    };
  }
  return { text: joined, isError: false, truncated };
};

/**
 * Open a connection, do the work, close it -- even when the work throws.
 *
 * One connection per call rather than a pool. Gmail caps simultaneous IMAP connections per account
 * and drops the oldest without warning when the cap is passed, which turns a pool into an
 * intermittent, unattributable failure. A routine firing twice a day does not need a pool.
 */
async function withClient<T>(
  token: string | undefined,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T | McpCallResult> {
  const auth = credential(token);
  if (!auth) {
    return failure(
      "Gmail is not connected, or the stored credential is not in the form `you@gmail.com:app-password`. " +
        "An administrator sets it at /admin/credentials.",
    );
  }

  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: auth.user, pass: auth.pass },
    logger: false,
    // Gmail closes an idle connection eventually; this work is short and does not need IDLE.
    emitLogs: false,
  });

  try {
    await client.connect();
    return await work(client);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/AUTHENTICATIONFAILED|Invalid credentials/i.test(message)) {
      return failure(
        "Gmail rejected the credential. Check that 2-Step Verification is on, that the app password " +
          "has not been revoked, and that IMAP is enabled in Gmail settings.",
      );
    }
    if (/\[ALERT\].*IMAP.*disabled|IMAP access is disabled/i.test(message)) {
      return failure(
        "IMAP is switched off for this account. Gmail settings, Forwarding and POP/IMAP, Enable IMAP.",
      );
    }
    return failure(`Gmail could not be reached: ${message}`);
  } finally {
    try {
      await client.logout();
    } catch {
      // A failed logout on an already-broken socket is not worth reporting over the real error.
    }
  }
}

/** Gmail exposes its own thread id over IMAP as X-GM-THRID, which is what makes threads addressable. */
type ImapMessage = {
  uid: number;
  emailId?: string;
  threadId?: string;
  envelope?: {
    subject?: string;
    date?: Date;
    from?: { name?: string; address?: string }[];
    to?: { name?: string; address?: string }[];
    messageId?: string;
  };
  source?: Buffer;
};

function addressList(
  list: { name?: string; address?: string }[] | undefined,
): string {
  if (!list?.length) return "(none)";
  return list
    .map((a) =>
      a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "(unknown)"),
    )
    .join(", ");
}

function truncate(text: string): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= MAX_BODY_CHARS) return clean;
  return `${clean.slice(0, MAX_BODY_CHARS)}\n\n[... body truncated at ${MAX_BODY_CHARS} characters ...]`;
}

async function renderMessage(message: ImapMessage): Promise<string> {
  const env = message.envelope ?? {};
  const header = [
    `Message-ID: ${env.messageId ?? "(none)"}`,
    `From: ${addressList(env.from)}`,
    `To: ${addressList(env.to)}`,
    `Date: ${env.date ? env.date.toISOString() : "(unknown)"}`,
    `Subject: ${env.subject ?? "(no subject)"}`,
  ].join("\n");

  if (!message.source) return `${header}\n\n(body not fetched)`;

  const parsed = await simpleParser(message.source);
  const body = parsed.text ?? (parsed.html ? stripHtml(parsed.html) : "");
  return `${header}\n\n${truncate(body || "(empty body)")}`;
}

/**
 * Last resort for a message with no text/plain part.
 *
 * Not a sanitiser and not trying to be: nothing here is rendered as HTML, it is handed to a model as
 * text. Tags out, entities that matter decoded, whitespace collapsed.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Build RFC 5322 for a draft.
 *
 * `In-Reply-To` and `References` are what put the draft in the vendor's thread instead of starting a
 * new one; a dispute that splits into two threads is how context gets lost at the vendor's end.
 * The body is encoded base64 so that a quoted policy clause with an em dash or a pound sign survives
 * the trip -- 8-bit bytes in a raw APPEND are not reliably preserved.
 */
function buildDraft(args: {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  from: string;
}): Buffer {
  const headers = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (args.replyTo) {
    headers.push(`In-Reply-To: ${args.replyTo}`, `References: ${args.replyTo}`);
  }
  const encoded = Buffer.from(args.body, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${encoded}\r\n`, "utf8");
}

/**
 * `search` answers `false` when the server declines rather than when nothing matched.
 *
 * Both mean "no uids to fetch" to every caller here, and flattening them at one place keeps the
 * distinction from being re-derived, wrongly, at four call sites.
 */
async function searchUids(
  client: ImapFlow,
  criteria: Parameters<ImapFlow["search"]>[0],
): Promise<number[]> {
  const found = await client.search(criteria, { uid: true });
  return Array.isArray(found) ? found : [];
}

/** Find the drafts mailbox by its special-use flag, falling back to Gmail's English default. */
async function draftsMailbox(client: ImapFlow): Promise<string> {
  try {
    for (const box of await client.list()) {
      if (box.specialUse === "\\Drafts") return box.path;
    }
  } catch {
    // A list that fails is not fatal; the fallback is right for almost every account.
  }
  return DRAFTS_FALLBACK;
}

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const str = (key: string): string => {
    const value = args[key];
    return typeof value === "string" ? value.trim() : "";
  };

  const result = await withClient(connection.token, async (client) => {
    switch (toolName) {
      case "search_threads": {
        const query = str("query");
        if (!query) return failure("search_threads needs a query.");
        const lock = await client.getMailboxLock("INBOX");
        try {
          const criteria: Record<string, unknown> = {
            or: [{ subject: query }, { body: query }, { from: query }],
          };
          const since = str("since");
          if (since) {
            const date = new Date(since);
            if (!Number.isNaN(date.getTime())) criteria.since = date;
          }
          const uids = await searchUids(client, criteria);
          if (!uids.length) return asResult(`No threads matched "${query}".`);

          const newest = uids.slice(-MAX_SEARCH_RESULTS).reverse();
          const lines: string[] = [];
          for await (const message of client.fetch(
            newest,
            { uid: true, envelope: true, threadId: true },
            { uid: true },
          )) {
            const m = message as unknown as ImapMessage;
            const env = m.envelope ?? {};
            lines.push(
              [
                `thread_id: ${m.threadId ?? "(none)"}`,
                `message_id: ${env.messageId ?? "(none)"}`,
                `from: ${addressList(env.from)}`,
                `date: ${env.date ? env.date.toISOString() : "(unknown)"}`,
                `subject: ${env.subject ?? "(no subject)"}`,
              ].join(" | "),
            );
          }
          return asResult(
            `${lines.length} thread(s) matching "${query}", newest first:\n\n${lines.join("\n")}`,
          );
        } finally {
          lock.release();
        }
      }

      case "get_thread": {
        const threadId = str("thread_id");
        if (!threadId) return failure("get_thread needs a thread_id.");
        const lock = await client
          .getMailboxLock("[Gmail]/All Mail")
          .catch(() => client.getMailboxLock("INBOX"));
        try {
          const uids = await searchUids(client, { threadId });
          if (!uids.length)
            return asResult(`No messages in thread ${threadId}.`);

          const rendered: string[] = [];
          for await (const message of client.fetch(
            uids.slice(0, MAX_THREAD_MESSAGES),
            { uid: true, envelope: true, source: true },
            { uid: true },
          )) {
            rendered.push(
              await renderMessage(message as unknown as ImapMessage),
            );
          }
          const note =
            uids.length > MAX_THREAD_MESSAGES
              ? `\n\n[thread has ${uids.length} messages; showing the first ${MAX_THREAD_MESSAGES}]`
              : "";
          return asResult(
            `Thread ${threadId}, ${uids.length} message(s), oldest first:\n\n${rendered.join(
              "\n\n---\n\n",
            )}${note}`,
          );
        } finally {
          lock.release();
        }
      }

      case "get_message": {
        const messageId = str("message_id");
        if (!messageId) return failure("get_message needs a message_id.");
        const lock = await client
          .getMailboxLock("[Gmail]/All Mail")
          .catch(() => client.getMailboxLock("INBOX"));
        try {
          const uids = await searchUids(client, {
            header: { "message-id": messageId },
          });
          if (!uids.length) return asResult(`No message with id ${messageId}.`);
          for await (const message of client.fetch(
            [uids[uids.length - 1]],
            { uid: true, envelope: true, source: true },
            { uid: true },
          )) {
            return asResult(
              await renderMessage(message as unknown as ImapMessage),
            );
          }
          return asResult(`No message with id ${messageId}.`);
        } finally {
          lock.release();
        }
      }

      case "list_drafts": {
        const box = await draftsMailbox(client);
        const lock = await client.getMailboxLock(box);
        try {
          const uids = await searchUids(client, { all: true });
          if (!uids.length) return asResult("No drafts waiting.");
          const lines: string[] = [];
          for await (const message of client.fetch(
            uids.slice(-MAX_SEARCH_RESULTS).reverse(),
            { uid: true, envelope: true },
            { uid: true },
          )) {
            const m = message as unknown as ImapMessage;
            const env = m.envelope ?? {};
            lines.push(
              `draft_id: ${m.uid} | to: ${addressList(env.to)} | date: ${
                env.date ? env.date.toISOString() : "(unknown)"
              } | subject: ${env.subject ?? "(no subject)"}`,
            );
          }
          return asResult(
            `${lines.length} draft(s), newest first:\n\n${lines.join("\n")}`,
          );
        } finally {
          lock.release();
        }
      }

      case "create_draft":
      case "update_draft": {
        const to = str("to");
        const subject = str("subject");
        const body = str("body");
        if (!to || !subject || !body) {
          return failure(`${toolName} needs to, subject and body.`);
        }
        const auth = credential(connection.token);
        if (!auth) return failure("Gmail is not connected.");

        const box = await draftsMailbox(client);
        const replyTo = str("reply_to_message_id");
        const raw = buildDraft({
          to,
          subject,
          body,
          replyTo: replyTo || undefined,
          from: auth.user,
        });

        const lock = await client.getMailboxLock(box);
        try {
          // Replace-by-append-then-delete, in that order. The new draft exists before the old one is
          // removed, so a failure halfway leaves two drafts rather than none: a duplicate is a
          // nuisance, a lost draft is somebody's work gone.
          const appended = await client.append(box, raw, ["\\Draft", "\\Seen"]);
          if (toolName === "update_draft") {
            const draftId = str("draft_id");
            if (draftId) {
              try {
                await client.messageDelete([Number(draftId)], { uid: true });
              } catch {
                return asResult(
                  `Saved the new draft, but could not remove the old one (draft_id ${draftId}). ` +
                    "Both are in the drafts folder; delete the stale one by hand.",
                );
              }
            }
          }
          const uid =
            appended && typeof appended === "object" && "uid" in appended
              ? appended.uid
              : "";
          return asResult(
            `Draft saved in ${box}${uid ? ` (draft_id ${uid})` : ""}. It has NOT been sent. ` +
              "Open Gmail, review it in Drafts, and press Send.",
          );
        } finally {
          lock.release();
        }
      }

      default:
        // Reached only if the stored tool list and this file have drifted apart.
        return failure(`Unknown Gmail tool: ${toolName}`);
    }
  });

  return result as McpCallResult;
}
