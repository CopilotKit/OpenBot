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

/** Asks in `category` with `behaviour`, or runs without asking where `category` is null. */
type Expected = { category: string | null; behaviour?: "ask" | "hand_off" };

/** Each case through the real gate, with what came of it, so a failure names the case. */
async function outcomes(
  owner: string,
  cases: Record<
    string,
    readonly [Omit<ApprovalCandidate, "actorId">, Expected]
  >,
) {
  const seen: Record<string, Expected> = {};
  const wanted: Record<string, Expected> = {};
  for (const [name, [action, expected]] of Object.entries(cases)) {
    const request = await gate(owner, action);
    const policy = request?.action.policy;
    seen[name] = policy
      ? {
          category: CATEGORY_OF[policy.reason] ?? policy.reason,
          behaviour: policy.behaviour as "ask" | "hand_off",
        }
      : { category: null };
    wanted[name] = expected.category
      ? { category: expected.category, behaviour: expected.behaviour ?? "ask" }
      : { category: null };
  }
  return { seen, wanted };
}

const CATEGORY_OF: Record<string, string> = {
  "Paying, purchasing or moving money is always done by the person.": "money",
  "Deleting something always asks you first.": "deleting",
  "Sending something to other people always asks you first.": "sending",
  "Sharing something with other people always asks you first.": "sharing",
  "Posting or publishing something always asks you first.": "publishing",
};

const nothing: Expected = { category: null };

/**
 * Named with a word a category uses, and outside it. "POST" here is the web request's verb, and in
 * the others the verb is the action ("mark", "bookmark", "like"), with the word only its object.
 */
const OUTSIDE = {
  "updating a Stripe plan with an HTTP POST": [
    tool("composio-stripe", "STRIPE_POST_V1_PLANS_OVERVIEW", {
      plan: "plan_1",
      nickname: "Pro",
    }),
    nothing,
  ],
  "a Stripe POST to a setup intent": [
    tool("composio-stripe", "STRIPE_POST_SETUP_INTENTS_INTENT", {
      intent: "seti_1",
    }),
    nothing,
  ],
  "a Salesforce composite POST": [
    tool("composio-salesforce", "SALESFORCE_POST_COMPOSITE_SOBJECTS", {
      records: [{ Name: "Acme" }],
    }),
    nothing,
  ],
  "a Salesforce record created via POST": [
    tool("composio-salesforce", "SALESFORCE_CREATE_CAMPAIGN_RECORD_VIA_POST", {
      Name: "Spring",
    }),
    nothing,
  ],
  "marking a comment as spam": [
    tool("composio-shopify", "SHOPIFY_MARK_COMMENT_AS_SPAM", {
      comment_id: 1,
    }),
    nothing,
  ],
  "resolving a comment": [
    tool("arcade-Linear", "ResolveComment", { comment_id: "c1" }),
    nothing,
  ],
  "bookmarking a post": [
    tool("composio-twitter", "TWITTER_ADD_POST_TO_BOOKMARKS", {
      tweet_id: "1",
    }),
    nothing,
  ],
  "liking a post": [
    tool("composio-twitter", "TWITTER_USER_LIKE_POST", { tweet_id: "1" }),
    nothing,
  ],
  "liking a tweet": [tool("arcade-X", "LikeTweet", { tweet_id: "1" }), nothing],
  "a reaction to a comment": [
    tool("composio-linear", "LINEAR_CREATE_COMMENT_REACTION", {
      comment_id: "c1",
      emoji: "+1",
    }),
    nothing,
  ],
  "hiding replies": [
    tool("composio-twitter", "TWITTER_HIDE_REPLIES", { tweet_id: "1" }),
    nothing,
  ],
  "a draft of a post": [
    tool("composio-buffer", "BUFFER_CREATE_POST_DRAFT", { text: "Soon" }),
    nothing,
  ],
  "Gmail's send-as alias settings": [
    tool("composio-gmail", "GMAIL_UPDATE_SEND_AS", {
      send_as_email: "me@example.com",
    }),
    nothing,
  ],
  "cancelling a scheduled message": [
    tool("arcade-Slack", "CancelScheduledMessage", {
      scheduled_message_id: "Q1",
    }),
    nothing,
  ],
} as const;

/** Inside a category, and missed: each asks as its category does. */
const MISSED = {
  "a Slack message scheduled for later": [
    tool("composio-slack", "SLACK_SCHEDULE_MESSAGE", {
      channel: "C1",
      text: "Standup moved",
      post_at: 1793900000,
    }),
    { category: "sending" },
  ],
  "a scheduled message through Arcade": [
    tool("arcade-Slack", "CreateScheduledMessage", {
      channel_name: "general",
      message: "Standup moved",
      send_at: "2026-11-06T09:00:00",
    }),
    { category: "sending" },
  ],
  "a Mailchimp campaign scheduled": [
    tool("composio-mailchimp", "MAILCHIMP_SCHEDULE_CAMPAIGN", {
      campaign_id: "c1",
      schedule_time: "2026-11-06T09:00:00Z",
    }),
    { category: "sending" },
  ],
  "a Comment button": [
    click("https://github.com/acme/notes/issues/7", "button", "Comment"),
    { category: "sending" },
  ],
  "a Reply button": [
    click("https://x.com/someone/status/1", "button", "Reply"),
    { category: "sending" },
  ],
  "a payroll submitted": [
    tool("composio-deel", "DEEL_SUBMIT_ON_DEMAND_PAYROLL", {
      payroll_id: "p1",
    }),
    { category: "money", behaviour: "hand_off" },
  ],
  "a payroll run": [
    tool("composio-gusto", "GUSTO_SUBMIT_PAYROLL", {
      company_id: "co1",
      payroll_id: "p1",
    }),
    { category: "money", behaviour: "hand_off" },
  ],
  "an Upgrade button": [
    click("https://app.example.com/settings/workspace", "button", "Upgrade"),
    { category: "money", behaviour: "hand_off" },
  ],
  "a Subscribe button on a plans page": [
    click("https://www.nytimes.com/subscription", "button", "Subscribe"),
    { category: "money", behaviour: "hand_off" },
  ],
  "a Subscribe button with a price": [
    click(
      "https://news.example.com/article/1",
      "button",
      "Subscribe for $4/month",
    ),
    { category: "money", behaviour: "hand_off" },
  ],
  "a paid plan changed by an app": [
    tool("composio-shopify", "SHOPIFY_CREATE_APP_SUBSCRIPTION", {
      name: "Pro",
      price: 29,
    }),
    { category: "money", behaviour: "hand_off" },
  ],
} as const;

/** Free, so outside buying: a hand-off would leave the Bot unable to do it at all. */
const FREE = {
  "subscribing to a YouTube channel": [
    click("https://www.youtube.com/@someone", "button", "Subscribe"),
    nothing,
  ],
  "a payroll migration file submitted": [
    tool("composio-deel", "DEEL_SUBMIT_PAYROLL_MIGRATION_IMPORT", {
      file_id: "f1",
    }),
    nothing,
  ],
} as const;

/** Remove is deleting, unless it takes somebody's access away, which is sharing. */
const REMOVING = {
  "removing an attachment": [
    tool("arcade-Linear", "RemoveAttachment", { attachment_id: "a1" }),
    { category: "deleting" },
  ],
  "removing a member from a project": [
    tool("composio-asana", "ASANA_REMOVE_MEMBERS_FOR_PROJECT", {
      project_gid: "p1",
      members: "u1",
    }),
    { category: "deleting" },
  ],
  "removing a collaborator": [
    tool("composio-github", "GITHUB_REMOVE_A_REPOSITORY_COLLABORATOR", {
      owner: "me",
      repo: "notes",
      username: "sam",
    }),
    { category: "sharing" },
  ],
  "a Remove button": [
    click(
      "https://mail.google.com/mail/u/0/#settings/filters",
      "button",
      "Remove",
    ),
    { category: "deleting" },
  ],
  "a Yes, remove button": [
    click("https://app.example.com/team", "button", "Yes, remove"),
    { category: "deleting" },
  ],
  "a Remove permanently button": [
    click("https://app.example.com/files", "button", "Remove permanently"),
    { category: "deleting" },
  ],
  "a Remove filter button": [
    click("https://shop.example.com/search?q=lamp", "button", "Remove filter"),
    nothing,
  ],
} as const;

describe.each(EDITIONS)("named words in the %s edition", (edition) => {
  let owner = "";
  beforeAll(async () => {
    owner = await person();
  });

  test("a word a category uses, outside the category, doesn't ask", async () => {
    setEdition(edition);
    const { seen, wanted } = await outcomes(owner, OUTSIDE);
    expect(seen).toEqual(wanted);
  });

  test("a scheduled send, a Comment or Reply button, a payroll run and a paid plan ask as their category", async () => {
    setEdition(edition);
    const { seen, wanted } = await outcomes(owner, MISSED);
    expect(seen).toEqual(wanted);
  });

  test("a free subscription and a payroll file are not handed off", async () => {
    setEdition(edition);
    const { seen, wanted } = await outcomes(owner, FREE);
    expect(seen).toEqual(wanted);
  });

  test("removing asks as deleting, or as sharing when it takes access away", async () => {
    setEdition(edition);
    const { seen, wanted } = await outcomes(owner, REMOVING);
    expect(seen).toEqual(wanted);
  });
});
