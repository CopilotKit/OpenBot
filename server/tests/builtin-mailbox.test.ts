import { afterEach, describe, expect, test } from "bun:test";
import type { MailboxConfig } from "../src/config";
import {
  composeMessage,
  createMailboxClients,
  DeadlineExpiredError,
  deliveryUnconfirmed,
  type FullMessage,
  type ImapLike,
  MAX_BODY_CHARS,
  MAX_FOLDERS_LISTED,
  MAX_SOURCE_BYTES,
  type MailboxClients,
  MailboxError,
  type MailboxSession,
  type MessageHeader,
  type MessagePage,
  mailServerSentence,
  noSuchFolderSentence,
  type OutgoingMessage,
  readBody,
  type SendReceipt,
  type SmtpLike,
  sentFolderFrom,
  strippedHtml,
  UnconfirmedSendError,
  withDeadline,
} from "../src/mailbox/client";
import {
  boundedLimit,
  callTool,
  listTools,
  redacted,
  refusedRecipients,
  replyFrom,
  selectAccount,
  selectFolder,
  selectMailbox,
  useMailbox,
} from "../src/plugins/builtin-mailbox";
import { MAX_RESULT_CHARS } from "../src/plugins/mcp";

/**
 * The builtin Mailbox transport, asserted without a mail server.
 *
 * What is under test is the boundary, not IMAP: which arguments reach the protocol, what a model is
 * told when they are wrong, how much text can come back, and whether a reply is threaded against a
 * message that actually exists. A recording stub is installed through {@link useMailbox}, which is
 * the seam this module has for exactly that reason: `transportFor` resolves a kind to a MODULE, so
 * there is no constructor to pass a client to.
 *
 * The two properties this file exists for are the ones that are expensive to be wrong about. The
 * first is the password: it is resolved per call, it must never appear in an answer, and a mail
 * server that echoes it back into an error must not be able to launder it into a transcript or an
 * audit row. The second is bounding: every result here is somebody else's text, arriving in a
 * model's context window, and an unbounded body is a sender deciding how much of it to spend.
 */

const CONNECTION = {
  url: "builtin://mailbox/",
  actorId: "user_asker",
  botId: "bot_helper",
};

/**
 * Two accounts on one pair of hosts, which is the shared-hosting shape this connector serves.
 *
 * The first is the default, so every case that names no account is also a case about which one that
 * is. The second exists so "the account was honoured" is a claim that can fail: with one configured
 * account every answer would name the right address by accident.
 */
const ACCOUNTS = ["bot@example.test", "sales@example.test"] as const;
const DEFAULT_ACCOUNT = ACCOUNTS[0];

const CONFIG: MailboxConfig = {
  imapHost: "imap.example.test",
  imapPort: 993,
  smtpHost: "smtp.example.test",
  smtpPort: 465,
  users: [...ACCOUNTS],
  // Unrestricted, which is the default and what every case here but the allowlist ones wants.
  allowedRecipientDomains: new Set<string>(),
};

const PASSWORD = "correct-horse-battery-staple";

const HEADER: MessageHeader = {
  uid: 42,
  from: "Dana Reid <dana@example.test>",
  to: "bot@example.test",
  subject: "The Friday numbers",
  date: "2026-08-30T09:15:00.000Z",
  seen: false,
};

const MESSAGE: FullMessage = {
  ...HEADER,
  messageId: "<first@example.test>",
  references: ["<older@example.test>"],
  body: "Can you send the Friday numbers?",
  bodyLength: 32,
  sourceTruncated: false,
  sizeBytes: 1_200,
};

/** One page of one message, which is what most of these cases want back. */
const onePage = (header: MessageHeader = HEADER): MessagePage => ({
  headers: [{ ...header }],
  total: 1,
});

type Recorded =
  | { method: "recent"; mailbox: string; limit: number }
  | { method: "message"; mailbox: string; uid: number }
  | { method: "search"; mailbox: string; query: string; limit: number }
  | { method: "send"; message: OutgoingMessage };

type Stubs = {
  recent?: (mailbox: string, limit: number) => Promise<MessagePage>;
  message?: (mailbox: string, uid: number) => Promise<FullMessage | null>;
  search?: (
    mailbox: string,
    query: string,
    limit: number,
  ) => Promise<MessagePage>;
  send?: (message: OutgoingMessage) => Promise<SendReceipt>;
  password?: (account: string) => Promise<string | null>;
  /** A deployment configured differently from {@link CONFIG}, for the allowlist cases. */
  config?: MailboxConfig;
};

/**
 * Installs a mailbox whose protocols are recorded rather than spoken.
 *
 * The config and the password handed to the factory are recorded too, because "the call went out
 * with the configured host and the vault's password" is a claim worth being able to check without a
 * server that would have to answer it.
 */
function recordingMailbox(stubs: Stubs = {}): {
  calls: Recorded[];
  built: { config: MailboxConfig; account: string; password: string }[];
  /** Which account each password lookup was for, in order. One vault row per account. */
  unlocked: string[];
} {
  const calls: Recorded[] = [];
  const built: {
    config: MailboxConfig;
    account: string;
    password: string;
  }[] = [];
  const unlocked: string[] = [];

  useMailbox({
    config: stubs.config ?? CONFIG,
    password: async (account) => {
      unlocked.push(account);
      return stubs.password ? await stubs.password(account) : PASSWORD;
    },
    clients: (config, account, password): MailboxClients => {
      built.push({ config, account, password });
      const session: MailboxSession = {
        async recent(mailbox, limit) {
          calls.push({ method: "recent", mailbox, limit });
          return stubs.recent ? await stubs.recent(mailbox, limit) : onePage();
        },
        async message(mailbox, uid) {
          calls.push({ method: "message", mailbox, uid });
          return stubs.message ? await stubs.message(mailbox, uid) : MESSAGE;
        },
        async search(mailbox, query, limit) {
          calls.push({ method: "search", mailbox, query, limit });
          return stubs.search
            ? await stubs.search(mailbox, query, limit)
            : onePage();
        },
      };
      return {
        withSession: (use) => use(session),
        async send(message) {
          calls.push({ method: "send", message });
          return stubs.send
            ? await stubs.send(message)
            : {
                messageId: "<sent@example.test>",
                filedTo: "Sent",
                fileError: null,
              };
        },
      };
    },
  });

  return { calls, built, unlocked };
}

// The binding is module-level and the suite is one process, so a mailbox left installed here would
// be the one some other file's test unexpectedly reaches.
afterEach(() => {
  useMailbox(null);
});

describe("the tool list", () => {
  test("is the four mailbox tools, named exactly", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_messages",
      "read_message",
      "search_messages",
      "send_message",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  test("requires only what a call cannot be made without", async () => {
    const required = Object.fromEntries(
      (await listTools()).map((tool) => [
        tool.name,
        (tool.inputSchema as { required?: string[] }).required ?? [],
      ]),
    );
    expect(required.list_messages).toEqual([]);
    expect(required.read_message).toEqual(["uid"]);
    expect(required.search_messages).toEqual(["query"]);
    expect(required.send_message).toEqual(["to", "subject", "body"]);
  });

  test("says the two things a model cannot see: whose mailbox, and that uids are per mailbox", async () => {
    const tools = await listTools();
    const list = tools.find((tool) => tool.name === "list_messages");
    // A Bot that believes it is reading the asker's own mail will summarize somebody else's inbox
    // to them, and neither party will ever be told.
    expect(list?.description ?? "").toContain("shared mailbox");
    expect(list?.description ?? "").toContain("per folder");

    const send = tools.find((tool) => tool.name === "send_message");
    expect(send?.description ?? "").toContain("in_reply_to");
    expect(send?.description ?? "").toContain("nothing to recall");
  });

  test("names the folder argument `folder`, and says it is not an address", async () => {
    /*
     * The live failure this rename came from: a smaller model passed the email address as
     * `mailbox`, was told "Character not allowed in mailbox name: '.'" by the IMAP server, and
     * never tried `account`. Two arguments that both read as "which mailbox" is the trap, so one of
     * them is called `folder` and says in its own description what it is not.
     */
    recordingMailbox();
    for (const tool of await listTools()) {
      const properties = (
        tool.inputSchema as {
          properties?: Record<string, { description?: string }>;
        }
      ).properties;
      expect(properties?.folder).toBeDefined();
      expect(properties?.mailbox).toBeUndefined();
      const description = properties?.folder?.description ?? "";
      expect(description).toContain("IMAP folder");
      expect(description).toContain(
        "Leave it unset unless the person names a folder",
      );
      expect(description).toContain("This is not an email address");
      // The local part is the second half of the same mistake, so the argument says so itself.
      expect(description).toContain("not the part before the @");
      expect(description).toContain("use `account`");

      /*
       * A model reads a schema in order, and the argument it meets first is the one it reaches for
       * when it wants to say "the support mailbox". `folder` first is how an address, and then the
       * local part of one, ends up in it.
       */
      const order = Object.keys(properties ?? {});
      expect(order[0]).toBe("account");
      expect(order.indexOf("account")).toBeLessThan(order.indexOf("folder"));
    }
  });

  test("offers `account` and names the addresses a deployment actually has", async () => {
    /*
     * The choices are the deployment's, not this file's, so they are added at list time. A model
     * told only that an `account` argument exists has to guess at an address, and a guessed address
     * is a refusal at best.
     */
    recordingMailbox();
    for (const tool of await listTools()) {
      const properties = (
        tool.inputSchema as {
          properties?: Record<string, { description?: string }>;
        }
      ).properties;
      expect(properties?.account).toBeDefined();
      const description = properties?.account?.description ?? "";
      expect(description).toContain("as its email address");
      expect(description).toContain(
        "One of: bot@example.test, sales@example.test.",
      );
      expect(description).toContain("Default bot@example.test.");
      expect(tool.description).toContain(
        "bot@example.test, sales@example.test",
      );
      expect(tool.description).toContain("`account`");
    }
    // Never required: the deployment with one mailbox should not have to think about this at all.
    const required = (await listTools()).flatMap(
      (tool) => (tool.inputSchema as { required?: string[] }).required ?? [],
    );
    expect(required).not.toContain("account");
  });

  test("says an account can be named even with no mailbox configured", async () => {
    // The list is answered either way, so the wording has to work before there are addresses to
    // name. See listTools.
    useMailbox(null);
    for (const tool of await listTools()) {
      expect(tool.description).toContain(
        "the deployment's configured addresses",
      );
    }
  });

  test("needs no mailbox, no credential and no actor", async () => {
    // The only call site is `refreshTools`, which passes `{url, token}`. A list that emptied itself
    // when a variable was unset would revoke an administrator's grants by accident.
    useMailbox(null);
    expect(await listTools()).toHaveLength(4);
  });
});

describe("a deployment with no mailbox", () => {
  test("refuses every tool, naming all four things to set", async () => {
    useMailbox(null);
    for (const tool of [
      "list_messages",
      "read_message",
      "search_messages",
      "send_message",
    ]) {
      const result = await callTool(CONNECTION, tool, { uid: 1 });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        "Mailbox is not configured. Set MAILBOX_IMAP_HOST, MAILBOX_SMTP_HOST, MAILBOX_USERS and store each account's password as its mailbox credential.",
      );
    }
  });

  test("a configured mailbox with no password in the vault says so separately, naming the account", async () => {
    // A different job with a different fix. Telling an administrator to set three variables they can
    // see are already set is how a correct instruction reads as a broken deployment.
    const { calls } = recordingMailbox({ password: async () => null });
    const result = await callTool(CONNECTION, "list_messages", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      `holds no password for the mailbox ${DEFAULT_ACCOUNT}`,
    );
    // The key id is the address, so the sentence tells an administrator exactly which row to store.
    expect(result.text).toContain(`key id \`${DEFAULT_ACCOUNT}\``);
    // Nothing was dialled, so nothing could have been sent to a server unauthenticated.
    expect(calls).toEqual([]);
  });

  test("a password missing for one account is that account's problem, not the mailbox's", async () => {
    /*
     * A deployment that stored `bot@` and forgot `sales@` works for the one it has. The refusal has
     * to name the account that is missing a password, or an administrator goes to look at the
     * credential that is already there and finds nothing wrong with it.
     */
    const { calls } = recordingMailbox({
      password: async (account) =>
        account === DEFAULT_ACCOUNT ? PASSWORD : null,
    });

    const working = await callTool(CONNECTION, "list_messages", {});
    expect(working.isError).toBe(false);

    const missing = await callTool(CONNECTION, "list_messages", {
      account: "sales@example.test",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain(
      "holds no password for the mailbox sales@example.test",
    );
    // Only the account that had one was ever dialled.
    expect(calls).toEqual([{ method: "recent", mailbox: "INBOX", limit: 10 }]);
  });
});

/**
 * Several accounts on one pair of hosts, which is what a shared host gives a deployment.
 *
 * The three properties worth pinning: the default is the first configured, so a deployment that
 * only ever had one mailbox behaves exactly as it did; an account that was named is the one dialled,
 * unlocked and answered about; and an account that is not configured is refused before anything
 * leaves this process.
 */
describe("several accounts", () => {
  test("works in the first configured account when none was named", async () => {
    const { built, unlocked } = recordingMailbox();
    const result = await callTool(CONNECTION, "list_messages", {});

    expect(unlocked).toEqual([DEFAULT_ACCOUNT]);
    expect(built.map((one) => one.account)).toEqual([DEFAULT_ACCOUNT]);
    expect(result.text).not.toContain("sales@example.test");
  });

  test("unlocks and dials the account that was named, and names it back", async () => {
    const { built, unlocked } = recordingMailbox({
      recent: async () => ({ headers: [{ ...HEADER }], total: 236 }),
    });
    const result = await callTool(CONNECTION, "list_messages", {
      account: "sales@example.test",
    });

    // The password is that account's own vault row, so the lookup is per account.
    expect(unlocked).toEqual(["sales@example.test"]);
    expect(built.map((one) => one.account)).toEqual(["sales@example.test"]);
    // A model reading two accounts in one turn cannot tell two INBOXes apart otherwise.
    expect(result.text).toContain(
      "[showing 1 of 236 messages in folder INBOX of sales@example.test, newest first.]",
    );
  });

  test("takes the address in whatever case it was written", async () => {
    // The configured list is lower-cased and so is the credential key, so a model that shouted the
    // address reaches the same mailbox rather than an account that does not exist.
    const { built } = recordingMailbox();
    const result = await callTool(CONNECTION, "read_message", {
      uid: 42,
      account: "Sales@Example.TEST",
    });

    expect(result.isError).toBe(false);
    expect(built.map((one) => one.account)).toEqual(["sales@example.test"]);
    expect(result.text).toContain(
      "uid 42 in folder INBOX of sales@example.test",
    );
  });

  test("refuses an account this deployment does not have, before anything is dialled", async () => {
    /*
     * Before the vault and before the network. A model that invented an address should be corrected
     * with the list of real ones rather than handed a login failure about a mailbox that does not
     * exist, and `send_message` must not reach a mail server on a mistaken argument.
     */
    const { calls, built, unlocked } = recordingMailbox();
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "s",
      body: "b",
      account: "billing@example.test",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("billing@example.test is not one of");
    // The configured addresses, so the next call can be right.
    expect(result.text).toContain("bot@example.test, sales@example.test");
    expect(result.text).toContain("nothing was sent");
    expect(calls).toEqual([]);
    expect(built).toEqual([]);
    expect(unlocked).toEqual([]);
  });

  test("sends from the account it was told to, and says which", async () => {
    const { calls, built } = recordingMailbox();
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "The Friday numbers",
      body: "Attached.",
      account: "sales@example.test",
    });

    expect(result.isError).toBe(false);
    // From is the client's, never an argument: the account decides who the mail is from.
    expect(built.map((one) => one.account)).toEqual(["sales@example.test"]);
    expect(result.text).toContain(
      "Sent from sales@example.test to dana@example.test",
    );
    expect(calls.some((call) => call.method === "send")).toBe(true);
  });

  test("scrubs the account's own password out of that account's failure", async () => {
    /*
     * Redaction is per selected account: the AUTH=PLAIN blob a server quotes back carries the
     * account and its password together, so scrubbing with the default account's name would leave
     * another account's credential in the sentence.
     */
    const OTHER = "a-different-secret-entirely";
    recordingMailbox({
      password: async (account) =>
        account === "sales@example.test" ? OTHER : PASSWORD,
      recent: async () => {
        const blob = Buffer.from(
          `\u0000sales@example.test\u0000${OTHER}`,
          "utf8",
        ).toString("base64");
        throw new MailboxError(`A1 BAD failed: AUTHENTICATE PLAIN ${blob}`);
      },
    });
    const result = await callTool(CONNECTION, "list_messages", {
      account: "sales@example.test",
    });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(OTHER);
    expect(result.text).not.toContain(
      Buffer.from(`\u0000sales@example.test\u0000${OTHER}`, "utf8").toString(
        "base64",
      ),
    );
    expect(result.text).toContain("[redacted]");
    expect(result.text).toContain("BAD failed");
  });

  test("refuses an address in `folder`, before anything is dialled, pointing at `account`", async () => {
    /*
     * The mistake as it actually happened: the address in the folder argument. Left to the mail
     * server it comes back as "Character not allowed in mailbox name" and then "Mailbox doesn't
     * exist: support", which are sentences about IMAP folder naming that no model turns into "use
     * the other argument". The refusal has to carry the fix.
     */
    const { calls, built, unlocked } = recordingMailbox();
    const result = await callTool(CONNECTION, "list_messages", {
      folder: "support@example.test",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "support@example.test looks like an email address, and `folder` names an IMAP folder such as INBOX. Pass the address as `account` instead. Nothing was read and nothing was sent.",
    );
    expect(calls).toEqual([]);
    expect(built).toEqual([]);
    expect(unlocked).toEqual([]);
  });

  test("refuses an address in `folder` on the write tool too, sending nothing", async () => {
    // An address this deployment does not have, so there is nothing to adopt. A configured one is
    // taken as the account instead: see the adoption cases below.
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "s",
      body: "b",
      folder: "billing@example.test",
      in_reply_to: 42,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Pass the address as `account` instead");
    expect(result.text).toContain("nothing was sent");
    expect(calls).toEqual([]);
  });

  test("still reads the old `mailbox` key, so a stale tool list is not a silent wrong folder", async () => {
    // A Bot holding a tool list from before the rename would otherwise pass a folder that is
    // ignored, and read INBOX while believing it read Archive.
    const { calls } = recordingMailbox();
    await callTool(CONNECTION, "list_messages", { mailbox: "Archive" });
    expect(calls).toEqual([
      { method: "recent", mailbox: "Archive", limit: 10 },
    ]);

    // And the guard covers it under the old name as well, so it cannot bring the trap back.
    const address = await callTool(CONNECTION, "list_messages", {
      mailbox: "support@example.test",
    });
    expect(address.isError).toBe(true);
    expect(address.text).toContain("Pass the address as `account` instead");
  });

  test("takes a configured address out of `folder` and reads that account's INBOX", async () => {
    /*
     * The mistake, adopted rather than refused. A model that put a configured address in `folder`
     * has said something unambiguous: there is one mailbox it can mean and it named it. Live runs
     * show this on the FIRST mailbox call of a turn, so refusing it spends the turn on a vocabulary
     * lesson before any work happens.
     */
    const { calls, built } = recordingMailbox();
    const result = await callTool(CONNECTION, "list_messages", {
      folder: "Sales@Example.TEST",
    });

    expect(result.isError).toBe(false);
    expect(built.map((one) => one.account)).toEqual(["sales@example.test"]);
    // The folder falls back to INBOX, because the argument that named one was spent on the account.
    expect(calls).toEqual([{ method: "recent", mailbox: "INBOX", limit: 10 }]);
    // The lesson is taught on the way past rather than instead of the work.
    expect(result.text.split("\n")[0]).toBe(
      "[folder took the address sales@example.test; it was used as account, reading INBOX.]",
    );
    expect(result.text).toContain("uid 42");
  });

  test("adopts the address on the write path too, threading and sending from that account", async () => {
    const { calls, built } = recordingMailbox();
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "The Friday numbers",
      body: "Friday it is.",
      in_reply_to: 42,
      folder: "sales@example.test",
    });

    expect(result.isError).toBe(false);
    expect(built.map((one) => one.account)).toEqual(["sales@example.test"]);
    // The original is fetched from the adopted account's INBOX, and the reply goes out from it.
    expect(calls[0]).toEqual({ method: "message", mailbox: "INBOX", uid: 42 });
    expect(calls[1]?.method).toBe("send");
    expect(result.text).toContain(
      "[folder took the address sales@example.test; it was used as account, reading INBOX.]",
    );
    expect(result.text).toContain("Sent from sales@example.test");
  });

  test("adopting is not overriding: the same address in both arguments is fine", async () => {
    const { built } = recordingMailbox();
    const result = await callTool(CONNECTION, "list_messages", {
      folder: "sales@example.test",
      account: "sales@example.test",
    });

    expect(result.isError).toBe(false);
    expect(built.map((one) => one.account)).toEqual(["sales@example.test"]);
  });

  test("refuses two arguments naming two different mailboxes, naming both", async () => {
    /*
     * Nothing to adopt: a model that named one mailbox in `folder` and another in `account` has
     * lost track of which it is reading, and picking either would be picking for it.
     */
    const { calls, built, unlocked } = recordingMailbox();
    const result = await callTool(CONNECTION, "list_messages", {
      folder: "sales@example.test",
      account: "bot@example.test",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("folder is sales@example.test");
    expect(result.text).toContain("account is bot@example.test");
    expect(result.text).toContain("Nothing was read and nothing was sent.");
    expect(calls).toEqual([]);
    expect(built).toEqual([]);
    expect(unlocked).toEqual([]);
  });

  test("refuses an account's local part in `folder`, before anything is dialled", async () => {
    /*
     * The retry after the @ guard fired, as it actually happened: refused `support@example.test`,
     * the model tried `support`, then `webmaster`, which are the parts before the @ of configured
     * accounts. The mail server answers "Mailbox doesn't exist: support", which reads as a folder
     * that happens to be missing rather than as an argument that is wrong.
     */
    const { calls, built, unlocked } = recordingMailbox();
    const result = await callTool(CONNECTION, "list_messages", {
      folder: "Sales",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Sales is the account sales@example.test, not a folder. Pass account=sales@example.test and leave folder unset to read INBOX. Nothing was read and nothing was sent.",
    );
    expect(calls).toEqual([]);
    expect(built).toEqual([]);
    expect(unlocked).toEqual([]);
  });

  test("resolves the two arguments together, on its own", () => {
    const users = ["bot@example.test", "sales@example.test"];
    expect(selectMailbox({}, users)).toEqual({
      account: "bot@example.test",
      folder: "INBOX",
    });
    expect(selectMailbox({ folder: "Archive" }, users)).toEqual({
      account: "bot@example.test",
      folder: "Archive",
    });
    expect(selectMailbox({ folder: " SALES@example.test " }, users)).toEqual({
      account: "sales@example.test",
      folder: "INBOX",
      note: "[folder took the address sales@example.test; it was used as account, reading INBOX.]",
    });
    // An address this deployment does not have has nothing to adopt, so the refusal stands.
    expect(
      selectMailbox({ folder: "billing@example.test" }, users).error,
    ).toContain("looks like an email address");
    // A folder named like an account's local part is still refused: `support` is not an address,
    // and a folder genuinely called that can exist.
    expect(selectMailbox({ folder: "sales" }, users).error).toContain(
      "is the account sales@example.test, not a folder",
    );
  });

  test("picks the folder out of the arguments, on its own", () => {
    const users = ["bot@example.test", "sales@example.test"];
    expect(selectFolder({}, users)).toEqual({ folder: "INBOX" });
    expect(selectFolder({ folder: "  " }, users)).toEqual({ folder: "INBOX" });
    expect(selectFolder({ folder: "Archive" }, users)).toEqual({
      folder: "Archive",
    });
    expect(selectFolder({ mailbox: "Sent" }, users)).toEqual({
      folder: "Sent",
    });
    expect(selectFolder({ folder: "a@b.test" }, users).error).toContain(
      "looks like an email address",
    );
    // Case-insensitively and after trimming, which is how a model writes it.
    expect(selectFolder({ folder: " BOT " }, users).error).toContain(
      "is the account bot@example.test, not a folder",
    );
    // A folder that merely starts the same way is still a folder.
    expect(selectFolder({ folder: "bot-archive" }, users)).toEqual({
      folder: "bot-archive",
    });
  });

  test("picks the account out of the arguments, on its own", () => {
    const users = ["bot@example.test", "sales@example.test"];
    expect(selectAccount({}, users)).toEqual({ account: "bot@example.test" });
    expect(selectAccount({ account: "  " }, users)).toEqual({
      account: "bot@example.test",
    });
    expect(selectAccount({ account: "SALES@example.test" }, users)).toEqual({
      account: "sales@example.test",
    });
    expect(
      selectAccount({ account: "nobody@example.test" }, users).error,
    ).toContain("not one of this deployment's mailbox accounts");
  });
});

describe("listing", () => {
  test("dials the configured mailbox with the vault's password", async () => {
    const { built } = recordingMailbox();
    await callTool(CONNECTION, "list_messages", {});
    expect(built).toEqual([
      { config: CONFIG, account: DEFAULT_ACCOUNT, password: PASSWORD },
    ]);
  });

  test("defaults to ten of INBOX", async () => {
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "list_messages", {});

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ method: "recent", mailbox: "INBOX", limit: 10 }]);
    expect(result.text).toContain("uid 42");
    expect(result.text).toContain("Dana Reid");
    expect(result.text).toContain("The Friday numbers");
    expect(result.text).toContain("unread");
  });

  test("honours a mailbox and a limit that were asked for", async () => {
    const { calls } = recordingMailbox();
    await callTool(CONNECTION, "list_messages", {
      folder: "Archive",
      limit: 3,
    });
    expect(calls).toEqual([{ method: "recent", mailbox: "Archive", limit: 3 }]);
  });

  test("caps a huge ask at fifty and says it did", async () => {
    // Capped rather than refused: "give me 200" is a clear intention this tool does not serve, and a
    // refusal would cost a round trip to be told a smaller number. Said, so a model that asked for
    // 200 and got 50 does not conclude the mailbox holds fifty messages.
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "list_messages", { limit: 200 });

    expect(calls).toEqual([{ method: "recent", mailbox: "INBOX", limit: 50 }]);
    expect(result.text).toContain("50 is the most this tool lists at once");
  });

  test("says how many there were when the mailbox holds more than the page", async () => {
    /*
     * A page of ten with nothing else on it reads to a model as the whole mailbox, and it will
     * answer "you have ten messages" about a mailbox holding four thousand. The count is free (it
     * is the mailbox's own `exists`) and it is the difference between a listing and a claim.
     */
    recordingMailbox({
      recent: async (_mailbox, limit) => ({
        headers: Array.from({ length: limit }, (_, index) => ({
          ...HEADER,
          uid: index + 1,
        })),
        total: 4_321,
      }),
    });
    const result = await callTool(CONNECTION, "list_messages", {});

    expect(result.text).toContain(
      `showing 10 of 4321 messages in folder INBOX of ${DEFAULT_ACCOUNT}, newest first.`,
    );
    // Nothing was capped, so the tool's own limit is not mentioned as well.
    expect(result.text).not.toContain("most this tool lists");
  });

  test("refuses a limit that is not a whole number, rather than rounding it", async () => {
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "list_messages", {
      limit: "ten",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("`limit` has to be a whole number");
    expect(calls).toEqual([]);
  });

  test("an empty mailbox is said in words, not answered with nothing", async () => {
    // An empty string reads to a model as "the tool had nothing to say" and gets filled in from
    // memory, which for a mailbox means inventing mail.
    recordingMailbox({ recent: async () => ({ headers: [], total: 0 }) });
    const result = await callTool(CONNECTION, "list_messages", {});

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      `There are no messages in folder INBOX of ${DEFAULT_ACCOUNT}.`,
    );
  });

  test("bounds the whole answer the way every other connector's is", async () => {
    const many: MessageHeader[] = Array.from({ length: 50 }, (_, index) => ({
      ...HEADER,
      uid: index + 1,
      subject: "x".repeat(1_000),
    }));
    recordingMailbox({
      recent: async () => ({ headers: many, total: many.length }),
    });
    const result = await callTool(CONNECTION, "list_messages", { limit: 50 });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated:");
    expect(result.text.length).toBeLessThan(MAX_RESULT_CHARS + 200);
  });
});

describe("reading one message", () => {
  test("reaches the mailbox the uid came from", async () => {
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "read_message", {
      uid: 42,
      folder: "Archive",
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ method: "message", mailbox: "Archive", uid: 42 }]);
    expect(result.text).toContain("From: Dana Reid <dana@example.test>");
    expect(result.text).toContain("Can you send the Friday numbers?");
  });

  test("accepts a uid a model wrote as a string", async () => {
    const { calls } = recordingMailbox();
    await callTool(CONNECTION, "read_message", { uid: "42" });
    expect(calls).toEqual([{ method: "message", mailbox: "INBOX", uid: 42 }]);
  });

  test("refuses a missing uid and a fractional one without dialling", async () => {
    const { calls } = recordingMailbox();
    const missing = await callTool(CONNECTION, "read_message", {});
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("Say which message to read");

    const fractional = await callTool(CONNECTION, "read_message", {
      uid: 12.7,
    });
    expect(fractional.isError).toBe(true);
    expect(fractional.text).toContain("whole number");
    expect(calls).toEqual([]);
  });

  test("a uid that is not there is named as such, with why", async () => {
    recordingMailbox({ message: async () => null });
    const result = await callTool(CONNECTION, "read_message", { uid: 7 });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("no message with uid 7 in folder INBOX");
    expect(result.text).toContain("per folder");
  });

  test("a long body is cut and says how long it was", async () => {
    recordingMailbox({
      message: async () => ({
        ...MESSAGE,
        body: "y".repeat(MAX_BODY_CHARS),
        bodyLength: 41_000,
      }),
    });
    const result = await callTool(CONNECTION, "read_message", { uid: 42 });

    expect(result.isError).toBe(false);
    // The length is stated, because a message cut at 8000 of 9000 has almost certainly said what it
    // came to say and one cut at 8000 of 41000 has not.
    expect(result.text).toContain("[truncated: the message body is 41000");
    expect(result.text).toContain(String(MAX_BODY_CHARS));
  });

  test("a message read only in part says the rest was never seen", async () => {
    /*
     * A different fact from a long body. A cut body means the deployment holds the whole message
     * and is showing part of it; a cut source means it never read the rest off the wire, so an
     * answer offering to go back for the attachment would be offering something impossible.
     */
    recordingMailbox({
      message: async () => ({
        ...MESSAGE,
        sourceTruncated: true,
        sizeBytes: 4_000_000,
      }),
    });
    const result = await callTool(CONNECTION, "read_message", { uid: 42 });

    expect(result.text).toContain(`only the first ${MAX_SOURCE_BYTES} bytes`);
    expect(result.text).toContain("4000000 bytes");
    expect(result.text).toContain("attachments");
  });

  test("a uid too large for IMAP is answered as a message that is not there", async () => {
    // Uids are 32-bit (RFC 3501). Passed through, `1e21` reaches imapflow and comes back as
    // "Invalid sequence set value", which is a sentence about a data structure rather than about
    // the message a model thinks it asked for.
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "read_message", {
      uid: 4_294_967_296,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "no message with uid 4294967296 in folder INBOX",
    );
    expect(calls).toEqual([]);
  });

  test("a message with no readable text says that rather than nothing", async () => {
    recordingMailbox({
      message: async () => ({ ...MESSAGE, body: "", bodyLength: 0 }),
    });
    const result = await callTool(CONNECTION, "read_message", { uid: 42 });
    expect(result.text).toContain("no readable text");
  });
});

describe("searching", () => {
  test("passes the query through and defaults to twenty", async () => {
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "search_messages", {
      query: "invoice",
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      { method: "search", mailbox: "INBOX", query: "invoice", limit: 20 },
    ]);
  });

  test("refuses an empty query without dialling", async () => {
    const { calls } = recordingMailbox();
    const blank = await callTool(CONNECTION, "search_messages", { query: " " });
    expect(blank.isError).toBe(true);
    expect(blank.text).toContain("Say what to search");
    expect(calls).toEqual([]);
  });

  test("says how many matched when it is showing fewer", async () => {
    recordingMailbox({
      search: async (_mailbox, _query, limit) => ({
        headers: Array.from({ length: limit }, (_, index) => ({
          ...HEADER,
          uid: index + 1,
        })),
        total: 300,
      }),
    });
    const result = await callTool(CONNECTION, "search_messages", {
      query: "invoice",
    });

    // A search that found 300 and is answering with 20 has to say so, or the model reports 20.
    expect(result.text).toContain("showing 20 of 300 matches");
  });

  test("nothing found is stated, with nothing to answer from", async () => {
    recordingMailbox({ search: async () => ({ headers: [], total: 0 }) });
    const result = await callTool(CONNECTION, "search_messages", {
      query: "invoice",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain(
      `Nothing in folder INBOX of ${DEFAULT_ACCOUNT} matches "invoice"`,
    );
    expect(result.text).toContain("nothing here to answer from");
  });
});

describe("sending", () => {
  test("sends what it was given and confirms it", async () => {
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "The Friday numbers",
      body: "Attached.",
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      {
        method: "send",
        message: {
          to: "dana@example.test",
          subject: "The Friday numbers",
          body: "Attached.",
        },
      },
    ]);
    expect(result.text).toContain(
      `Sent from ${DEFAULT_ACCOUNT} to dana@example.test`,
    );
    expect(result.text).toContain("starts a new thread");
    // Where to verify it. A Bot that cannot find its own sent mail concludes it was never sent.
    expect(result.text).toContain("A copy is in folder Sent.");
  });

  test("refuses a message with no recipient, no subject or no body, sending nothing", async () => {
    const { calls } = recordingMailbox();
    for (const args of [
      { subject: "s", body: "b" },
      { to: "dana@example.test", body: "b" },
      { to: "dana@example.test", subject: "s" },
    ]) {
      const result = await callTool(CONNECTION, "send_message", args);
      expect(result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  test("a reply threads on the original's own ids and gains a Re:", async () => {
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "The Friday numbers",
      body: "Friday it is.",
      in_reply_to: 42,
    });

    expect(result.isError).toBe(false);
    // Fetched first, then sent: the ids come from a message that exists rather than from a model.
    expect(calls[0]).toEqual({ method: "message", mailbox: "INBOX", uid: 42 });
    expect(calls[1]).toEqual({
      method: "send",
      message: {
        to: "dana@example.test",
        subject: "Re: The Friday numbers",
        body: "Friday it is.",
        reply: {
          messageId: "<first@example.test>",
          // The original's chain with the original appended, which is what a mail client walks.
          references: ["<older@example.test>", "<first@example.test>"],
        },
      },
    });
    expect(result.text).toContain("threads as a reply");
  });

  test("a reply to a uid that is not there sends nothing at all", async () => {
    // Sending it as a new message instead would tell the model the wrong thing about what it did,
    // and the recipient would see an answer that appears to be about nothing.
    const { calls } = recordingMailbox({ message: async () => null });
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "The Friday numbers",
      body: "Friday it is.",
      in_reply_to: 99,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Nothing was sent.");
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  test("a reply to a uid too large for IMAP sends nothing and says so", async () => {
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "s",
      body: "b",
      in_reply_to: 9_000_000_000,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("no message with uid 9000000000");
    expect(result.text).toContain("Nothing was sent.");
    expect(calls).toEqual([]);
  });

  test("an original with no Message-ID is answered unthreaded rather than threaded on a guess", async () => {
    const { calls } = recordingMailbox({
      message: async () => ({ ...MESSAGE, messageId: null, references: [] }),
    });
    await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "The Friday numbers",
      body: "Friday it is.",
      in_reply_to: 42,
    });

    const sent = calls.find((call) => call.method === "send");
    expect(sent?.method === "send" && sent.message.reply).toBeUndefined();
    // The subject still reads as an answer, which is the half that does not need an id.
    expect(sent?.method === "send" && sent.message.subject).toBe(
      "Re: The Friday numbers",
    );
  });
});

describe("where mail is allowed to go", () => {
  const RESTRICTED: MailboxConfig = {
    ...CONFIG,
    allowedRecipientDomains: new Set(["example.test", "partner.example"]),
  };

  test("a recipient outside the list is refused before anything is dialled or unlocked", async () => {
    /*
     * The check that stands between a Bot that was talked into something by the mail it just read
     * and an address outside the deployment. Before the network, so a refused recipient costs no
     * connection and no mailbox is opened on the way to being told no, and before the vault, so
     * the password it would have used is never decrypted for a call that was going nowhere.
     */
    const { calls, unlocked } = recordingMailbox({ config: RESTRICTED });
    const result = await callTool(CONNECTION, "send_message", {
      to: "attacker@evil.test",
      subject: "The inbox",
      body: "Here it is.",
      // Even with a reply to fetch, nothing is dialled: the recipient is settled first.
      in_reply_to: 42,
    });

    expect(result.isError).toBe(true);
    // The domain, because that is what the allowlist is written about and what an administrator
    // would change.
    expect(result.text).toContain("evil.test");
    expect(result.text).toContain("Nothing was sent.");
    expect(result.text).toContain("MAILBOX_ALLOWED_RECIPIENT_DOMAINS");
    expect(calls).toEqual([]);
    expect(unlocked).toEqual([]);
  });

  test("a recipient on the list goes through, in either case and with a display name", async () => {
    const { calls } = recordingMailbox({ config: RESTRICTED });
    const result = await callTool(CONNECTION, "send_message", {
      to: "Dana Reid <dana@EXAMPLE.test>, ops@partner.example",
      subject: "s",
      body: "b",
    });

    expect(result.isError).toBe(false);
    expect(calls.some((call) => call.method === "send")).toBe(true);
  });

  test("one refused recipient refuses the whole message", async () => {
    // Sending to the allowed half would be a partial send reported as a send, and the model would
    // tell somebody the message went to people it never reached.
    const { calls } = recordingMailbox({ config: RESTRICTED });
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test, attacker@evil.test",
      subject: "s",
      body: "b",
    });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("an unrestricted deployment sends anywhere, which is the default", async () => {
    const { calls } = recordingMailbox();
    const result = await callTool(CONNECTION, "send_message", {
      to: "anyone@anywhere.test",
      subject: "s",
      body: "b",
    });

    expect(result.isError).toBe(false);
    expect(calls.some((call) => call.method === "send")).toBe(true);
  });
});

describe("picking the refused recipients out of a to field", () => {
  const allowed = new Set(["example.test"]);

  test("an empty allowlist refuses nothing", () => {
    expect(refusedRecipients("anyone@anywhere.test", new Set())).toEqual([]);
  });

  test("matches on the domain, case-insensitively, through a display name", () => {
    expect(
      refusedRecipients("Dana <dana@Example.TEST>, ops@example.test", allowed),
    ).toEqual([]);
  });

  test("names each refused domain once", () => {
    expect(
      refusedRecipients("a@evil.test, b@evil.test, c@other.test", allowed),
    ).toEqual(["evil.test", "other.test"]);
  });

  test("something that is not an address at all is refused rather than passed on", () => {
    // An unparseable recipient is not one this list has cleared, and letting it through to be
    // somebody else's validation error would be a hole in a safety check.
    expect(refusedRecipients("not-an-address", allowed)).toEqual([
      "not-an-address",
    ]);
    expect(refusedRecipients("trailing@", allowed)).toEqual(["trailing@"]);
  });
});

describe("a folder that is not there", () => {
  test("answers with the folders that are, and says the account is not chosen this way", () => {
    /*
     * "Mailbox doesn't exist: support" reads as a folder that happens to be missing, so a model
     * retries with another folder name. The folders that do exist, plus one sentence about which
     * argument picks the account, turn a loop into a correction.
     */
    expect(
      noSuchFolderSentence("support", "bot@example.test", [
        "INBOX",
        "Sent",
        "Archive",
      ]),
    ).toBe(
      "No folder named support in bot@example.test. Folders here: INBOX, Sent, Archive. The account is chosen by `account`, not by folder; leave folder unset for INBOX.",
    );
  });

  test("says nothing about folders when the server would not list them", () => {
    // A LIST that failed leaves the correction without its examples. Still better than the vendor's
    // own sentence, and never a reason to lose the refusal.
    const sentence = noSuchFolderSentence("support", "bot@example.test", []);
    expect(sentence).not.toContain("Folders here");
    expect(sentence).toContain("The account is chosen by `account`");
  });

  test("keeps the instruction when there are more folders than fit", () => {
    /*
     * Trimmed from the end of the LIST rather than the end of the sentence: the closing instruction
     * is the half that changes what the model does next, and a failure is capped at 400 characters
     * by the transport above this.
     */
    const many = Array.from(
      { length: MAX_FOLDERS_LISTED + 20 },
      (_, index) => `Folder-Number-${index}`,
    );
    const sentence = noSuchFolderSentence("support", "bot@example.test", many);

    expect(sentence.length).toBeLessThanOrEqual(400);
    expect(sentence).toContain("Folders here: Folder-Number-0,");
    expect(sentence).toContain(", and more.");
    expect(sentence).toContain(
      "The account is chosen by `account`, not by folder; leave folder unset for INBOX.",
    );
  });

  test("reaches the model whole, rather than cut by the failure cap", async () => {
    const sentence = noSuchFolderSentence("support", "bot@example.test", [
      "INBOX",
      "Sent",
      "Archive",
      "Drafts",
      "Junk",
    ]);
    recordingMailbox({
      recent: async () => {
        throw new MailboxError(sentence);
      },
    });
    const result = await callTool(CONNECTION, "list_messages", {
      folder: "Newsletters",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(sentence);
  });
});

describe("the reply headers themselves", () => {
  test("append the original to its own chain", () => {
    expect(
      replyFrom(
        { messageId: "<b@x>", references: ["<a@x>"] },
        "The Friday numbers",
      ),
    ).toEqual({
      subject: "Re: The Friday numbers",
      reply: { messageId: "<b@x>", references: ["<a@x>", "<b@x>"] },
    });
  });

  test("do not stack Re: on a subject that already has one, in any case", () => {
    for (const subject of ["Re: numbers", "RE: numbers", "re: numbers"]) {
      expect(
        replyFrom({ messageId: "<b@x>", references: [] }, subject).subject,
      ).toBe(subject);
    }
  });

  test("recognise the reply marker other mail clients write", () => {
    // A client that only knew "Re:" is how a thread ends up titled "Re: AW: Re: AW: the numbers".
    for (const subject of [
      "AW: numbers",
      "SV:numbers",
      "Antw: numbers",
      "Ref : numbers",
    ]) {
      expect(
        replyFrom({ messageId: "<b@x>", references: [] }, subject).subject,
      ).toBe(subject);
    }
  });

  test("still prefix a subject that merely starts with those letters", () => {
    // "Reference pricing" is not a reply, and neither is "Software renewal".
    expect(
      replyFrom({ messageId: "<b@x>", references: [] }, "Reference pricing")
        .subject,
    ).toBe("Re: Reference pricing");
  });

  test("are absent entirely when the original carries no Message-ID", () => {
    // An In-Reply-To pointing at nothing is not a reply, and an invented id threads the answer into
    // a conversation that does not exist.
    expect(replyFrom({ messageId: null, references: ["<a@x>"] }, "n")).toEqual({
      subject: "Re: n",
    });
  });
});

describe("what a model is told when the mail server fails", () => {
  test("the server's own sentence survives, so the fix is nameable", async () => {
    recordingMailbox({
      recent: async () => {
        throw new MailboxError("Mailbox does not exist");
      },
    });
    const result = await callTool(CONNECTION, "list_messages", {});

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Mailbox does not exist");
  });

  test("the password never survives, even when the server echoes it back", async () => {
    /*
     * Some IMAP and SMTP servers quote the offending command on a failed login, and that command is
     * `LOGIN user password`. That sentence goes into an audit row and in front of a model, and
     * neither is a place for this deployment's mailbox password.
     */
    recordingMailbox({
      send: async () => {
        throw new MailboxError(
          `Invalid credentials for LOGIN bot@example.test ${PASSWORD}`,
        );
      },
    });
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "s",
      body: "b",
    });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(PASSWORD);
    expect(result.text).toContain("[redacted]");
    expect(result.text).toContain("Invalid credentials");
  });

  test("a failure is capped, because a failure is not a promise about length", async () => {
    recordingMailbox({
      recent: async () => {
        throw new Error("z".repeat(5_000));
      },
    });
    const result = await callTool(CONNECTION, "list_messages", {});
    expect(result.text.length).toBe(400);
  });

  test("a tool this transport does not implement is refused by name", async () => {
    const { calls, unlocked } = recordingMailbox();
    const result = await callTool(CONNECTION, "delete_message", { uid: 1 });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("delete_message is not a tool Mailbox");
    expect(calls).toEqual([]);
    expect(unlocked).toEqual([]);
  });

  test("an argument a tool refuses on its own is refused before the vault is read", async () => {
    // A call that was never going to reach a server should not decrypt the secret it would have
    // reached it with. The password is read at the moment a call needs it, and a refused call
    // never does.
    const { calls, unlocked } = recordingMailbox();
    const noUid = await callTool(CONNECTION, "read_message", {});
    const noBody = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "s",
    });

    expect(noUid.isError).toBe(true);
    expect(noBody.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(unlocked).toEqual([]);
  });

  test("a server that stopped answering mid-send is reported as unconfirmed, with the message id", async () => {
    /*
     * The one place delivery genuinely may have happened and this process cannot tell. A plain
     * "it failed" here is the one way this connector could deliver a message twice, so the
     * sentence says delivery is unknown, says not to resend, and carries the id a duplicate would
     * be found by.
     */
    recordingMailbox({
      send: async () => {
        throw new UnconfirmedSendError(
          "<unconfirmed@example.test>",
          "The mail server did not finish sending the message within 60 seconds.",
        );
      },
    });
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "s",
      body: "b",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not known whether it was delivered");
    expect(result.text).toContain("Do not send it again");
    expect(result.text).toContain("<unconfirmed@example.test>");
    expect(result.text).toContain("within 60 seconds");
    // And never "Nothing was sent", which is the promise every real refusal makes.
    expect(result.text).not.toContain("Nothing was sent");
  });
});

describe("redaction, on its own", () => {
  test("replaces every occurrence", () => {
    expect(redacted(`a ${PASSWORD} b ${PASSWORD}`, PASSWORD)).toBe(
      "a [redacted] b [redacted]",
    );
  });

  test("catches the base64 forms, which are what the wire actually carries", () => {
    /*
     * Neither client prefers plaintext LOGIN: imapflow authenticates with AUTH=PLAIN when the
     * server offers it and falls back to AUTH=LOGIN, and both put the credential on the wire
     * base64-encoded. A redaction that only knew the plaintext would pass the secret straight
     * through while looking like it had worked.
     */
    const login = Buffer.from(PASSWORD, "utf8").toString("base64");
    const plain = Buffer.from(
      `\u0000${DEFAULT_ACCOUNT}\u0000${PASSWORD}`,
      "utf8",
    ).toString("base64");

    const message = `A1 BAD failed: A1 AUTHENTICATE PLAIN ${plain} / LOGIN ${login}`;
    const scrubbed = redacted(message, PASSWORD, DEFAULT_ACCOUNT);

    expect(scrubbed).not.toContain(login);
    expect(scrubbed).not.toContain(plain);
    expect(scrubbed).not.toContain(PASSWORD);
    expect(scrubbed).toContain("[redacted]");
    // The rest of the server's sentence survives, which is the whole reason it is kept at all.
    expect(scrubbed).toContain("BAD failed");
  });

  test("leaves a message alone when there is no password, or a trivial one", () => {
    // Replacing a one-character secret would redact half the alphabet out of an unrelated sentence.
    expect(redacted("no such mailbox", null)).toBe("no such mailbox");
    expect(redacted("no such mailbox", "x")).toBe("no such mailbox");
  });
});

describe("the limit bound, on its own", () => {
  test("falls back, passes through, and caps", () => {
    const bounds = { fallback: 10, max: 50 };
    expect(boundedLimit(undefined, bounds)).toEqual({
      limit: 10,
      capped: false,
    });
    expect(boundedLimit(3, bounds)).toEqual({ limit: 3, capped: false });
    expect(boundedLimit(50, bounds)).toEqual({ limit: 50, capped: false });
    expect(boundedLimit(200, bounds)).toEqual({ limit: 50, capped: true });
  });
});

describe("reading a body out of a parsed message", () => {
  test("prefers the text part, whatever length it is", () => {
    // A plain-text alternative saying "this message needs an HTML viewer" is still what the sender
    // wrote. Preferring the HTML on length would swap the sender's own words out for markup.
    expect(
      readBody({ text: "short", html: "<p>much longer body here</p>" }),
    ).toEqual({ body: "short", bodyLength: 5 });
  });

  test("falls back to stripped HTML only when there is no text part", () => {
    expect(
      readBody({ html: "<p>Hello</p><script>alert(1)</script><p>there</p>" }),
    ).toEqual({ body: "Hello\nthere", bodyLength: 11 });
  });

  test("caps the body and reports the length it had", () => {
    const long = "y".repeat(MAX_BODY_CHARS + 500);
    const { body, bodyLength } = readBody({ text: long });
    expect(body).toHaveLength(MAX_BODY_CHARS);
    expect(bodyLength).toBe(MAX_BODY_CHARS + 500);
  });

  test("a message with neither part is empty rather than undefined", () => {
    expect(readBody({})).toEqual({ body: "", bodyLength: 0 });
    expect(readBody({ html: false })).toEqual({ body: "", bodyLength: 0 });
  });
});

describe("stripping HTML", () => {
  test("drops scripts and styles rather than reading them as prose", () => {
    expect(strippedHtml("<style>p{color:red}</style><p>Hi</p>")).toBe("Hi");
  });

  test("keeps line structure and decodes the entities that matter", () => {
    expect(strippedHtml("<p>a &amp; b</p><p>c<br>d</p>")).toBe("a & b\nc\nd");
  });
});

describe("the sentence a mail server actually wrote", () => {
  test("prefers responseText, which is where imapflow puts it", () => {
    /*
     * imapflow answers every IMAP NO and BAD with an Error whose message is the fixed string
     * "Command failed" and puts the server's own words on `responseText`. Reading `message` turns
     * "Invalid credentials", "Mailbox does not exist" and "Over quota" into one useless sentence
     * that names none of them, which is the opposite of why the vendor's wording is kept at all.
     */
    const error = Object.assign(new Error("Command failed"), {
      responseText: "Invalid credentials (Failure)",
      responseStatus: "NO",
      response: { command: "NO" },
    });
    expect(mailServerSentence(error)).toBe("Invalid credentials (Failure)");
  });

  test("falls back to a string response, which is where nodemailer puts the SMTP reply", () => {
    const error = Object.assign(new Error("Invalid login"), {
      response: "535 5.7.8 Authentication credentials invalid",
    });
    expect(mailServerSentence(error)).toBe(
      "535 5.7.8 Authentication credentials invalid",
    );
  });

  test("never renders a response object, and falls back to the message", () => {
    // `String({})` is "[object Object]", which is worse than the generic message it replaced.
    const error = Object.assign(new Error("Command failed"), {
      response: { command: "BAD" },
    });
    expect(mailServerSentence(error)).toBe("Command failed");
    expect(mailServerSentence(new Error("socket hang up"))).toBe(
      "socket hang up",
    );
    expect(mailServerSentence("plain string")).toBe("plain string");
  });
});

describe("the wall clock every network operation runs against", () => {
  test("ends a call that never finishes, and closes the socket on the way out", async () => {
    /*
     * The three timeouts imapflow is built with are INACTIVITY timeouts, so a server sending one
     * byte every twenty seconds resets all of them forever and the turn never ends. The cleanup is
     * the point rather than the rejection: without it the losing work keeps an authenticated
     * connection this deployment has stopped waiting for.
     */
    let closed = 0;
    const expired = withDeadline(
      () => new Promise<never>(() => {}),
      () => {
        closed += 1;
      },
      "reading the mailbox",
      5,
    );

    await expect(expired).rejects.toBeInstanceOf(MailboxError);
    // Its own class, because a send has to tell the clock running out from a server saying no.
    await expect(expired).rejects.toBeInstanceOf(DeadlineExpiredError);
    await expect(expired).rejects.toThrow("did not finish reading the mailbox");
    expect(closed).toBe(1);
  });

  test("leaves a call that finishes in time alone", async () => {
    let closed = 0;
    const answer = await withDeadline(
      async () => "done",
      () => {
        closed += 1;
      },
      "sending the message",
      50,
    );

    expect(answer).toBe("done");
    // Nothing to close, and the timer is cleared rather than left holding the process open.
    expect(closed).toBe(0);
  });
});

/**
 * The copy in Sent, which is the half SMTP does not do.
 *
 * SMTP delivers; it does not file. Without the append the account's Sent folder stays empty,
 * webmail shows nothing sent, and a person checking concludes the mail never went. That happened
 * here, to three messages that had all been delivered, which is why the bytes are built once and
 * used twice and why a failure to file is never reported as a failure to send.
 *
 * These cases reach the real client rather than the stub above, through the one seam that exists
 * for it: the property worth being sure about is that the bytes handed to SMTP and the bytes
 * appended to IMAP are the same bytes, and no stub one level up can see both.
 */
describe("filing a copy in Sent", () => {
  type Delivered = { envelope: unknown; raw: unknown };
  type Appended = { path: string; flags: unknown; raw: unknown; date: unknown };

  /**
   * The real clients, wired to a recording IMAP and a recording SMTP.
   *
   * `folders` is what the server would answer LIST with, and `appendFails` is the server that
   * refuses the append after the mail has already gone out.
   */
  function wired(
    options: {
      folders?: { path: string; name?: string; specialUse?: string }[];
      appendFails?: string;
      /** What the SMTP transport throws instead of delivering. */
      sendFails?: Error;
    } = {},
  ) {
    const delivered: Delivered[] = [];
    const appended: Appended[] = [];
    const listed = options.folders ?? [
      { path: "INBOX", name: "INBOX" },
      { path: "Sent", name: "Sent" },
    ];

    const clients = createMailboxClients(CONFIG, DEFAULT_ACCOUNT, PASSWORD, {
      imap: () =>
        ({
          connect: async () => {},
          logout: async () => {},
          close: () => {},
          list: async () => listed,
          append: async (
            path: string,
            raw: unknown,
            flags: unknown,
            date: unknown,
          ) => {
            if (options.appendFails) throw new Error(options.appendFails);
            appended.push({ path, raw, flags, date });
            return { destination: path } as never;
          },
        }) as unknown as ImapLike,
      smtp: () =>
        ({
          sendMail: async (mail: { envelope?: unknown; raw?: unknown }) => {
            if (options.sendFails) throw options.sendFails;
            delivered.push({ envelope: mail.envelope, raw: mail.raw });
            return {} as never;
          },
          close: () => {},
        }) as unknown as SmtpLike,
    });

    return { clients, delivered, appended };
  }

  const MAIL = {
    to: "dana@example.test",
    subject: "The Friday numbers",
    body: "Attached.",
  };

  test("delivers and files the very same bytes", async () => {
    /*
     * Composed twice would be two messages: different Message-ID, different Date, different
     * boundaries. A person reading Sent would be looking at a near-copy of what the recipient got,
     * and a Bot verifying its own send by Message-ID would find nothing.
     */
    const { clients, delivered, appended } = wired();
    const receipt = await clients.send(MAIL);

    expect(delivered).toHaveLength(1);
    expect(appended).toHaveLength(1);
    expect(Buffer.isBuffer(delivered[0]?.raw)).toBe(true);
    expect(appended[0]?.raw).toBe(delivered[0]?.raw);

    const raw = String(delivered[0]?.raw);
    expect(raw).toContain(`From: ${DEFAULT_ACCOUNT}`);
    expect(raw).toContain("To: dana@example.test");
    expect(raw).toContain("Subject: The Friday numbers");
    expect(raw).toContain("Attached.");
    // The id in the receipt is the id in the bytes, so it can be looked up in Sent afterwards.
    expect(receipt.messageId).not.toBeNull();
    expect(raw).toContain(String(receipt.messageId));

    // The envelope goes with it, so delivery uses the addresses the headers name.
    expect(delivered[0]?.envelope).toMatchObject({
      from: DEFAULT_ACCOUNT,
      to: ["dana@example.test"],
    });

    expect(appended[0]?.path).toBe("Sent");
    // Seen, because the account wrote this message rather than receiving it.
    expect(appended[0]?.flags).toEqual(["\\Seen"]);
    expect(appended[0]?.date).toBeInstanceOf(Date);
    expect(receipt.filedTo).toBe("Sent");
    expect(receipt.fileError).toBeNull();
  });

  test("finds Sent by its special-use flag, whatever it is called", async () => {
    // A French account's Sent folder is "Éléments envoyés", and no list of English names finds it.
    const { clients, appended } = wired({
      folders: [
        { path: "INBOX", name: "INBOX" },
        {
          path: "Éléments envoyés",
          name: "Éléments envoyés",
          specialUse: "\\Sent",
        },
      ],
    });
    const receipt = await clients.send(MAIL);

    expect(appended[0]?.path).toBe("Éléments envoyés");
    expect(receipt.filedTo).toBe("Éléments envoyés");
  });

  test("falls back to the name when the server marks nothing", async () => {
    const { clients, appended } = wired({
      folders: [
        { path: "INBOX", name: "INBOX" },
        { path: "Sent Items", name: "Sent Items" },
      ],
    });
    const receipt = await clients.send(MAIL);

    expect(appended[0]?.path).toBe("Sent Items");
    expect(receipt.filedTo).toBe("Sent Items");
  });

  test("an account with no Sent folder still sends, and says why there is no copy", async () => {
    const { clients, delivered, appended } = wired({
      folders: [{ path: "INBOX", name: "INBOX" }],
    });
    const receipt = await clients.send(MAIL);

    expect(delivered).toHaveLength(1);
    expect(appended).toEqual([]);
    expect(receipt.filedTo).toBeNull();
    expect(receipt.fileError).toBe("this account has no Sent folder");
  });

  test("an append that fails is not a send that failed", async () => {
    /*
     * The expensive mistake this prevents: reported as a failure, a Bot sends the message again,
     * and mail cannot be recalled. Delivery already happened by the time the append is attempted.
     */
    const { clients, delivered } = wired({
      appendFails: "Over quota",
    });
    const receipt = await clients.send(MAIL);

    expect(delivered).toHaveLength(1);
    expect(receipt.messageId).not.toBeNull();
    expect(receipt.filedTo).toBeNull();
    expect(receipt.fileError).toContain("Over quota");
  });

  test("picks the folder out of a LIST, on its own", () => {
    expect(
      sentFolderFrom([
        { path: "INBOX", name: "INBOX" },
        { path: "Archive", name: "Archive" },
        { path: "S", name: "S", specialUse: "\\Sent" },
      ]),
    ).toBe("S");
    expect(
      sentFolderFrom([
        { path: "INBOX", name: "INBOX" },
        { path: "INBOX.Sent Messages", name: "Sent Messages" },
      ]),
    ).toBe("INBOX.Sent Messages");
    // Null rather than a guess: appending to the wrong folder puts outgoing mail where a person
    // reads it as incoming.
    expect(sentFolderFrom([{ path: "INBOX", name: "INBOX" }])).toBeNull();
  });

  test("writes both threading headers into the bytes, once", async () => {
    const composed = await composeMessage(DEFAULT_ACCOUNT, {
      ...MAIL,
      reply: {
        messageId: "<first@example.test>",
        references: ["<older@example.test>", "<first@example.test>"],
      },
    });
    const raw = String(composed.raw);

    expect(raw).toContain("In-Reply-To: <first@example.test>");
    expect(raw).toContain("<older@example.test>");
    expect(raw).toContain(`Message-ID: ${composed.messageId}`);
  });
});

/**
 * What a send that did not complete is reported as, which depends on who stopped it.
 *
 * SMTP confirms a message with one reply after the data has gone. A refusal the server wrote is a
 * message that was not sent; a socket that timed out or dropped before the reply is a message that
 * may have been. The two must not read the same, because a Bot told "it failed" sends again.
 */
describe("a send that did not complete", () => {
  function transportThat(error: Error) {
    return createMailboxClients(CONFIG, DEFAULT_ACCOUNT, PASSWORD, {
      imap: () => {
        throw new Error(
          "IMAP must not be opened for a send that did not complete",
        );
      },
      smtp: () =>
        ({
          sendMail: async () => {
            throw error;
          },
          close: () => {},
        }) as unknown as SmtpLike,
    });
  }

  const MAIL = { to: "dana@example.test", subject: "s", body: "b" };

  test("a refusal the server wrote is a plain failure, in the server's words", async () => {
    // nodemailer's shape for a rejected RCPT TO: the reply on `response`, the class on `code`.
    const clients = transportThat(
      Object.assign(
        new Error("Can't send mail - all recipients were rejected"),
        {
          code: "EENVELOPE",
          command: "RCPT TO",
          response: "550 5.1.1 Relay access denied",
        },
      ),
    );
    const failed = clients.send(MAIL);

    await expect(failed).rejects.toBeInstanceOf(MailboxError);
    await expect(failed).rejects.not.toBeInstanceOf(UnconfirmedSendError);
    await expect(failed).rejects.toThrow("Relay access denied");
  });

  test("a socket that timed out is unconfirmed, and names the message id", async () => {
    // nodemailer's shape for its inactivity timeout, which it tags CONN whatever was in flight.
    const clients = transportThat(
      Object.assign(new Error("Timeout"), {
        code: "ETIMEDOUT",
        command: "CONN",
      }),
    );
    const failed = clients.send(MAIL);

    await expect(failed).rejects.toBeInstanceOf(UnconfirmedSendError);
    await expect(failed).rejects.toThrow("not known whether it was delivered");
    await expect(failed).rejects.toThrow("Do not send it again");
    // The id is the one in the bytes that went out, so it is the one a duplicate is found by.
    const error = await failed.catch((one: unknown) => one);
    expect(error).toBeInstanceOf(UnconfirmedSendError);
    const { messageId, message } = error as UnconfirmedSendError;
    expect(messageId).toMatch(/^<.+>$/);
    expect(message).toContain(messageId);
    expect(message).toContain("Timeout");
  });

  test("the deadline running out mid-send is unconfirmed too", async () => {
    const clients = createMailboxClients(CONFIG, DEFAULT_ACCOUNT, PASSWORD, {
      imap: () => {
        throw new Error(
          "IMAP must not be opened for a send that did not complete",
        );
      },
      smtp: () =>
        ({
          sendMail: async () => {
            throw new DeadlineExpiredError(
              "The mail server did not finish sending the message within 60 seconds.",
            );
          },
          close: () => {},
        }) as unknown as SmtpLike,
    });
    const failed = clients.send(MAIL);

    await expect(failed).rejects.toBeInstanceOf(UnconfirmedSendError);
    await expect(failed).rejects.toThrow("within 60 seconds");
  });

  test("tells the quiet cases from the refusals, on its own", () => {
    expect(deliveryUnconfirmed(new DeadlineExpiredError("late"))).toBe(true);
    for (const code of ["ETIMEDOUT", "ESOCKET", "ECONNECTION"]) {
      expect(
        deliveryUnconfirmed(Object.assign(new Error("gone"), { code })),
      ).toBe(true);
    }
    for (const code of [
      "EENVELOPE",
      "EMESSAGE",
      "EAUTH",
      "EPROTOCOL",
      "EDNS",
    ]) {
      expect(
        deliveryUnconfirmed(Object.assign(new Error("no"), { code })),
      ).toBe(false);
    }
    // Something that is not the transport's at all is a failure, not a maybe.
    expect(
      deliveryUnconfirmed(new MailboxError("Mailbox does not exist")),
    ).toBe(false);
    expect(deliveryUnconfirmed("plain string")).toBe(false);
    expect(deliveryUnconfirmed(null)).toBe(false);
  });
});

describe("what a model is told about the copy", () => {
  test("the confirmation names the folder, so a Bot can verify its own send", async () => {
    recordingMailbox({
      send: async () => ({
        messageId: "<sent@example.test>",
        filedTo: "Sent Items",
        fileError: null,
      }),
    });
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "s",
      body: "b",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("A copy is in folder Sent Items.");
  });

  test("a copy that could not be filed is a note on a successful send, not an error", async () => {
    // A model told the send failed sends it again. Mail cannot be recalled.
    recordingMailbox({
      send: async () => ({
        messageId: "<sent@example.test>",
        filedTo: null,
        fileError: "Over quota",
      }),
    });
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "s",
      body: "b",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Sent from");
    expect(result.text).toContain("no copy could be filed in the Sent folder");
    expect(result.text).toContain("Over quota");
    expect(result.text).toContain("do not send it again");
  });

  test("a mail server that quoted the password into the filing failure is scrubbed too", async () => {
    // The filing failure is a sentence a server wrote, on an authenticated connection, and it
    // reaches a model and an audit row like any other.
    recordingMailbox({
      send: async () => ({
        messageId: null,
        filedTo: null,
        fileError: `NO [AUTHENTICATIONFAILED] LOGIN ${PASSWORD}`,
      }),
    });
    const result = await callTool(CONNECTION, "send_message", {
      to: "dana@example.test",
      subject: "s",
      body: "b",
    });

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(PASSWORD);
    expect(result.text).toContain("[redacted]");
  });
});
