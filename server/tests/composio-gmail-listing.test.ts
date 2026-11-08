import { afterEach, describe, expect, test } from "bun:test";
import {
  type ComposioActions,
  type ComposioResult,
  callTool,
  useComposioClient,
} from "../src/plugins/composio";
import captured from "./fixtures/composio-gmail-messages.json";

/**
 * "Read my emails from the past 24 hours and tell me the top 2 which need my attention and why."
 *
 * FOUND IN USE. The Bot answered with two picks and said "the broader Gmail result was truncated, so
 * I can't guarantee they're the top two across every email in the past 24 hours". A model asks
 * GMAIL_FETCH_EMAILS for that with `max_results: 50, include_payload: true, verbose: true` (Claude
 * Sonnet 5.5's own arguments for the prompt, asked on 2026-11-07), every message then carries its
 * raw MIME tree, and OpenBot cut the answer at 20,000 characters: inside the first message's base64
 * HTML, before the page token, ending "[truncated]". The Bot could not read its inbox and could not
 * page to the rest.
 *
 * THE FAKE IS COMPOSIO'S OWN ANSWER. Each message is built from `fixtures/composio-gmail-messages.json`,
 * a live capture with every personal string replaced by a placeholder of the same length, so the
 * keys, nesting, MIME tree and sizes are what Composio sends. The fake pages the way Composio's
 * GMAIL_FETCH_EMAILS does (version 20261105_00): `max_results` defaults to 1 and stops at 500,
 * `page_token` is the opaque token from the last answer, `nextPageToken` is empty on the last page,
 * `include_payload` adds the raw MIME tree, and `verbose: false` sends metadata with an empty
 * `messageText` and no attachments.
 *
 * THE BOT IS PLAYED AS A MODEL READS: it is given the text, and it does only what the text says.
 */

afterEach(() => useComposioClient(null));

/** A busy inbox's day: about one message every ten minutes. */
const INBOX_SIZE = 140;

/** The cap a result may spend, written out; see `composio-transport.test.ts` for why. */
const RESULT_CAP = 20_000;

type Message = Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

/** Message `index` of the inbox, newest first, in the form `args` asks Composio for. */
function message(
  index: number,
  args: Record<string, unknown>,
  to?: string,
): Message {
  const verbose = args.verbose !== false;
  const withPayload = args.include_payload !== false;
  const template = clone(
    (verbose ? captured.full : captured.metadata) as Message,
  );
  const id = (0x1a00000000000000n + BigInt(index)).toString(16);
  const subject = `Placeholder subject ${index}`;
  const out: Message = {
    ...template,
    messageId: id,
    threadId: id,
    display_url: `https://mail.google.com/mail/u/0/#inbox/${id}`,
    sender: `Sender ${index} <sender${index}@example.com>`,
    subject,
    messageTimestamp: new Date(
      Date.UTC(2026, 10, 7, 23, 59) - index * 600_000,
    ).toISOString(),
    preview: { body: `Snippet of message ${index}`, subject },
    ...(to === undefined ? {} : { to }),
  };
  if (!withPayload) delete out.payload;
  return out;
}

/** Composio's GMAIL_FETCH_EMAILS over the inbox, recording the arguments each call carried. */
function inbox(to?: string) {
  const sent: Record<string, unknown>[] = [];
  const client: ComposioActions = {
    listActions: async () => [],
    execute: async (call, args): Promise<ComposioResult> => {
      sent.push(args);
      expect(call.slug).toBe("GMAIL_FETCH_EMAILS");
      const asked = typeof args.max_results === "number" ? args.max_results : 1;
      const size = Math.min(Math.max(asked, 1), 500);
      const start =
        typeof args.page_token === "string" && args.page_token !== ""
          ? Number(args.page_token.replace("token-", ""))
          : 0;
      const end = Math.min(start + size, INBOX_SIZE);
      const messages = [];
      for (let index = start; index < end; index++)
        messages.push(message(index, args, to));
      return {
        ...(clone(captured.envelope) as Omit<ComposioResult, "data">),
        data: {
          messages,
          nextPageToken: end < INBOX_SIZE ? `token-${end}` : "",
          resultSizeEstimate: INBOX_SIZE,
        },
      };
    },
  };
  return { client, sent };
}

/** The JSON a result carries, and the note after it when it was cut. */
function read(text: string): { data: Record<string, unknown>; note: string } {
  const at = text.lastIndexOf("\n\n[truncated");
  const json = at === -1 ? text : text.slice(0, at);
  const note = at === -1 ? "" : text.slice(at + 2);
  try {
    return { data: JSON.parse(json), note };
  } catch {
    throw new Error(
      `The Bot was handed JSON it cannot read (${text.length} characters, ending ${JSON.stringify(text.slice(-160))})`,
    );
  }
}

/**
 * The Bot asking for the day as Claude Sonnet 5.5 asks for it, then doing only what each answer
 * says: follow `nextPageToken`, or call again as a cut's note says. Which messages it never read
 * whole, and how many calls it took.
 */
async function readTheDay(): Promise<{
  missing: number[];
  calls: number;
  cuts: number;
}> {
  let args: Record<string, unknown> = {
    query: "newer_than:1d",
    max_results: 50,
    include_payload: true,
    verbose: true,
  };
  const seen = new Map<string, Message>();
  let calls = 0;
  let cuts = 0;
  while (calls < 40) {
    calls++;
    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { ...args, __version: "20261105_00" },
    );
    expect(result.isError).toBe(false);
    const { data, note } = read(result.text);
    expect(result.truncated).toBe(note !== "");
    for (const found of (data.messages ?? []) as Message[])
      seen.set(String(found.messageId), found);

    if (note !== "") {
      cuts++;
      // A cut that does not say how to get the rest leaves the Bot where the person found it.
      const resized = /max_results set to (\d+)/.exec(note);
      if (resized === null)
        throw new Error(`A cut the Bot cannot follow: ${note}`);
      // A cut list never offers the token past it, which would skip what was left out, and
      // neither does the listing's own note, which names it.
      expect(data.nextPageToken).toBeUndefined();
      expect(data.openbot_note).toBeUndefined();
      args = { ...args, max_results: Number(resized[1]) };
      continue;
    }
    expect(result.text.length).toBeLessThanOrEqual(RESULT_CAP);
    if (typeof data.nextPageToken === "string" && data.nextPageToken !== "")
      args = { ...args, page_token: data.nextPageToken };
    else break;
  }

  const missing: number[] = [];
  for (let index = 0; index < INBOX_SIZE; index++) {
    const expected = message(index, { verbose: false });
    const got = seen.get(String(expected.messageId));
    if (
      !got ||
      got.subject !== expected.subject ||
      got.sender !== expected.sender ||
      got.messageTimestamp !== expected.messageTimestamp ||
      (got.preview as { body?: unknown } | undefined)?.body !==
        `Snippet of message ${index}`
    )
      missing.push(index);
  }
  return { missing, calls, cuts };
}

describe("a day of a busy inbox, read the way a Bot reads it", () => {
  test("the Bot reads every message's key fields by following what it is told", async () => {
    useComposioClient(inbox().client);

    const { missing, calls, cuts } = await readTheDay();

    expect(missing).toEqual([]);
    expect(cuts).toBe(0);
    // Pages of twenty: the whole day in seven calls, not one per message.
    expect(calls).toBe(Math.ceil(INBOX_SIZE / 20));
  });

  test("a page that still runs over is cut between messages, and the Bot pages on from the note", async () => {
    // Long recipient lines, as a message to a large list has: twenty of them do not fit.
    const to = Array.from(
      { length: 40 },
      (_, n) => `Recipient ${n} <recipient${n}@example.com>`,
    ).join(", ");
    useComposioClient(inbox(to).client);

    const { missing, cuts } = await readTheDay();

    expect(cuts).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  test("a listing is asked for as a listing, whatever the model wrote", async () => {
    const { client, sent } = inbox();
    useComposioClient(client);

    await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      {
        query: "newer_than:1d",
        max_results: 50,
        include_payload: true,
        verbose: true,
        __version: "20261105_00",
      },
    );
    await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { query: "is:unread", __version: "20261105_00" },
    );

    // No raw MIME (most of a message's size, and what Composio refuses with a 413 past a few
    // megabytes), no bodies, and a page that arrives whole. Composio's own default page is one.
    expect(sent).toEqual([
      {
        query: "newer_than:1d",
        max_results: 20,
        include_payload: false,
        verbose: false,
      },
      {
        query: "is:unread",
        max_results: 20,
        include_payload: false,
        verbose: false,
      },
    ]);
  });

  test("the listing tells the Bot how to read a body and how to page", async () => {
    const { client } = inbox();
    useComposioClient(client);

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_EMAILS",
      { query: "newer_than:1d", __version: "20261105_00" },
    );

    const { data } = read(result.text);
    expect(result.truncated).toBe(false);
    expect(data.nextPageToken).toBe("token-20");
    expect(String(data.openbot_note)).toContain(
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    );
    // A page that is not the last says so in counts, and names the token to the next one.
    expect(String(data.openbot_note)).toContain(
      "This page holds 20 of about 140 that match, so it is not the whole answer",
    );
    expect(String(data.openbot_note)).toContain('page_token "token-20"');
    // The last page does not ask for another.
    const last = read(
      (
        await callTool(
          { url: "composio://gmail", actorId: "user_asker" },
          "GMAIL_FETCH_EMAILS",
          {
            query: "newer_than:1d",
            page_token: "token-120",
            __version: "20261105_00",
          },
        )
      ).text,
    ).data;
    expect(last.nextPageToken).toBe("");
    expect(String(last.openbot_note)).not.toContain("page_token");
    // The raw MIME tree and the repeated subject are gone; what a person triages by is not.
    const first = (data.messages as Message[])[0] as Message;
    expect(Object.keys(first).sort()).toEqual([
      "display_url",
      "labelIds",
      "messageId",
      "messageTimestamp",
      "preview",
      "sender",
      "subject",
      "threadId",
      "to",
    ]);
    expect(first.preview).toEqual({ body: "Snippet of message 0" });
  });
});

describe("one message read by its id", () => {
  test("keeps the decoded body and drops the raw MIME tree", async () => {
    useComposioClient({
      listActions: async () => [],
      execute: async (): Promise<ComposioResult> => ({
        ...(clone(captured.envelope) as Omit<ComposioResult, "data">),
        data: clone(captured.byId) as Record<string, unknown>,
      }),
    });

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      { message_id: "0000000000000000", __version: "20261105_00" },
    );

    // As Composio sends it, this message is 69,881 characters: cut at 20,000, most of what the Bot
    // got was base64. Its decoded body is what it needs, whole.
    expect(result.truncated).toBe(false);
    const data = JSON.parse(result.text) as Message;
    expect(data.payload).toBeUndefined();
    expect(data.messageText).toBe(captured.byId.messageText);
    expect(data.attachmentList).toEqual(captured.byId.attachmentList);
    // Who else it went to survives the MIME tree.
    expect(Object.keys(data.headers as object)).toEqual(["CC"]);
  });
});

describe("a thread read whole", () => {
  test("drops the raw MIME, and a thread too long to show names each message left out", async () => {
    // Eight replies, each the captured message with its own id. The thread's own keys are the ones
    // Composio's GMAIL_FETCH_MESSAGE_BY_THREAD_ID answered with on 2026-11-07.
    const ids = Array.from({ length: 8 }, (_, n) => `thread-message-${n}`);
    const reply = (id: string) => ({
      ...(clone(captured.byId) as Message),
      messageId: id,
      messageText: `Body of ${id}. ${captured.byId.messageText}`,
    });
    useComposioClient({
      listActions: async () => [],
      execute: async (call, args): Promise<ComposioResult> => ({
        ...(clone(captured.envelope) as Omit<ComposioResult, "data">),
        data:
          call.slug === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"
            ? {
                display_url: "https://mail.google.com/mail/u/0/#inbox/thread",
                historyId: "1",
                messages: ids.map(reply),
                threadId: "thread",
              }
            : reply(String(args.message_id)),
      }),
    });
    const ask = (slug: string, args: Record<string, unknown>) =>
      callTool({ url: "composio://gmail", actorId: "user_asker" }, slug, {
        ...args,
        __version: "20261105_00",
      });

    const thread = await ask("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", {
      thread_id: "thread",
    });
    const { data, note } = read(thread.text);
    const bodies = new Map<string, string>();
    for (const shown of data.messages as Message[]) {
      expect(shown.payload).toBeUndefined();
      bodies.set(String(shown.messageId), String(shown.messageText));
    }
    expect(thread.truncated).toBe(true);
    // The Bot reads the rest one by one, by the ids the note names.
    const named = /one call per messageId: (.+)\.\]$/.exec(note)?.[1];
    expect(named).toBeDefined();
    for (const id of String(named).split(", ")) {
      const one = await ask("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        message_id: id,
      });
      expect(one.truncated).toBe(false);
      const message = JSON.parse(one.text) as Message;
      bodies.set(String(message.messageId), String(message.messageText));
    }
    expect([...bodies.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(bodies.get(id)).toStartWith(`Body of ${id}. `);
  });
});

describe("any action's list over the cap", () => {
  test("is cut between its records, drops the token past them, and says how to read the rest", async () => {
    // An action OpenBot does not shape: its answer is read as it came, and only the cut changes.
    const threads = Array.from({ length: 60 }, (_, index) => ({
      id: `thread-${index}`,
      snippet: `${"y".repeat(900)} ${index}`,
    }));
    useComposioClient({
      listActions: async () => [],
      execute: async (): Promise<ComposioResult> => ({
        ...(clone(captured.envelope) as Omit<ComposioResult, "data">),
        data: {
          threads,
          nextPageToken: "past-all-sixty",
          resultSizeEstimate: 60,
        },
      }),
    });

    const result = await callTool(
      { url: "composio://gmail", actorId: "user_asker" },
      "GMAIL_LIST_THREADS",
      { query: "newer_than:1d", __version: "20261105_00" },
    );

    const { data, note } = read(result.text);
    const shown = (data.threads as unknown[]).length;
    expect(result.truncated).toBe(true);
    expect(shown).toBeGreaterThan(0);
    expect(data.threads).toEqual(threads.slice(0, shown));
    // Following it would skip every thread that was left out.
    expect(data.nextPageToken).toBeUndefined();
    expect(data.resultSizeEstimate).toBe(60);
    expect(note).toBe(
      `[truncated: GMAIL_LIST_THREADS answered with 60 threads. The first ${shown} are shown above, each whole, and the other ${60 - shown} were left out so this result fits. To read them, call GMAIL_LIST_THREADS again asking for at most ${shown} at a time, then page through the rest.]`,
    );
    expect(result.text.length - note.length - 2).toBeLessThanOrEqual(
      RESULT_CAP,
    );
  });
});
