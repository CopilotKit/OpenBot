import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { offersStandingRule } from "@openbot/shared/standing-rule";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { inArray } from "drizzle-orm";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import {
  type ApprovalCandidate,
  withApprovalContext,
} from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { type Edition, setEdition } from "../src/edition";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Consequential actions ask whatever the person's "Ask before making changes" says, in both
 * editions, and ordinary changes don't. Through the real gate, the real policy and the real approval
 * store, for somebody who has never chosen anything: the personal edition's default.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `consequential-${randomUUID()}`;
const people: string[] = [];
const store = createApprovalStore(database);
const service = createApprovalService(store);

async function person() {
  const id = `${prefix}-${people.length}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  people.push(id);
  return id;
}

/** A connector call, as `plugins/plugin-store/calls.ts` puts it to the gate. */
const tool = (
  server: string,
  name: string,
  args: Record<string, unknown>,
): Omit<ApprovalCandidate, "actorId"> => ({
  botId: `${prefix}-bot`,
  toolRef: `${server}/${name}`,
  effect: "write",
  scope: server,
  args,
  target: {
    serverId: server,
    toolName: name,
    url: `composio://${server}`,
    effect: "write",
  },
});

/** A browser click, as `computer/gateway.ts` puts it to the gate: the control and its page. */
const click = (
  pageUrl: string,
  role: string,
  name: string,
): Omit<ApprovalCandidate, "actorId"> => ({
  botId: `${prefix}-bot`,
  toolRef: "computer_click",
  effect: "write",
  scope: new URL(pageUrl).host,
  args: { ref: "e12" },
  target: { pageUrl, element: { ref: "e12", role, name }, snapshotId: 4 },
});

/** Runs the gate in a conversation of its own: undefined if it ran, the waiting request if it asked. */
async function gate(
  actorId: string,
  action: Omit<ApprovalCandidate, "actorId">,
) {
  const toolCallId = randomUUID();
  const outcome = await withApprovalContext(
    {
      runId: randomUUID(),
      threadId: `${prefix}-thread-${toolCallId}`,
      toolCallId,
      toolName: action.toolRef,
      args: action.args as Record<string, unknown>,
      messages: [{ id: "u1", role: "user", content: "Go ahead." }],
      state: {},
      context: [],
      forwardedProps: {},
    },
    () => service.gate({ ...action, actorId }),
  ).then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof HeadlessToolSuspension)) throw error;
      return error;
    },
  );
  if (!outcome) return undefined;
  const [request] = (await store.list(actorId)).filter(
    (row) => row.action.toolCallId === toolCallId,
  );
  if (!request) throw new Error("The gate suspended without a request.");
  return request;
}

const CONSEQUENTIAL = {
  money: {
    behaviour: "hand_off",
    cases: [
      tool("composio-stripe", "STRIPE_CREATE_TRANSFER", {
        amount: 5000,
        currency: "usd",
        destination: "acct_1",
      }),
      tool("composio-stripe", "STRIPE_CREATE_PAYOUT", {
        amount: 5000,
        currency: "usd",
      }),
      click(
        "https://secure.chase.com/web/auth/dashboard",
        "button",
        "Transfer",
      ),
      click("https://venmo.com/pay", "button", "Send $20"),
      // Paying an invoice or an order says so in the tool's name, and nowhere in its arguments.
      tool("composio-stripe", "STRIPE_PAY_INVOICE", { invoice: "in_1" }),
      tool("composio-square", "SQUARE_PAY_ORDER", {
        order_id: "ord_1",
        idempotency_key: "k1",
      }),
    ],
  },
  buying: {
    behaviour: "hand_off",
    cases: [
      click(
        "https://www.amazon.com/gp/buy/spc/handlers/display.html",
        "button",
        "Place your order",
      ),
      click("https://www.amazon.com/dp/B0EXAMPLE", "button", "Buy Now"),
      tool("composio-shopify", "SHOPIFY_CREATE_ORDER", {
        line_items: [{ variant_id: 1, quantity: 1 }],
      }),
    ],
  },
  deleting: {
    behaviour: "ask",
    cases: [
      tool("composio-googledrive", "GOOGLEDRIVE_DELETE_FILE", {
        file_id: "1abc",
      }),
      tool("composio-github", "GITHUB_DELETE_A_REPOSITORY", {
        owner: "me",
        repo: "notes",
      }),
      click("https://mail.google.com/mail/u/0/#inbox", "button", "Delete"),
      click(
        "https://drive.google.com/drive/my-drive",
        "menuitem",
        "Move to trash",
      ),
    ],
  },
  sending: {
    behaviour: "ask",
    cases: [
      click(
        "https://mail.google.com/mail/u/0/#inbox?compose=new",
        "button",
        "Send ‪(⌘Enter)‬",
      ),
      tool("composio-gmail", "GMAIL_SEND_EMAIL", {
        recipient_email: "sam@example.com",
        subject: "Friday",
        body: "Friday works.",
      }),
      // An event with attendees sends each of them an invitation.
      tool("composio-googlecalendar", "GOOGLECALENDAR_CREATE_EVENT", {
        summary: "Spec review",
        start_datetime: "2026-11-06T10:00",
        attendees: ["sam@example.com"],
      }),
      // The same invitation through Arcade's Google Calendar, Composio's Outlook and Arcade's
      // Teams, which name their attendees differently.
      tool("arcade-GoogleCalendar", "CreateEvent", {
        summary: "Spec review",
        start_datetime: "2026-11-06T10:00:00",
        end_datetime: "2026-11-06T10:30:00",
        attendee_emails: ["sam@example.com"],
      }),
      tool("composio-outlook", "OUTLOOK_CALENDAR_CREATE_EVENT", {
        subject: "Spec review",
        start_datetime: "2026-11-06T10:00:00",
        end_datetime: "2026-11-06T10:30:00",
        attendees_info: [{ email: "sam@example.com", type: "required" }],
      }),
      tool("arcade-MicrosoftTeams", "CreateMeeting", {
        subject: "Spec review",
        start_date_time: "2026-11-06T10:00:00",
        attendee_emails: ["sam@example.com"],
      }),
    ],
  },
  sharing: {
    behaviour: "ask",
    cases: [
      tool("composio-googledrive", "GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE", {
        file_id: "1abc",
        role: "writer",
        type: "user",
        email_address: "sam@example.com",
      }),
      click("https://drive.google.com/drive/my-drive", "button", "Share"),
    ],
  },
  publishing: {
    behaviour: "ask",
    cases: [
      click("https://x.com/compose/post", "button", "Post"),
      click("https://medium.com/new-story", "button", "Publish"),
      tool("composio-linkedin", "LINKEDIN_CREATE_LINKED_IN_POST", {
        commentary: "Hello",
      }),
    ],
  },
} as const;

const ORDINARY = {
  "drafting an email": tool("composio-gmail", "GMAIL_CREATE_EMAIL_DRAFT", {
    recipient_email: "sam@example.com",
    body: "Delete the old ones and send me the rest.",
  }),
  "editing a doc the person owns": tool(
    "composio-googledocs",
    "GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT",
    {
      document_id: "doc-1",
      text: "Buy milk. Transfer the files. Delete the old draft. Post it Friday.",
    },
  ),
  "creating a calendar event for themselves": tool(
    "composio-googlecalendar",
    "GOOGLECALENDAR_CREATE_EVENT",
    { summary: "Dentist", start_datetime: "2026-11-06T10:00" },
  ),
  "labelling an email": tool("composio-gmail", "GMAIL_ADD_LABEL_TO_EMAIL", {
    message_id: "18c",
    label_ids: ["Receipts"],
  }),
  "writing a note to a file on its computer": {
    botId: `${prefix}-bot`,
    toolRef: "computer_write_file",
    effect: "write",
    scope: "workspace",
    args: { path: "notes/today.md", contents: "Delete, send, post." },
  },
  "saving a doc in the browser": click(
    "https://docs.google.com/document/d/1/edit",
    "button",
    "Save",
  ),
  "opening the Sent folder": click(
    "https://mail.google.com/mail/u/0/#inbox",
    "link",
    "Sent",
  ),
  "opening a profile's Posts tab": click(
    "https://x.com/someone",
    "tab",
    "Posts",
  ),
  "opening Shared with me": click(
    "https://drive.google.com/drive/my-drive",
    "link",
    "Shared with me",
  ),
  "adding to a cart": click(
    "https://www.amazon.com/dp/B0EXAMPLE",
    "button",
    "Add to Cart",
  ),
} as const;

/** Named like money, and moving none: a repository changing owner, a wallet set up, a payroll date. */
const NOT_MONEY = [
  tool("composio-github", "GITHUB_TRANSFER_A_REPOSITORY", {
    owner: "me",
    repo: "notes",
    new_owner: "my-org",
  }),
  tool("composio-stripe", "STRIPE_CREATE_APPLE_PAY_DOMAIN", {
    domain_name: "shop.example.com",
  }),
  tool("composio-gusto", "GUSTO_UPDATE_PAY_SCHEDULE", {
    pay_schedule_id: "ps_1",
    frequency: "Every other week",
  }),
];

afterEach(() => setEdition("team"));
afterAll(async () => {
  if (people.length)
    await database
      .delete(approvalRequests)
      .where(inArray(approvalRequests.ownerUserId, people));
  await database.delete(users).where(inArray(users.id, people));
  await database.$client.close();
});

const EDITIONS: Edition[] = ["team", "personal"];

describe.each(EDITIONS)("the %s edition", (edition) => {
  let owner = "";
  beforeAll(async () => {
    owner = await person();
  });

  for (const [category, { behaviour, cases }] of Object.entries(
    CONSEQUENTIAL,
  )) {
    test(`${category} asks, whether by an app or a click, and offers no Always allow`, async () => {
      setEdition(edition);
      expect(await store.enabled(owner)).toBe(false);
      for (const action of cases) {
        const request = await gate(owner, action);
        expect({
          action: action.toolRef,
          target: action.target,
          policy: request?.action.policy,
        }).toMatchObject({ policy: { behaviour, source: "safety" } });
        expect(offersStandingRule(request?.action ?? {})).toBeFalse();
        await expect(
          service.decide(owner, request?.id ?? "", "allow_always"),
        ).rejects.toThrow();
      }
    });
  }

  test("Allow once lets the Bot delete, send, share or publish that one time", async () => {
    setEdition(edition);
    const request = await gate(owner, CONSEQUENTIAL.deleting.cases[0]);
    const decided = await service.decide(
      owner,
      request?.id ?? "",
      "allow_once",
    );
    expect(decided.status).toBe("approved");
  });

  for (const [name, action] of Object.entries(ORDINARY)) {
    test(`${name} runs without asking`, async () => {
      setEdition(edition);
      expect(await gate(owner, action)).toBeUndefined();
    });
  }

  // A hand-off means the Bot can't do it at all, so one that moves no money must not get one.
  test("a transfer or a 'pay' that moves no money is not handed to the person as a payment", async () => {
    setEdition(edition);
    for (const action of NOT_MONEY) {
      const request = await gate(owner, action);
      expect({
        action: action.toolRef,
        behaviour: request?.action.policy?.behaviour,
      }).not.toMatchObject({ behaviour: "hand_off" });
    }
  });
});

describe("the personal edition's default", () => {
  test("an ordinary change runs without asking for somebody who never chose", async () => {
    setEdition("personal");
    const fresh = await person();
    expect(await store.enabled(fresh)).toBe(false);
    expect(
      await gate(fresh, ORDINARY["editing a doc the person owns"]),
    ).toBeUndefined();
  });

  test("a saved 'Ask before making changes' wins: then an ordinary change asks", async () => {
    setEdition("personal");
    const chose = await person();
    await service.setPreferences(chose, { enabled: true });
    const request = await gate(
      chose,
      ORDINARY["editing a doc the person owns"],
    );
    expect(request?.action.policy).toMatchObject({
      behaviour: "ask",
      source: "default",
    });
  });
});
