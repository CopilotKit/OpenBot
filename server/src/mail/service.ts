import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { mailAccounts } from "../db/schema/mail";
import {
  hostRefusal,
  isAddress,
  type MailServers,
  serversFor,
} from "./providers";

/** A saved mailbox as any route may show it: never the password. */
export type MailAccountView = MailServers & {
  address: string;
  username: string;
  updatedAt: string;
};

export type MailAccountRecord = MailServers & {
  id: string;
  ownerUserId: string;
  address: string;
  username: string;
  encryptedPassword: string;
  updatedAt: Date;
};

export type MailAccountStore = {
  get(ownerUserId: string): Promise<MailAccountRecord | null>;
  put(record: Omit<MailAccountRecord, "updatedAt">): Promise<MailAccountRecord>;
  remove(ownerUserId: string): Promise<boolean>;
};

/** What the tools need from a mailbox, behind one seam so the tests need no mail server. */
export type MailLogin = MailServers & {
  address: string;
  username: string;
  password: string;
};

export type MailSummary = {
  uid: number;
  from: string;
  subject: string;
  date: string | null;
  unread: boolean;
};

export type MailMessage = MailSummary & {
  to: string;
  cc: string;
  messageId: string | null;
  text: string;
  attachments: string[];
};

export type OutgoingMail = {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
};

export type MailClient = {
  /** Logs in and out again, so a wrong password is caught when it is saved, not later. */
  verify(login: MailLogin): Promise<void>;
  list(
    login: MailLogin,
    options: { folder: string; unreadOnly: boolean; limit: number },
  ): Promise<MailSummary[]>;
  search(
    login: MailLogin,
    options: { folder: string; text: string; limit: number },
  ): Promise<MailSummary[]>;
  read(
    login: MailLogin,
    options: { folder: string; uid: number },
  ): Promise<MailMessage | null>;
  send(login: MailLogin, mail: OutgoingMail): Promise<{ messageId: string }>;
};

export class MailRefusedError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400,
  ) {
    super(message);
    this.name = "MailRefusedError";
  }
}

export type MailService = ReturnType<typeof createMailService>;

function view(record: MailAccountRecord): MailAccountView {
  return {
    address: record.address,
    username: record.username,
    imapHost: record.imapHost,
    imapPort: record.imapPort,
    smtpHost: record.smtpHost,
    smtpPort: record.smtpPort,
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** What a person types: the address and an app password, the servers only if they differ. */
export type MailAccountInput = {
  address: string;
  password: string;
  username?: string;
  imapHost?: string;
  smtpHost?: string;
};

export function createMailService(deps: {
  store: MailAccountStore;
  client: MailClient;
  encryptionKey: string;
}) {
  async function login(ownerUserId: string): Promise<MailLogin> {
    const record = await deps.store.get(ownerUserId);
    if (!record) {
      throw new MailRefusedError(
        "You have not connected an email account yet. Add one under Settings, Email.",
        404,
      );
    }
    return {
      address: record.address,
      username: record.username,
      imapHost: record.imapHost,
      imapPort: record.imapPort,
      smtpHost: record.smtpHost,
      smtpPort: record.smtpPort,
      password: await decryptSecret(
        deps.encryptionKey,
        record.encryptedPassword,
      ),
    };
  }

  return {
    async account(ownerUserId: string): Promise<MailAccountView | null> {
      const record = await deps.store.get(ownerUserId);
      return record ? view(record) : null;
    },

    /** Checks the login against the mailbox before keeping it, then keeps it sealed. */
    async save(
      ownerUserId: string,
      input: MailAccountInput,
    ): Promise<MailAccountView> {
      const address = input.address?.trim() ?? "";
      if (!isAddress(address))
        throw new MailRefusedError("That is not an email address.");
      const password = input.password ?? "";
      if (!password.trim())
        throw new MailRefusedError("Type the app password for this mailbox.");
      const servers = serversFor(address);
      if (input.imapHost?.trim())
        servers.imapHost = input.imapHost.trim().toLowerCase();
      if (input.smtpHost?.trim())
        servers.smtpHost = input.smtpHost.trim().toLowerCase();
      for (const host of [servers.imapHost, servers.smtpHost]) {
        const refusal = hostRefusal(host);
        if (refusal) throw new MailRefusedError(refusal);
      }
      const candidate: MailLogin = {
        ...servers,
        address,
        username: input.username?.trim() || address,
        password,
      };
      try {
        await deps.client.verify(candidate);
      } catch {
        throw new MailRefusedError(
          "Couldn't log in to that mailbox. Check the address and the app password, and that IMAP is turned on for it.",
          502,
        );
      }
      const existing = await deps.store.get(ownerUserId);
      const saved = await deps.store.put({
        id: existing?.id ?? randomUUID(),
        ownerUserId,
        address,
        username: candidate.username,
        ...servers,
        encryptedPassword: await encryptSecret(deps.encryptionKey, password),
      });
      return view(saved);
    },

    async remove(ownerUserId: string): Promise<{ removed: boolean }> {
      return { removed: await deps.store.remove(ownerUserId) };
    },

    list: async (owner: string, options: Parameters<MailClient["list"]>[1]) =>
      deps.client.list(await login(owner), options),
    search: async (
      owner: string,
      options: Parameters<MailClient["search"]>[1],
    ) => deps.client.search(await login(owner), options),
    read: async (owner: string, options: Parameters<MailClient["read"]>[1]) =>
      deps.client.read(await login(owner), options),
    send: async (owner: string, mail: OutgoingMail) =>
      deps.client.send(await login(owner), mail),
  };
}

/** The Postgres store: one row per person, every read and write scoped by the owner. */
export function createMailAccountStore(database: Database): MailAccountStore {
  return {
    async get(ownerUserId) {
      const [row] = await database
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.ownerUserId, ownerUserId))
        .limit(1);
      return row ?? null;
    },
    async put(record) {
      const [row] = await database
        .insert(mailAccounts)
        .values(record)
        .onConflictDoUpdate({
          target: mailAccounts.ownerUserId,
          set: {
            address: record.address,
            username: record.username,
            imapHost: record.imapHost,
            imapPort: record.imapPort,
            smtpHost: record.smtpHost,
            smtpPort: record.smtpPort,
            encryptedPassword: record.encryptedPassword,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("The mailbox was not saved.");
      return row;
    },
    async remove(ownerUserId) {
      const rows = await database
        .delete(mailAccounts)
        .where(eq(mailAccounts.ownerUserId, ownerUserId))
        .returning({ id: mailAccounts.id });
      return rows.length > 0;
    },
  };
}

/** An in-memory store, for tests and for running without a database. */
export function createMemoryMailAccountStore(): MailAccountStore {
  const rows = new Map<string, MailAccountRecord>();
  return {
    async get(ownerUserId) {
      return rows.get(ownerUserId) ?? null;
    },
    async put(record) {
      const row = { ...record, updatedAt: new Date() };
      rows.set(record.ownerUserId, row);
      return row;
    },
    async remove(ownerUserId) {
      return rows.delete(ownerUserId);
    },
  };
}

let installed: MailService | null = null;

/** Hand the tools and routes the service, once, from the place that builds stores. */
export function useMailService(service: MailService | null): void {
  installed = service;
}

export function installedMailService(): MailService | null {
  return installed;
}
