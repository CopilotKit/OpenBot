import { cutAtCodeUnits } from "../channels/text";
import { isAddress } from "../mail/providers";
import {
  installedMailService,
  type MailMessage,
  MailRefusedError,
  type MailSummary,
} from "../mail/service";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * The builtin transport for Email: a Bot reading, searching and sending from its owner's OWN
 * mailbox, logged in directly with the app password they saved under Settings, Email. No vendor and
 * no broker in between, the same shape as Routines.
 *
 * Like Routines, the ACTOR is the authorization: the mailbox is the person's whose run this is, read
 * off the connection and never out of the arguments, so a model cannot name somebody else's inbox.
 *
 * Reading never changes the mailbox (nothing is marked read or moved). `send_email` is the one write
 * tool, listed in the catalogue's `writeTools`, so the action policy governs it like any other write:
 * a new grant starts on asking first. The emails a Bot reads are other people's words, and the tool
 * result is marked as untrusted data by `plugins/tools.ts` before the model sees it.
 */

const FOLDER = {
  type: "string",
  description:
    'The mailbox folder. Defaults to "INBOX". Gmail also has "[Gmail]/Sent Mail" and "[Gmail]/All Mail".',
};

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_emails",
    description:
      "List the newest emails in the person's own mailbox: who from, the subject, when, and whether it is unread. Use read_email with an email's uid to read it. Reading does not mark anything as read.",
    inputSchema: {
      type: "object",
      properties: {
        folder: FOLDER,
        unread_only: {
          type: "boolean",
          description: "Only unread emails. Defaults to false.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "How many, newest first. Defaults to 10.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_emails",
    description:
      "Search the person's own mailbox for emails that mention some words or come from someone, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Words to look for, or part of a sender's name or address.",
        },
        folder: FOLDER,
        limit: { type: "integer", minimum: 1, maximum: 25 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_email",
    description:
      "Read one email in full by its uid (from list_emails or search_emails): sender, recipients, subject, date, the text, and the names of any attachments.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "integer", minimum: 1 },
        folder: FOLDER,
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "send_email",
    description:
      "Send an email from the person's own address. Only send what the person asked for, to the people they named. To reply, pass the email's message id as in_reply_to and start the subject with \"Re: \".",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: "Email addresses to send to.",
        },
        cc: { type: "array", items: { type: "string" }, maxItems: 20 },
        subject: { type: "string" },
        body: { type: "string", description: "The email, as plain text." },
        in_reply_to: {
          type: "string",
          description:
            "The message id of the email this answers, if it is a reply.",
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
]);

/** The one tool that changes anything. The catalogue names it as a write. */
export const MAIL_WRITE_TOOLS = Object.freeze(["send_email"]);

type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
};

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export const listNeedsCredential = false;

const failure = (text: string): McpCallResult => ({
  text,
  isError: true,
  truncated: false,
});

function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS)
    return { text, isError: false, truncated: false };
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${text.length} characters]`,
    isError: false,
    truncated: true,
  };
}

function text(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function count(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
) {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return fallback;
  return Math.min(value, max);
}

function addresses(value: unknown): string[] | null {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const cleaned = list
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return cleaned.every(isAddress) ? cleaned : null;
}

function line(mail: MailSummary): string {
  return `- uid ${mail.uid}${mail.unread ? " (unread)" : ""}: "${mail.subject}" from ${mail.from || "unknown"}${mail.date ? `, ${mail.date}` : ""}`;
}

function full(mail: MailMessage): string {
  return [
    `From: ${mail.from || "unknown"}`,
    `To: ${mail.to || "unknown"}`,
    ...(mail.cc ? [`Cc: ${mail.cc}`] : []),
    `Subject: ${mail.subject}`,
    ...(mail.date ? [`Date: ${mail.date}`] : []),
    ...(mail.messageId ? [`Message id: ${mail.messageId}`] : []),
    ...(mail.attachments.length
      ? [`Attachments: ${mail.attachments.join("; ")}`]
      : []),
    "",
    mail.text,
  ].join("\n");
}

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const owner = connection.actorId?.trim();
  if (!owner) {
    return failure(
      "A mailbox belongs to somebody, and this run is not attributed to anybody.",
    );
  }
  const mail = installedMailService();
  if (!mail) return failure("Email is not available on this server.");
  const folder = text(args, "folder") ?? "INBOX";

  try {
    if (toolName === "list_emails") {
      const found = await mail.list(owner, {
        folder,
        unreadOnly: args.unread_only === true,
        limit: count(args, "limit", 10, 25),
      });
      if (!found.length) {
        return asResult(
          args.unread_only === true
            ? `There are no unread emails in ${folder}.`
            : `${folder} is empty.`,
        );
      }
      return asResult(
        `The newest emails in ${folder}:\n${found.map(line).join("\n")}`,
      );
    }

    if (toolName === "search_emails") {
      const query = text(args, "query");
      if (!query) return failure("Say what to search for.");
      const found = await mail.search(owner, {
        folder,
        text: query,
        limit: count(args, "limit", 10, 25),
      });
      if (!found.length)
        return asResult(`No emails in ${folder} match "${query}".`);
      return asResult(
        `Emails in ${folder} matching "${query}":\n${found.map(line).join("\n")}`,
      );
    }

    if (toolName === "read_email") {
      const uid = args.uid;
      if (typeof uid !== "number" || !Number.isInteger(uid) || uid < 1) {
        return failure(
          "Give the email's uid, a whole number from list_emails or search_emails.",
        );
      }
      const found = await mail.read(owner, { folder, uid });
      if (!found)
        return failure(`There is no email with uid ${uid} in ${folder}.`);
      return asResult(full(found));
    }

    if (toolName === "send_email") {
      const to = addresses(args.to);
      if (!to?.length)
        return failure("Give at least one real email address to send to.");
      const cc = args.cc === undefined ? [] : addresses(args.cc);
      if (!cc)
        return failure("One of the cc addresses is not an email address.");
      const subject = text(args, "subject");
      const body = typeof args.body === "string" ? args.body : "";
      if (!subject || !body.trim())
        return failure("An email needs a subject and some text.");
      const sent = await mail.send(owner, {
        to,
        cc,
        subject,
        text: body,
        inReplyTo: text(args, "in_reply_to"),
      });
      return asResult(
        `Sent "${subject}" to ${to.join(", ")}. Message id: ${sent.messageId}`,
      );
    }

    return failure(`Email has no tool named ${toolName}.`);
  } catch (error) {
    if (error instanceof MailRefusedError) return failure(error.message);
    return failure(
      "The mailbox did not answer. It may be offline, or the saved app password may have stopped working.",
    );
  }
}
