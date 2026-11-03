import { type FetchMessageObject, ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type {
  MailClient,
  MailLogin,
  MailMessage,
  MailSummary,
} from "./service";

/** The longest body a Bot is handed, so one huge newsletter cannot fill its whole turn. */
export const MAX_BODY_CHARS = 12_000;
const TIMEOUT_MS = 20_000;

function imap(login: MailLogin) {
  return new ImapFlow({
    host: login.imapHost,
    port: login.imapPort,
    secure: true,
    auth: { user: login.username, pass: login.password },
    logger: false,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 3,
  });
}

/** Open the mailbox, run `work` with the folder locked read-only, and always log out. */
async function withFolder<T>(
  login: MailLogin,
  folder: string,
  work: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = imap(login);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      return await work(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function who(list: { name?: string; address?: string }[] | undefined): string {
  return (list ?? [])
    .map((entry) =>
      entry.name
        ? `${entry.name} <${entry.address ?? ""}>`
        : (entry.address ?? ""),
    )
    .filter(Boolean)
    .join(", ");
}

function summary(message: FetchMessageObject): MailSummary {
  const envelope = message.envelope;
  return {
    uid: message.uid,
    from: who(envelope?.from),
    subject: envelope?.subject ?? "(no subject)",
    date: envelope?.date ? new Date(envelope.date).toISOString() : null,
    unread: !message.flags?.has("\\Seen"),
  };
}

/** The newest `limit` of the given uids, fetched as envelopes only. */
async function summaries(
  client: ImapFlow,
  uids: number[],
  limit: number,
): Promise<MailSummary[]> {
  const newest = [...uids].sort((a, b) => b - a).slice(0, limit);
  if (newest.length === 0) return [];
  const found: MailSummary[] = [];
  for await (const message of client.fetch(
    newest.join(","),
    { uid: true, envelope: true, flags: true },
    { uid: true },
  )) {
    found.push(summary(message));
  }
  return found.sort((a, b) => b.uid - a.uid);
}

async function searchUids(
  client: ImapFlow,
  query: Record<string, unknown>,
): Promise<number[]> {
  const result = await client.search(query, { uid: true });
  return Array.isArray(result) ? result : [];
}

/** The real mailbox: IMAP over TLS to read, SMTP over TLS to send. Reading never marks mail read. */
export const imapMailClient: MailClient = {
  async verify(login) {
    const client = imap(login);
    await client.connect();
    await client.logout().catch(() => client.close());
    const transport = smtp(login);
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  },

  list(login, { folder, unreadOnly, limit }) {
    return withFolder(login, folder, async (client) =>
      summaries(
        client,
        await searchUids(client, unreadOnly ? { seen: false } : { all: true }),
        limit,
      ),
    );
  },

  search(login, { folder, text, limit }) {
    return withFolder(login, folder, async (client) => {
      const words = text.trim();
      const [anywhere, from] = await Promise.all([
        searchUids(client, { text: words }),
        searchUids(client, { from: words }),
      ]);
      return summaries(client, [...new Set([...anywhere, ...from])], limit);
    });
  },

  read(login, { folder, uid }) {
    return withFolder(
      login,
      folder,
      async (client): Promise<MailMessage | null> => {
        // `peek`-style: the source is downloaded without setting \Seen, so reading is not a change.
        const message = await client.fetchOne(
          String(uid),
          { uid: true, envelope: true, flags: true, source: true },
          { uid: true },
        );
        if (message === false || !message.source) return null;
        const parsed = await simpleParser(message.source);
        const text = (parsed.text ?? "").trim();
        return {
          ...summary(message),
          to: who(message.envelope?.to),
          cc: who(message.envelope?.cc),
          messageId: parsed.messageId ?? null,
          text:
            text.length > MAX_BODY_CHARS
              ? `${text.slice(0, MAX_BODY_CHARS)}\n\n[cut: the email is ${text.length} characters long]`
              : text || "(This email has no plain text.)",
          attachments: (parsed.attachments ?? []).map(
            (file) =>
              `${file.filename ?? "unnamed"} (${file.contentType}, ${file.size} bytes)`,
          ),
        };
      },
    );
  },

  async send(login, mail) {
    const transport = smtp(login);
    try {
      const sent = await transport.sendMail({
        from: login.address,
        to: mail.to,
        cc: mail.cc,
        subject: mail.subject,
        text: mail.text,
        ...(mail.inReplyTo
          ? { inReplyTo: mail.inReplyTo, references: mail.inReplyTo }
          : {}),
      });
      return { messageId: sent.messageId };
    } finally {
      transport.close();
    }
  },
};

function smtp(login: MailLogin) {
  return nodemailer.createTransport({
    host: login.smtpHost,
    port: login.smtpPort,
    // 465 is TLS from the first byte; 587 upgrades with STARTTLS, and requireTLS refuses to go on
    // without it, so the password is never sent in the clear either way.
    secure: login.smtpPort !== 587,
    requireTLS: true,
    auth: { user: login.username, pass: login.password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 3,
  });
}
